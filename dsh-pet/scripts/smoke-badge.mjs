// 冒烟脚本：模拟跑通「POST /badge → host 写 state → 客户端 readBadge 收窄」整条链路。
// 不依赖 DSH / 油猴 / React / node --test（绕开沙箱 spawn 限制），直接用源码 apply() 打真实路由。
// 用法：node --experimental-strip-types --import ./scripts/test-register.mjs scripts/smoke-badge.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Writable } from 'node:stream';
import { apply } from '../src/host/index.ts';
import { readBadge } from '../src/shared/state.ts';

const dir = mkdtempSync(join(tmpdir(), 'dsh-pet-badge-'));
process.env.DSH_HOME = join(dir, 'home');
process.env.DSH_PET_ELECTRON_PATH = process.execPath;

const disposers = [];
class FakeRes extends Writable {
  constructor() {
    super();
    this.status = 0;
    this.chunks = [];
  }
  writeHead(status) {
    this.status = status;
    return this;
  }
  _write(chunk, _enc, cb) {
    this.chunks.push(Buffer.from(chunk));
    cb();
  }
}

let handler;
const noop = () => {};
apply({
  effect: (fn) => {
    try {
      const d = fn();
      if (typeof d === 'function') disposers.push(d);
      return d;
    } catch {
      /* 源码形态下内置配置不可达，吞掉 */
    }
  },
  on: () => noop,
  webServer: { register: (spec) => ((handler = spec.handler), noop) },
  commands: { register: () => noop },
  logger: { warn: noop, info: noop, debug: noop, error: noop },
  agentDefaultModel: { currentSelection: () => ({ provider: 'no-such-provider', model: 'x' }) },
  credentials: { resolve: async () => undefined },
  llm: { listProviders: () => [], listModels: async () => [] },
});
assert.ok(handler, 'apply() 应注册 handler');

const call = (url, method = 'GET', body) =>
  new Promise((done) => {
    const res = new FakeRes();
    res.on('finish', () => done({ status: res.status, body: Buffer.concat(res.chunks).toString('utf8') }));
    void handler(
      {
        method,
        url,
        on: (event, cb) => {
          if (event === 'data' && body !== undefined) queueMicrotask(() => cb(Buffer.from(body, 'utf8')));
          if (event === 'end') queueMicrotask(() => cb());
          return undefined;
        },
      },
      res,
    );
  });

const ok = [];
const check = (name, cond) => {
  assert.ok(cond, name);
  ok.push('✅ ' + name);
};

// 1) 正常投喂
let r = await call('/dsh-pet-7340/badge', 'POST', JSON.stringify({ count: 4, label: '待处理', ts: 1710000000000 }));
check('POST /badge 返回 {ok:true}', r.status === 200 && JSON.parse(r.body).ok === true);

// 2) /state 读到 badge 叶子
r = await call('/dsh-pet-7340/state');
const leaf = JSON.parse(r.body).sections.badge;
check('sections.badge 存在且 counter>0', leaf && typeof leaf.counter === 'number' && leaf.counter > 0);
check('badge.data = {count:4,label:"待处理",ts:…}', leaf.data && leaf.data.count === 4 && leaf.data.label === '待处理' && leaf.data.ts === 1710000000000);

// 3) 客户端收窄
const narrowed = readBadge(leaf);
check('readBadge 收窄为 {count:4,label:"待处理",ts:…}', narrowed && narrowed.count === 4 && narrowed.label === '待处理' && narrowed.ts === 1710000000000);

// 4) count=0 → 数据合法但徽标隐藏（组件据 count<=0 不渲染）
r = await call('/dsh-pet-7340/badge', 'POST', JSON.stringify({ count: 0 }));
check('POST count=0 返回 {ok:true}', r.status === 200 && JSON.parse(r.body).ok === true);
r = await call('/dsh-pet-7340/state');
const zero = readBadge(JSON.parse(r.body).sections.badge);
check('count=0 → readBadge={count:0}（渲染层据此隐藏）', zero && zero.count === 0 && zero.label === undefined);

// 5) 非法值一律 400
r = await call('/dsh-pet-7340/badge', 'POST', JSON.stringify({ count: -1 }));
check('count 负数 → 400', r.status === 400);
r = await call('/dsh-pet-7340/badge', 'POST', JSON.stringify({ count: 2.5 }));
check('count 小数 → 400', r.status === 400);
r = await call('/dsh-pet-7340/badge', 'POST', 'not-json');
check('非法 JSON body → 400', r.status === 400);
r = await call('/dsh-pet-7340/badge', 'GET');
check('GET /badge → 405（只读，仅 POST）', r.status === 405);

// 6) label 缺省 / 超长截断
r = await call('/dsh-pet-7340/badge', 'POST', JSON.stringify({ count: 7 }));
r = await call('/dsh-pet-7340/state');
check('无 label → 不带 label 键', readBadge(JSON.parse(r.body).sections.badge)?.label === undefined);
r = await call('/dsh-pet-7340/badge', 'POST', JSON.stringify({ count: 1, label: 'x'.repeat(100) }));
r = await call('/dsh-pet-7340/state');
check('label 超长 → 截断到 32 字符', readBadge(JSON.parse(r.body).sections.badge)?.label?.length === 32);

// 7) 富信息：href / tone / items
r = await call(
  '/dsh-pet-7340/badge',
  'POST',
  JSON.stringify({
    count: 3,
    href: 'https://desk.zoho.com/support/technical-support/tickets',
    tone: 'orange',
    items: ['主题A', '主题B'],
  }),
);
r = await call('/dsh-pet-7340/state');
const rich = readBadge(JSON.parse(r.body).sections.badge);
check(
  'href/tone/items 正常写入',
  rich.href === 'https://desk.zoho.com/support/technical-support/tickets' && rich.tone === 'orange' && rich.items?.length === 2,
);

r = await call(
  '/dsh-pet-7340/badge',
  'POST',
  JSON.stringify({ count: 1, href: 'javascript:alert(1)', tone: 'purple', items: [123, 'ok'] }),
);
r = await call('/dsh-pet-7340/state');
const sanitized = readBadge(JSON.parse(r.body).sections.badge);
check('非法 href（非 http）→ 丢弃', sanitized.href === undefined);
check('非法 tone → 丢弃', sanitized.tone === undefined);
check('items 非字符串 → 过滤', sanitized.items?.length === 1 && sanitized.items[0] === 'ok');

// 收尾：释放 effect + 清理临时目录
for (const d of disposers.splice(0)) {
  try {
    d();
  } catch {
    /* 释放失败不影响 */
  }
}
rmSync(dir, { recursive: true, force: true });

console.log(ok.join('\n'));
console.log('\n🎉 全部通过：POST /badge → state → readBadge → 徽标数据链路已跑通（含 0 值隐藏与非法值拒绝）');
process.exit(0);
