// ADR-002 阶段一单测：声明表解析 / 心跳注册 / 健康判定 / source 字段收窄 / 匿名兼容。
// 这些全是纯函数 + 进程内类，不碰网络；路由层的 E2E（POST 带 source → sections.sources 出现心跳）
// 在 routes.test.ts 的 /badge 分支里。
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import {
  computeHealth,
  isValidSourceId,
  normalizeSourceField,
  readSourceDecls,
  SourceRegistry,
  staleAfterMs,
} from './sources';
import type { ConfigPaths } from './config';

const makePaths = (dir: string): ConfigPaths =>
  ({
    defaultFile: join(dir, 'config.jsonc'),
    userFile: join(dir, 'main-config.jsonc'),
    petDir: join(dir, 'pet'),
  }) as unknown as ConfigPaths;

const writeUser = (paths: ConfigPaths, content: string): void => {
  mkdirSync(join(paths.userFile, '..'), { recursive: true });
  writeFileSync(paths.userFile, content, 'utf8');
};

describe('readSourceDecls —— 用户层声明表', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-pet-sources-'));
  const paths = makePaths(dir);
  test.after(() => rmSync(dir, { recursive: true, force: true }));

  test('没有 sources 键 → 空表（零声明是最常见形态）', () => {
    writeUser(paths, '{ "pets": [] }');
    assert.deepEqual(readSourceDecls(paths), []);
  });

  test('合法声明原样读出（badge 周期型 + broadcast 事件型 + 停用项）', () => {
    writeUser(
      paths,
      JSON.stringify({
        sources: [
          { type: 'external-push', id: 'zoho-tm', feed: 'badge', expectIntervalMs: 90000 },
          { type: 'external-push', id: 'seeed-files', feed: 'broadcast' },
          { type: 'external-push', id: 'paused', feed: 'badge', expectIntervalMs: 5000, enabled: false },
        ],
      }),
    );
    const decls = readSourceDecls(paths);
    assert.equal(decls.length, 3);
    assert.deepEqual(decls[0], { type: 'external-push', id: 'zoho-tm', feed: 'badge', expectIntervalMs: 90000 });
    assert.deepEqual(decls[1], { type: 'external-push', id: 'seeed-files', feed: 'broadcast' });
    assert.equal(decls[2].enabled, false);
  });

  test('非法条目丢弃不炸：非对象 / 坏 type / 坏 id / 坏 feed / 重复 id / 坏 interval / 坏 enabled', () => {
    writeUser(
      paths,
      JSON.stringify({
        sources: [
          42,
          { type: 'builtin-webview', id: 'future', feed: 'badge' },
          { type: 'external-push', id: '', feed: 'badge' },
          { type: 'external-push', id: 'a/b', feed: 'badge' },
          { type: 'external-push', id: 'ok-1', feed: 'nonsense' },
          { type: 'external-push', id: 'ok-1', feed: 'badge' },
          { type: 'external-push', id: 'ok-2', feed: 'badge', expectIntervalMs: 100 },
          { type: 'external-push', id: 'ok-2', feed: 'badge' },
          { type: 'external-push', id: 'ok-3', feed: 'badge', enabled: 'yes' },
        ],
      }),
    );
    const decls = readSourceDecls(paths);
    // 丢弃：42（非对象）、builtin-webview（类型未支持）、''（id 空）、a/b（文件名非法）、
    // nonsense（feed）、重复 ok-1、ok-2 的第一个（interval<1000 整条进丢弃名单？不——
    // interval 非法只丢字段不丢条目，所以 ok-2 第一条存活为事件型，第二条按重复丢弃）、
    // ok-3（enabled 非布尔丢字段，条目存活）
    assert.deepEqual(decls, [
      { type: 'external-push', id: 'ok-1', feed: 'badge' },
      { type: 'external-push', id: 'ok-2', feed: 'badge' },
      { type: 'external-push', id: 'ok-3', feed: 'badge' },
    ]);
  });

  test('sources 非数组 → 整段忽略', () => {
    writeUser(paths, '{ "sources": "oops" }');
    assert.deepEqual(readSourceDecls(paths), []);
  });
});

describe('computeHealth —— 判定矩阵（纯函数）', () => {
  const decl = { type: 'external-push', id: 'x', feed: 'badge' as const, expectIntervalMs: 60000 };
  const eventDecl = { type: 'external-push', id: 'y', feed: 'broadcast' as const };

  test('stale 阈值 = max(2×interval, 5min)：抖两倍不算断，下限兜秒级间隔', () => {
    assert.equal(staleAfterMs(1000), 300000); // 1s 间隔 → 5min 下限
    assert.equal(staleAfterMs(60000), 300000); // 2×60s = 120s < 5min → 下限仍生效
    assert.equal(staleAfterMs(180000), 360000); // 2×180s = 360s > 5min → 2× 胜出
  });

  test('interval 型：从未见过 → unknown；阈值内 → alive；超阈值 → stale', () => {
    assert.equal(computeHealth(decl, undefined, 1000000), 'unknown');
    assert.equal(computeHealth(decl, 900000, 1000000), 'alive'); // 差 100s < 5min 阈值
    assert.equal(computeHealth(decl, 600000, 1000000), 'stale'); // 差 400s > 5min 阈值
  });

  test('事件型（无 interval）：从未 → unknown；见过永远 alive，永不 stale（防误报）', () => {
    assert.equal(computeHealth(eventDecl, undefined, 1000000), 'unknown');
    assert.equal(computeHealth(eventDecl, 0, 999999999), 'alive');
  });

  test('enabled:false 一票否决 → disabled（心跳照记，判定不看）', () => {
    assert.equal(computeHealth({ ...decl, enabled: false }, 900000, 1000000), 'disabled');
  });
});

describe('SourceRegistry —— 心跳与快照', () => {
  test('命中声明 id → 刷 lastSeen；秒级去抖（变化检测只对 ≥1s 的间隔报 true）', () => {
    const r = new SourceRegistry();
    const decls = [{ type: 'external-push', id: 'a', feed: 'badge' as const, expectIntervalMs: 60000 }];
    assert.equal(r.noteHeartbeat('a', 1000, decls), true); // 首次 → 变化
    assert.equal(r.noteHeartbeat('a', 1500, decls), false); // 0.5s 内 → 不算
    assert.equal(r.noteHeartbeat('a', 2100, decls), true); // ≥1s → 算
  });

  test('匿名 / 未声明 id → anonymousLastSeen，健康列表不出现', () => {
    const r = new SourceRegistry();
    const decls = [{ type: 'external-push', id: 'a', feed: 'badge' as const }];
    r.noteHeartbeat(undefined, 1000, decls);
    r.noteHeartbeat('ghost', 2000, decls);
    const snap = r.snapshot(decls, 3000);
    assert.equal(snap.list.length, 1);
    assert.equal(snap.list[0].id, 'a');
    assert.equal(snap.list[0].health, 'unknown');
    assert.equal(snap.anonymousLastSeen, 2000); // 未声明的具名源也算匿名时刻
  });

  test('快照透传 lastSeen / expectIntervalMs；disabled 源心跳照记', () => {
    const r = new SourceRegistry();
    const decls = [{ type: 'external-push', id: 'a', feed: 'badge' as const, expectIntervalMs: 60000, enabled: false }];
    r.noteHeartbeat('a', 5000, decls);
    const snap = r.snapshot(decls, 6000);
    assert.equal(snap.list[0].health, 'disabled');
    assert.equal(snap.list[0].lastSeen, 5000);
    assert.equal(snap.list[0].expectIntervalMs, 60000);
  });
});

describe('normalizeSourceField —— 契约收窄（静默丢字段，绝不拒收）', () => {
  test('合法 id 原样返回（trim 后）', () => {
    assert.equal(normalizeSourceField('  zoho-tm '), 'zoho-tm');
  });
  test('非法一律 undefined：非字符串 / 空 / >64 / 控制字符 / 文件名保留符', () => {
    assert.equal(normalizeSourceField(undefined), undefined);
    assert.equal(normalizeSourceField(42), undefined);
    assert.equal(normalizeSourceField('   '), undefined);
    assert.equal(normalizeSourceField('x'.repeat(65)), undefined);
    assert.equal(normalizeSourceField('a|b'), undefined);
    assert.equal(normalizeSourceField('a\u0000b'), undefined);
  });
  test('isValidSourceId 边界：64 恰好合法，65 非法', () => {
    assert.equal(isValidSourceId('x'.repeat(64)), true);
    assert.equal(isValidSourceId('x'.repeat(65)), false);
  });
});
