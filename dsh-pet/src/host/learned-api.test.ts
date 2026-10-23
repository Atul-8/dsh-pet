// 学习文件存储（learned-api.ts，ADR-002 v1.1 API 学习）单测。
// 被测：读/写/校验/挖数四个纯函数 + 同源判定——全部无 Electron 依赖。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  extractCount,
  isValidCountPath,
  learnedApiPath,
  parseLearnedApi,
  readLearnedApi,
  sameOrigin,
  writeLearnedApi,
} from './learned-api';

let root = '';
test.before(() => {
  root = mkdtempSync(join(tmpdir(), 'dsh-pet-learn-'));
});
test.after(() => {
  rmSync(root, { recursive: true, force: true });
});

// ---------- parseLearnedApi：形状校验矩阵 ----------

test('parseLearnedApi 合法形状 → 解析成功', () => {
  const api = parseLearnedApi(
    JSON.stringify({
      version: 1,
      method: 'GET',
      url: 'https://x.test/api/todos',
      countPath: 'data.pending.count',
      learnedAt: 1750000000000,
    }),
  );
  assert.ok(api);
  assert.equal(api.method, 'GET');
  assert.equal(api.countPath, 'data.pending.count');
});

test('parseLearnedApi 非法 JSON → undefined', () => {
  assert.equal(parseLearnedApi('{bad'), undefined);
});

test('parseLearnedApi 字段矩阵（version/method/url/countPath/learnedAt 各自非法）', () => {
  const ok = { version: 1, method: 'POST', url: 'https://x.test/a', countPath: 'a.b', learnedAt: 1 };
  assert.equal(parseLearnedApi(JSON.stringify({ ...ok, version: 2 })), undefined, '未来版本不瞎解析');
  assert.equal(parseLearnedApi(JSON.stringify({ ...ok, method: 'DELETE' })), undefined, '只认 GET/POST');
  assert.equal(parseLearnedApi(JSON.stringify({ ...ok, method: 'get' })), undefined, '大写口径：小写 get 不认');
  assert.equal(parseLearnedApi(JSON.stringify({ ...ok, url: 'ftp://x.test/a' })), undefined, '只认 http(s)');
  assert.equal(parseLearnedApi(JSON.stringify({ ...ok, url: 'not-a-url' })), undefined);
  assert.equal(parseLearnedApi(JSON.stringify({ ...ok, countPath: '' })), undefined, '空路径');
  assert.equal(parseLearnedApi(JSON.stringify({ ...ok, countPath: 'a..b' })), undefined, '连续点');
  assert.equal(parseLearnedApi(JSON.stringify({ ...ok, countPath: '.a' })), undefined, '前导点');
  assert.equal(parseLearnedApi(JSON.stringify({ ...ok, countPath: 'a b' })), undefined, '带空白');
  assert.equal(parseLearnedApi(JSON.stringify({ ...ok, learnedAt: 'yesterday' })), undefined);
  assert.equal(parseLearnedApi(JSON.stringify({ ...ok, learnedAt: -5 })), undefined);
});

test('isValidCountPath 边界：单段/深路径/超长', () => {
  assert.ok(isValidCountPath('count'));
  assert.ok(isValidCountPath('a.b.c.d.e'));
  assert.ok(!isValidCountPath('a.'));
  assert.ok(!isValidCountPath(42));
  assert.ok(!isValidCountPath('x'.repeat(129)));
});

// ---------- sameOrigin ----------

test('sameOrigin：scheme/host/port 全等才同源', () => {
  assert.ok(sameOrigin('https://x.test/api/a', 'https://x.test/'));
  assert.ok(!sameOrigin('https://x.test/api', 'http://x.test/'), 'scheme 不同');
  assert.ok(!sameOrigin('https://a.test/', 'https://b.test/'), 'host 不同');
  assert.ok(!sameOrigin('https://x.test:8443/', 'https://x.test/'), 'port 不同');
  assert.ok(!sameOrigin('garbage', 'https://x.test/'), '非法 URL');
});

// ---------- read/write 往返 ----------

test('writeLearnedApi + readLearnedApi 往返（落盘 → 读回一致）', () => {
  const w = writeLearnedApi(
    root,
    'zoho',
    { method: 'get', url: 'https://x.test/api/pending', countPath: 'data.count' },
    'https://x.test/',
  );
  assert.deepEqual(w, { ok: true });
  const r = readLearnedApi(root, 'zoho');
  assert.ok(r);
  assert.equal(r.method, 'GET', '写入时归一大写');
  assert.equal(r.url, 'https://x.test/api/pending');
  assert.equal(r.countPath, 'data.count');
  assert.ok(r.learnedAt > 0);
});

test('writeLearnedApi 拒绝跨源 URL（学习窗只能学源站点自己的 API）', () => {
  const w = writeLearnedApi(
    root,
    's1',
    { method: 'GET', url: 'https://evil.test/api', countPath: 'n' },
    'https://good.test/',
  );
  assert.equal(w.ok, false);
  assert.match(w.error ?? '', /same-origin/);
  assert.equal(readLearnedApi(root, 's1'), undefined, '拒写 → 读不到');
});

test('writeLearnedApi 拒绝坏 method/countPath', () => {
  assert.equal(
    writeLearnedApi(root, 's2', { method: 'DELETE', url: 'https://x.test/a', countPath: 'n' }, 'https://x.test/').ok,
    false,
  );
  assert.equal(
    writeLearnedApi(root, 's2', { method: 'GET', url: 'https://x.test/a', countPath: 'a..b' }, 'https://x.test/').ok,
    false,
  );
});

test('readLearnedApi：不存在 → undefined；磁盘坏内容 → undefined（静默）', () => {
  assert.equal(readLearnedApi(root, 'never-written'), undefined);
  writeFileSync(join(root, 'source-api-bad.json'), '{{{');
  assert.equal(readLearnedApi(root, 'bad'), undefined);
  writeFileSync(join(root, 'source-api-huge.json'), 'x'.repeat(16 * 1024));
  assert.equal(readLearnedApi(root, 'huge'), undefined, '超 8KB 上限拒读（防手改塞大文件）');
});

test('learnedApiPath：userRoot 下带 id 的文件名（与 main-config 同目录）', () => {
  const p = learnedApiPath('C:/u/.dsh/dsh-pet', 'zoho-tm');
  assert.ok(p.replace(/\\/g, '/').endsWith('/source-api-zoho-tm.json'));
});

// ---------- extractCount ----------

test('extractCount：点号路径挖数字（嵌套/顶层/字符串数字）', () => {
  assert.equal(extractCount({ data: { pending: { count: 12 } } }, 'data.pending.count'), 12);
  assert.equal(extractCount({ total: 3 }, 'total'), 3);
  assert.equal(extractCount({ n: '42' }, 'n'), 42, '数字字符串可挖（Number 收敛）');
});

test('extractCount：路径断/非数字 → undefined（绝不给 NaN）', () => {
  assert.equal(extractCount({ data: null }, 'data.pending'), undefined);
  assert.equal(extractCount({}, 'missing'), undefined);
  assert.equal(extractCount({ n: 'abc' }, 'n'), undefined, '非数字字符串');
  assert.equal(extractCount({ n: 'abc' }, 'n.x'), undefined, '断在字符串上');
  assert.equal(extractCount(undefined, 'a'), undefined);
  assert.equal(extractCount({ a: 1 }, 'a..'), undefined, '坏路径');
});
