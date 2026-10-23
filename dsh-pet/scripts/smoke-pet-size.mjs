// 冒烟脚本：POST /pet-size 单项写盘路由 —— 校验 / 落盘 / 聚合回读 / 恢复。
// 不依赖 DSH / 油猴 / React / node --test（绕开沙箱 spawn 限制），直接用构建产物 lib/index.js 打真实路由。
// 用法：node scripts/smoke-pet-size.mjs
// （DSH_HOME 指到临时目录：不碰真实用户配置；DSH_PET_ELECTRON_PATH=本进程 node —— syncDesktop
//   拉起的「helper」require('electron') 即败、进程秒退，无副作用，见 main.js 文件头。）
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Writable } from 'node:stream';
import { apply } from '../lib/index.js';

const dir = mkdtempSync(join(tmpdir(), 'dsh-pet-size-'));
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
  // 上游宿主半侧会 ctx.provide('petApi7340', …) 导出余额 provider 注册服务；
  // 冒烟环境没有 Cordis 运行时，吞掉即可（路由行为不受影响）。
  provide: noop,
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
const json = (r) => JSON.parse(r.body);

// 1) 方法守卫：GET → 405
check('GET /pet-size → 405', (await call('/dsh-pet-7340/pet-size')).status === 405);

// 2) 坏 JSON → 400
check('坏 JSON → 400', (await call('/dsh-pet-7340/pet-size', 'POST', '{oops')).status === 400);

// 3) 缺 id → 业务失败 pet-required（HTTP 200 + ok:false，与 pet-display 同口径）
{
  const r = await call('/dsh-pet-7340/pet-size', 'POST', JSON.stringify({ size: 300 }));
  check('缺 id → 200 + pet-required', r.status === 200 && json(r).ok === false && json(r).reason === 'pet-required');
}

// 4) size 越界（<40 / >1200 / 非数字）→ bad-size
{
  const small = await call('/dsh-pet-7340/pet-size', 'POST', JSON.stringify({ id: 'main', size: 30 }));
  const big = await call('/dsh-pet-7340/pet-size', 'POST', JSON.stringify({ id: 'main', size: 9999 }));
  const nan = await call('/dsh-pet-7340/pet-size', 'POST', JSON.stringify({ id: 'main', size: 'abc' }));
  check(
    'size 越界 → bad-size ×3',
    [small, big, nan].every((r) => r.status === 200 && json(r).reason === 'bad-size'),
  );
}

// 5) 未知宠物 → unknown-pet
{
  const r = await call('/dsh-pet-7340/pet-size', 'POST', JSON.stringify({ id: 'no-such-pet', size: 300 }));
  check('未知宠物 → unknown-pet', r.status === 200 && json(r).reason === 'unknown-pet');
}

// 6) 正常保存：main → 333 —— 响应体 = 成品聚合，main.pets 里 size=333
{
  const r = await call('/dsh-pet-7340/pet-size', 'POST', JSON.stringify({ id: 'main', size: 333.4 }));
  const agg = json(r);
  const pet = agg?.main?.pets?.find((p) => p.id === 'main');
  check('保存 → 200 + 聚合 main.size=333（四舍五入）', r.status === 200 && pet?.size === 333);
}

// 7) 落盘验证：临时 DSH_HOME 的用户层 main-config.jsonc 写进了 333
{
  const file = join(dir, 'home', 'dsh-pet', 'main-config.jsonc');
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  check('用户层配置落盘 size=333（且只含白名单字段）', saved.pets?.[0]?.size === 333 && saved.pets.length === 1);
}

// 8) GET /config 回读：合并后的 main 宠物 size=333（下次启动自动加载的口径）
{
  const r = await call('/dsh-pet-7340/config');
  const pet = json(r)?.main?.pets?.find((p) => p.id === 'main');
  check('GET /config 回读 size=333', r.status === 200 && pet?.size === 333);
}

// 9) 二次保存（恢复默认 462）：幂等覆盖，不叠加
{
  const r = await call('/dsh-pet-7340/pet-size', 'POST', JSON.stringify({ id: 'main', size: 462 }));
  const pet = json(r)?.main?.pets?.find((p) => p.id === 'main');
  check('二次保存 size=462 覆盖旧值', r.status === 200 && pet?.size === 462);
}

// 10) 固定端口本地桥（127.0.0.1:7340 起顺延）：apply() 已真实监听 —— 等它就绪后打真 HTTP。
//     桥 = 窄门：GET /state 与 POST /badge 通（语义与 DSH 路由同一份实现），其余一律 404。
//     **实例标记隔离**：桥端口是机器全局的——真 DSH 可能正占着 7340（本脚本自己的实例会顺延到
//     7341+）。绝不能「扫到 200 就当是自己的」：那会把测试徽标写进用户正在跑的真宠物。
//     先经 handler 往**本实例**投一个随机标记，再扫描 5 个桥端口找「state 里带着这个标记」的那个
//     ——只认自己的桥；真 DSH 的桥标着别的 label，天然被跳过。
{
  const BRIDGE_PORTS = [7340, 7341, 7342, 7343, 7344];
  const marker = 'smoke-' + Math.random().toString(36).slice(2, 8);
  await call('/dsh-pet-7340/badge', 'POST', JSON.stringify({ count: 1, label: marker }));
  const badgeLabelOf = async (port) => {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/dsh-pet-7340/state`, { signal: AbortSignal.timeout(500) });
      if (r.status !== 200) return null;
      const j = await r.json();
      const label = j?.sections?.badge?.data?.label;
      return typeof label === 'string' ? label : null;
    } catch {
      return null;
    }
  };
  let base = null;
  for (let round = 0; round < 20 && !base; round++) {
    for (const port of BRIDGE_PORTS) {
      if ((await badgeLabelOf(port)) === marker) {
        base = `http://127.0.0.1:${port}`;
        break;
      }
    }
    if (!base) await new Promise((done) => setTimeout(done, 150));
  }
  check('本地桥已监听（' + (base ?? '未找到') + '，实例标记命中）', base !== null);
  if (base) {
    // 桥 POST /badge → 换新标记再投一次，经桥读回验证（同实例同状态库 = handler 与桥共享 S）
    const marker2 = 'smoke2-' + Math.random().toString(36).slice(2, 8);
    const r = await fetch(base + '/dsh-pet-7340/badge', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ count: 2, label: marker2 }),
    });
    const j = await r.json();
    check('桥 POST /badge → ok', r.status === 200 && j.ok === true);
    check('桥写入与 handler 同一状态库（读回 label 一致）', (await badgeLabelOf(base.split(':').pop())) === marker2);
    // 窄门：pet-size 不在桥上（不能经桥改配置）
    const narrow = await fetch(base + '/dsh-pet-7340/pet-size', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'main', size: 300 }),
    });
    check('桥上 /pet-size → 404（窄门：只开 state/badge/broadcast）', narrow.status === 404);
    // 窄门：GET /badge 也不开（只认 POST）
    const method = await fetch(base + '/dsh-pet-7340/badge');
    check('桥上 GET /badge → 404（方法白名单）', method.status === 404);
    // 第三扇门：POST /broadcast（事件提醒流适配器的写端点）——投一句话，经桥读回 pets.main.say
    const sayText = 'smoke-' + Math.random().toString(36).slice(2, 8) + ' 有一封新客诉';
    const bc = await fetch(base + '/dsh-pet-7340/broadcast?pet=main&surface=any', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: sayText, duration: 0, anim: false }),
    });
    const bcj = await bc.json();
    check('桥 POST /broadcast → ok', bc.status === 200 && bcj.ok === true);
    const sayOf = async (port) => {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/dsh-pet-7340/state`, { signal: AbortSignal.timeout(500) });
        if (r.status !== 200) return null;
        const j = await r.json();
        const say = j?.pets?.main?.say; // 叶子形状 {counter, data}（与 sections.badge 同一包装）
        return typeof say?.data?.text === 'string' ? say.data.text : null;
      } catch {
        return null;
      }
    };
    check('桥 broadcast 写入同一状态库（读回 say.text 一致）', (await sayOf(base.split(':').pop())) === sayText);
    // 窄门口径不变：broadcast 只认 POST
    const bmethod = await fetch(base + '/dsh-pet-7340/broadcast');
    check('桥上 GET /broadcast → 404（方法白名单）', bmethod.status === 404);
  }
}

for (const d of disposers) {
  try {
    d();
  } catch {}
}
rmSync(dir, { recursive: true, force: true });
console.log(ok.join('\n'));
console.log(`\n${ok.length} 项全部通过 —— /pet-size 冒烟 OK`);
process.exit(0);
