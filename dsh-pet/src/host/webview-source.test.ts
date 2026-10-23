// builtin-webview 源适配器循环（ADR-002 阶段三）单测。
// 被测：startWebviewSource 的 tick 决策矩阵——探活结果如何映射到「桥环回投喂 /
// expired 自报 + 开登录窗 / 静默退避」。纯逻辑路径，fetch/IPC 全部 mock。
import test from 'node:test';
import assert from 'node:assert/strict';
import { startWebviewSource, type WebviewSourceDeps, type WebviewSourceHandle } from './webview-source';
import type { SourceDecl } from './sources';

/** mock 依赖：记录全部桥 POST / expired 标记 / 登录窗请求，探活结果可编程 */
interface Harness {
  deps: WebviewSourceDeps;
  posts: { url: string; body: string }[];
  expired: Map<string, string>;
  loginOpens: string[];
  probeResults: Map<string, { ok: boolean; authed?: boolean }>;
  warnings: string[];
  handle: WebviewSourceHandle;
}

const DECL: SourceDecl = { type: 'builtin-webview', id: 'w', feed: 'badge', intervalMs: 50, url: 'https://x.test/' };

function makeHarness(decl: SourceDecl = DECL, preProbe?: { ok: boolean; authed?: boolean }): Harness {
  const posts: { url: string; body: string }[] = [];
  const expired = new Map<string, string>();
  const loginOpens: string[] = [];
  const warnings: string[] = [];
  const probeResults = new Map<string, { ok: boolean; authed?: boolean }>();
  if (preProbe) probeResults.set(decl.id, preProbe); // 首拍同步微任务就要读：必须先于 startWebviewSource
  const deps: WebviewSourceDeps = {
    bridgeOrigin: 'http://127.0.0.1:9999',
    sendToHelper: async (channel, payload) => {
      if (channel === 'source:login-open') {
        loginOpens.push(String((payload as { id?: string }).id));
        return { ok: true };
      }
      return probeResults.get(String((payload as { id?: string }).id)) ?? undefined;
    },
    markSourceExpired: (id, reason) => {
      expired.set(id, reason);
    },
    logger: {
      warn: (...a: unknown[]) => warnings.push(a.map(String).join(' ')),
      info: () => {},
      error: () => {},
    },
  };
  // fetch mock 的记录口（__wv 全局）：必须在 startWebviewSource **之前**挂好——
  // 首拍 tick 在构造返回前就跑（微任务链），挂晚了首拍的环回会记到上一个 harness。
  const harness: Harness = {
    deps,
    posts,
    expired,
    loginOpens,
    probeResults,
    warnings,
    handle: undefined as unknown as WebviewSourceHandle,
  };
  (globalThis as { __wv?: Harness }).__wv = harness;
  harness.handle = startWebviewSource(decl, deps);
  return harness;
}

/** 等一拍（tick 是 async：50ms 间隔 + fetch mock 的微任务链） */
const waitTick = (ms = 120): Promise<void> => new Promise((r) => setTimeout(r, ms));

// fetch 全局 mock（桥环回的唯一出口）：收进 posts，回 ok:true
const realFetch = globalThis.fetch;
test.before(() => {
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const h = (globalThis as { __wv?: Harness }).__wv;
    h?.posts.push({ url: String(url), body: String(init?.body ?? '') });
    return new Response('{"ok":true}', { status: 200 });
  }) as typeof fetch;
});
test.after(() => {
  globalThis.fetch = realFetch;
});

test('cookie 活 → 桥环回投喂（POST /badge 带 source=id 与哨兵数字）', async () => {
  const h = makeHarness();
  (globalThis as { __wv?: Harness }).__wv = h;
  h.probeResults.set('w', { ok: true, authed: true });
  await waitTick();
  h.handle.stop();
  assert.ok(h.posts.length >= 1, '至少一拍环回');
  const last = h.posts[h.posts.length - 1];
  assert.ok(last.url.includes('/dsh-pet-7340/badge'), '打到桥的 badge 门');
  const body = JSON.parse(last.body) as { source?: string; count?: number; label?: string };
  assert.equal(body.source, 'w', '带 source=id（心跳注册表据此刷 alive）');
  assert.equal(typeof body.count, 'number');
});

test('cookie 失效 → 自报 expired + 开登录窗，不再环回（authed:false 路径）', async () => {
  const h = makeHarness();
  (globalThis as { __wv?: Harness }).__wv = h;
  h.probeResults.set('w', { ok: true, authed: false });
  await waitTick();
  h.handle.stop();
  assert.equal(h.expired.get('w'), '登录失效（cookie 过期或被登出）');
  assert.deepEqual(h.loginOpens, ['w'], '恰好一次登录窗请求');
  assert.equal(h.posts.length, 0, '失效后不投喂');
  // 再等一拍：expired 已置 → 不再探/不再开窗（等装配层 restart）
  await waitTick();
  assert.equal(h.loginOpens.length, 1);
});

test('探活失败（Helper 不在 / 通道未就绪）→ 静默退避：不 expired、不开窗、不投喂', async () => {
  const h = makeHarness();
  (globalThis as { __wv?: Harness }).__wv = h;
  // probeResults 不设 → sendToHelper 返回 undefined → probe.ok=false
  await waitTick();
  await waitTick();
  h.handle.stop();
  assert.equal(h.expired.size, 0, '环境事实不当故障报');
  assert.equal(h.loginOpens.length, 0);
  assert.equal(h.posts.length, 0);
  assert.equal(h.warnings.length, 0);
});

test('探活 5xx/不确定（authed 缺省）→ 不误判失效（退避这一拍，不 expired）', async () => {
  const h = makeHarness();
  (globalThis as { __wv?: Harness }).__wv = h;
  h.probeResults.set('w', { ok: true }); // authed: undefined
  await waitTick();
  h.handle.stop();
  assert.equal(h.expired.size, 0);
  assert.equal(h.loginOpens.length, 0);
  assert.equal(h.posts.length, 0);
});

test('markExpired 手动路径（装配层可直接标记，如 Helper 报告登录被登出）', async () => {
  const h = makeHarness();
  (globalThis as { __wv?: Harness }).__wv = h;
  h.probeResults.set('w', { ok: true, authed: true });
  await waitTick();
  h.handle.markExpired('登录被登出');
  h.handle.stop();
  assert.equal(h.expired.get('w'), '登录被登出');
});

test('stop() 后彻底停：不再探不再投（dispose 语义）', async () => {
  const h = makeHarness();
  (globalThis as { __wv?: Harness }).__wv = h;
  h.probeResults.set('w', { ok: true, authed: true });
  await waitTick(60);
  const postsAtStop = h.posts.length;
  h.handle.stop();
  await waitTick(200);
  assert.equal(h.posts.length, postsAtStop, 'stop 后零新增');
});

test('intervalMs 缺省 60s：decl 不带 intervalMs 时不在短窗内二拍（间隔生效）', async () => {
  // preProbe 必须在 makeHarness 里预置：首拍 tick 在构造同步段就发（微任务），
  // 测试体里的 probeResults.set 来不及（实测踩过：posts=0 的真因不是间隔，是首拍探不到）。
  const h = makeHarness(
    { type: 'builtin-webview', id: 'w2', feed: 'badge', url: 'https://y.test/' },
    { ok: true, authed: true },
  );
  await waitTick(150); // 60s 间隔 → 只该有首拍（tick 立即跑一次）
  h.handle.stop();
  assert.equal(h.posts.length, 1, '首拍立即，第二拍在 60s 后（测试窗口内不可见）');
});
