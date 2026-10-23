// builtin-webview 源的「学习文件」存储（ADR-002 v1.1 —— API 学习）。
//
// 学习文件 = $DSH_HOME/dsh-pet/source-api-<id>.json：看门人轮询打哪个接口、
// 用哪条 JSON 路径挖待办数。它由**登录窗里的抓包会话**产生（Electron 侧
// runtime/electron-helper/main.js 的 source:learn-start / source:learn-save 通道，
// webRequest.onBeforeRequest 被动观察登录窗里的 XHR），本模块只负责：
//   读取（探活后按学习 API 取真数）+ 写入（学习完成落盘）+ 校验形状。
//
// 安全口径（与「绝不存密码」同一条线）：
//   - 只记 { method, url, countPath } 三个字段——不带 headers、不带 cookie、
//     不带请求/响应体（这些一个都存不了：webRequest 钩子只给 method+url+headers，
//     学习会话主动不收 headers）；
//   - url 必须与源声明的 url 同源（学习窗只能抓源站点自己的 API，防「顺手学了
//     别的站」——学习窗本身也只 load 源 url，这是双保险）；
//   - countPath 是点号路径（如 "data.pending.count"），读取端用它从响应 JSON 挖数。
//
// 本文件是 host 侧纯逻辑（可单测）；Electron 侧的学习窗实现在 main.js。

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** 学习文件内容（落盘 JSON 的形状；版本字段供未来演进） */
export interface LearnedApi {
  /** 学习文件格式版本（当前 1；读取端按它判定兼容） */
  version: 1;
  /** HTTP 方法（大写；GET/POST 之一——轮询只用这两个） */
  method: 'GET' | 'POST';
  /** 目标 API 的绝对 URL（与源声明同源，写入端已校验） */
  url: string;
  /** 响应 JSON 里待办数的点号路径（如 "data.pending.count"；数字叶子） */
  countPath: string;
  /** 学习时刻（epoch ms；展示用） */
  learnedAt: number;
}

/** 学习文件最大体积（防手改塞大文件拖垮启动读取） */
const LEARNED_MAX_BYTES = 8 * 1024;

/** 同源判定：学习到的 API 必须与源声明 URL 同 origin（scheme+host+port） */
export function sameOrigin(a: string, b: string): boolean {
  let ua: URL;
  let ub: URL;
  try {
    ua = new URL(a);
    ub = new URL(b);
  } catch {
    return false;
  }
  return ua.origin === ub.origin;
}

/** countPath 形状校验：非空、无空白、段与段之间恰好一个点、每段非空 */
const COUNT_PATH_RE = /^[^\s.]+(\.[^\s.]+)*$/;
export const isValidCountPath = (p: unknown): p is string =>
  typeof p === 'string' && p.length > 0 && p.length <= 128 && COUNT_PATH_RE.test(p);

/**
 * 学习文件路径（$DSH_HOME/dsh-pet 下与 main-config.jsonc 同目录）。
 * userRoot = index.ts 的那个 userRoot（拼 'dsh-pet' 的地方只有一处）。
 */
export const learnedApiPath = (userRoot: string, id: string): string => join(userRoot, `source-api-${id}.json`);

/**
 * 读学习文件；不存在/形状非法/超限 → undefined（看门人回落哨兵数字）。
 * 非法**静默**（warn 交给调用方）：学习文件是增强件，坏了不该让轮询报错。
 */
export function readLearnedApi(userRoot: string, id: string): LearnedApi | undefined {
  const file = learnedApiPath(userRoot, id);
  if (!existsSync(file)) return undefined;
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
  if (raw.length > LEARNED_MAX_BYTES) return undefined;
  return parseLearnedApi(raw);
}

/** 解析 + 校验（写入端复用同一份规则，读写一个口径） */
export function parseLearnedApi(raw: string): LearnedApi | undefined {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!obj || typeof obj !== 'object') return undefined;
  const o = obj as Record<string, unknown>;
  if (o.version !== 1) return undefined;
  const method = o.method;
  if (method !== 'GET' && method !== 'POST') return undefined;
  const url = o.url;
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return undefined;
  const countPath = o.countPath;
  if (!isValidCountPath(countPath)) return undefined;
  const learnedAt = Number(o.learnedAt);
  if (!Number.isFinite(learnedAt) || learnedAt <= 0) return undefined;
  return { version: 1, method, url, countPath, learnedAt };
}

/**
 * 写学习文件（学习会话完成时调用；Electron 侧 source:learn-save 的宿主半边）。
 * 写入前双保险：与源声明同源 + 形状校验——Electron 侧已校验，这里再收一道
 * （磁盘上的文件谁都能改，读取端只信自己的校验）。
 */
export function writeLearnedApi(
  userRoot: string,
  id: string,
  api: { method: string; url: string; countPath: string },
  sourceUrl: string,
): { ok: boolean; error?: string } {
  if (!sameOrigin(api.url, sourceUrl)) {
    return { ok: false, error: 'learned api must be same-origin with source url' };
  }
  const method = api.method.toUpperCase();
  if (method !== 'GET' && method !== 'POST') return { ok: false, error: 'method must be GET/POST' };
  if (!isValidCountPath(api.countPath)) return { ok: false, error: 'bad countPath' };
  const file = learnedApiPath(userRoot, id);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    JSON.stringify(
      { version: 1, method, url: api.url, countPath: api.countPath, learnedAt: Date.now() } satisfies LearnedApi,
      null,
      2,
    ),
  );
  return { ok: true };
}

/**
 * 按点号路径从响应 JSON 挖数字叶子；路径不存在/不是有限数 → undefined
 * （调用方回落哨兵数字，绝不投 NaN）。
 */
export function extractCount(obj: unknown, countPath: string): number | undefined {
  if (!isValidCountPath(countPath)) return undefined;
  let cur: unknown = obj;
  for (const seg of countPath.split('.')) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  const n = Number(cur);
  return Number.isFinite(n) ? n : undefined;
}
