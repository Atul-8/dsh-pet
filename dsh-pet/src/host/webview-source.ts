// builtin-webview 源适配器（ADR-002 阶段三，active 类型）——「会话看门人」。
//
// 架构（ADR-002 §3.1 / §4 阶段三）：
//   1. **登录窗**：宿主检测到 cookie 失效（或首次配置）时，让 Electron Helper 开一个
//      **可见的普通浏览器窗口**（用户交互式登录、可过 2FA）。会话用独立 persist 分区
//      `persist:dsh-pet-source-<id>`——cookie 由 Chromium 落盘管理，**宿主全程不碰
//      密码、不读 cookie 明文**（拿到的只有「登录了没有」这个事实）。
//   2. **无窗口轮询**：登录完成后关窗，宿主按 intervalMs 周期让 Helper 在同一 persist
//      分区里发**无窗口 fetch**（cookie 自动携带）到学习到的 API，把结果投给桥。
//   3. **桥自我环回**：适配器把抓到的数据 `POST 127.0.0.1:7340/dsh-pet-7340/badge`（带
//      source=id）——校验、心跳、状态写入天然复用**同一条路径**，与油猴投喂在宿主眼里
//      不可区分（这是「加类型不重构」的结构保证）。
//   4. **状态自报**：登录失效 → 适配器停止投喂并把健康写 expired（active 源不走 stale
//      判定，自报才准）——注册表 snapshot 里 active 源的 expired 状态来自本模块的标记。
//
// 本文件是**宿主侧驱动器**：管理轮询循环生命周期 + 与 Helper 的 IPC 约定 + 桥环回。
// 登录窗与无窗口 fetch 的 Electron 侧实现在 runtime/electron-helper/main.js（ipc:
// `source:login-open` / `source:fetch`）。
//
// 与 Helper 的分工：Helper 进程只在有桌面宠物时才存在（may not be running）——
// 阶段三 v1 的策略：**无 Helper 时适配器静默不启动**（enabled 状态照显示，健康
// unknown + 说明）。看门人依赖 Electron 会话能力，这是环境事实不是故障。

import type { SourceDecl } from './sources';
import { extractCount, readLearnedApi } from './learned-api';

/** 适配器对外接口（index.ts 装配层用） */
export interface WebviewSourceHandle {
  /** 声明 id（与配置 sources[].id 一致） */
  id: string;
  /** 停止轮询（dispose 时逐个调用） */
  stop(): void;
  /** 标记登录失效（IPC 收到 Helper 的 source:auth-lost 时由装配层调用） */
  markExpired(reason: string): void;
}

/** 装配依赖（宿主注入：怎么找 Helper、怎么 POST 桥、怎么写日志） */
export interface WebviewSourceDeps {
  /** 桥环回地址（如 http://127.0.0.1:7340）——适配器 POST `<bridge>/dsh-pet-7340/badge` */
  bridgeOrigin: string;
  /** 发 IPC 给 Helper（登录窗开/关、无窗口 fetch）；返回 false = Helper 不在/不认识此通道 */
  sendToHelper(channel: string, payload: Record<string, unknown>): Promise<unknown>;
  /** 过期标记的写口：宿主把注册表里该源标记为 expired（active 源自报，不走 stale 判定） */
  markSourceExpired(id: string, reason: string): void;
  /** 学习文件根目录（$DSH_HOME/dsh-pet；v1.1 API 学习——learned-api.ts 的读取口） */
  userRoot: string;
  logger?: { info?: (...a: unknown[]) => void; warn?: (...a: unknown[]) => void; error?: (...a: unknown[]) => void };
}

const DEFAULT_INTERVAL_MS = 60_000;

/**
 * 启动一个 builtin-webview 源的轮询循环。
 * v1 语义（对 ADR 的最小可行切片）：
 *   - 循环每 intervalMs 一拍：让 Helper 无窗口 fetch 登录页可及性 → 判定 cookie 死活；
 *   - cookie 活 → 向桥 POST badge（count = 学习到的待处理数；v1 先投 1 = 「看门人在岗」
 *     的哨兵数字，API 学习留 v1.1——见文件尾的 TODO 注释）；
 *   - cookie 死 → markExpired + 让 Helper 开登录窗（用户登录成功后 Helper 经
 *     source:auth-ok 通知，装配层 restart 本循环）；
 *   - Helper 不在（sendToHelper false）→ 静默退避（健康 unknown，等桌面模式上线）。
 */
export function startWebviewSource(decl: SourceDecl, deps: WebviewSourceDeps): WebviewSourceHandle {
  const log = deps.logger ?? {};
  const intervalMs = decl.intervalMs ?? DEFAULT_INTERVAL_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  let expired = false;

  const tick = async (): Promise<void> => {
    if (disposed || expired) return;
    // 1. 无窗口探活：Helper 在 persist 分区里 fetch 站点（cookie 自动带）
    let probe: { ok: boolean; status?: number; authed?: boolean };
    try {
      const r = await deps.sendToHelper('source:probe', { id: decl.id, url: decl.url ?? '' });
      probe = r && typeof r === 'object' ? (r as { ok: boolean; status?: number; authed?: boolean }) : { ok: false };
    } catch {
      probe = { ok: false };
    }
    if (disposed) return;
    if (!probe.ok) {
      // Helper 不在 / 通道不存在：静默退避（环境事实，非故障）——下一拍再试
      return;
    }
    if (probe.authed === false) {
      // cookie 失效：自报 expired（active 源不走 stale 判定）+ 请求开登录窗
      expired = true;
      deps.markSourceExpired(decl.id, '登录失效（cookie 过期或被登出）');
      log.warn?.(`[dsh-pet] 源「${decl.id}」登录失效，已请求打开登录窗（persist 分区 cookie）`);
      void deps.sendToHelper('source:login-open', { id: decl.id, url: decl.url ?? '' });
      return;
    }
    // 2. cookie 活（authed === true）→ 桥环回投喂。v1.1 API 学习：
    //    有学习文件（source-api-<id>.json）→ 让 Helper 按学到的 API 无窗口取数，
    //    用 countPath 挖出真实待办数；没学过/取失败/挖不出 → 回落哨兵数字 1
    //    （看门人在岗至少是事实）。authed 缺省（5xx / 判不出）→ 本拍退避：不投
    //    也不报——「不确定」不是「失效」，下一拍重探（误报 expired 会催用户去登录
    //    一个其实还活着的会话）。
    if (probe.authed !== true) return;
    let count = 1;
    let label = '看门人';
    const learned = readLearnedApi(deps.userRoot, decl.id);
    if (learned) {
      label = decl.id;
      try {
        const r = await deps.sendToHelper('source:fetch-json', {
          id: decl.id,
          method: learned.method,
          url: learned.url,
        });
        const obj = r && typeof r === 'object' ? (r as { ok?: boolean; json?: unknown }) : undefined;
        if (obj?.ok) {
          const dug = extractCount(obj.json, learned.countPath);
          if (dug !== undefined) count = dug;
          else log.warn?.(`[dsh-pet] 源「${decl.id}」响应里挖不到 ${learned.countPath}，本拍回落哨兵数字`);
        } else {
          log.warn?.(`[dsh-pet] 源「${decl.id}」按学习 API 取数失败，本拍回落哨兵数字`);
        }
      } catch {
        log.warn?.(`[dsh-pet] 源「${decl.id}」学习 API 请求异常，本拍回落哨兵数字`);
      }
    }
    try {
      await fetch(deps.bridgeOrigin + '/dsh-pet-7340/badge', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ count, label, source: decl.id }),
      });
    } catch (e) {
      log.warn?.(`[dsh-pet] 源「${decl.id}」桥环回失败：` + (e instanceof Error ? e.message : String(e)));
    }
  };

  const schedule = (): void => {
    if (disposed) return;
    timer = setTimeout(() => {
      timer = undefined;
      void tick().finally(schedule);
    }, intervalMs);
    timer.unref?.();
  };

  // 首拍立即跑一次（不等整个 interval），让健康状态尽快从 unknown 翻到 alive
  void tick().finally(schedule);

  return {
    id: decl.id,
    stop() {
      disposed = true;
      if (timer) clearTimeout(timer);
    },
    markExpired(reason: string) {
      expired = true;
      deps.markSourceExpired(decl.id, reason);
    },
  };
}

// v1.1 后续（ADR-002 开放问题）：
//   - 油猴复用（Q2 后半）：学习到的 API（source-api-<id>.json）可导出给油猴脚本，
//     一处学习多方投喂——读接口已就绪，导出面待定；
//   - 多源并发上限（Q3）：全部 active 源的 tick 错峰（interval 加 ±10% 抖动）。
// API 学习本体已落地：登录窗抓包（main.js source:learn-start/save）+
// host 存储（learned-api.ts）+ 本文件消费（source:fetch-json → countPath 挖数）。
