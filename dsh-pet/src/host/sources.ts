// 数据源注册表 + 新鲜度看门狗（ADR-002 阶段一，host 半侧）。
//
// 职责：把「谁在喂桌宠」变成**可见状态**——外部脚本（油猴 / seeed-ts pet-bridge / 未来的
// 自研扩展）往桥上 POST 时带一个可选 `source` 字段，宿主按注册表刷新心跳，看门狗把
// 每个已声明源的健康度写进 S 的 `sections.sources` 叶子（前端据此给徽标降色）。
//
// 分类学（ADR-002 §3.1）：
//   - declared（external-push）：外部脚本，宿主只登记「期待」——心跳间隔 / 喂哪个叶子；
//   - active（builtin-*）：宿主自己跑的适配器（阶段三接入），走桥自我环回，与外部推送
//     在宿主眼里不可区分——本模块对两者一视同仁（都只是「POST 上来的心跳」）。
//
// 健康判定（§3.4，判定函数是纯函数，见 computeHealth）：
//   - disabled：声明里 enabled:false（用户在配置里手动停用）；
//   - unknown：从未心跳过（信息性，不是告警）；
//   - alive：心跳在阈值内；
//   - stale：declared + expectIntervalMs 且 now-lastSeen > max(2×interval, 5min)——
//     **只有声明了期待间隔的源才会 stale**；事件型（无 interval）永不 stale（否则天天误报）；
//   - expired：active 源自报故障（阶段三才产生，枚举先行占位）。
//
// 匿名兼容（§3.3 契约铁律）：不带 source / source 未声明 → 投喂照常受理，绝不拒收；
// 心跳只记进 anonymous（统计性信息，不参与任何健康判定）。老调用方零改动升级。

import { readUserConfig } from './config';
import type { ConfigPaths } from './config';

/** 已告警过的 声明问题键（进程内去重：同一问题只告警一次；重启重置） */
const warnedSourceKeys = new Set<string>();

function warnSourceOnce(key: string, message: string): void {
  if (warnedSourceKeys.has(key)) return;
  warnedSourceKeys.add(key);
  console.warn('dsh-pet: ' + message);
}

/** source id 的合法形状（与宠物 id 同一套约束）：非空、≤64、无文件名非法字符 */
// eslint-disable-next-line no-control-regex -- 控制字符过滤正是本正则的目的（同 config.ts 的宠物 id 口径）
const ID_FORBIDDEN = /[\\/:*?"<>|\u0000-\u001f]/;
export const isValidSourceId = (id: string): boolean => id.length > 0 && id.length <= 64 && !ID_FORBIDDEN.test(id);

/**
 * 一条**声明**（用户配置 sources[] 里的一项，校验后的形状）。
 * v1 只认 type:'external-push'（active 类型阶段三随适配器一起加）；
 * 其它 type 的条目**整条丢弃并告警**——注册表是 type 判别的，不认识的类型没有语义。
 */
export interface SourceDecl {
  type: string;
  id: string;
  /** 喂哪个叶子：badge（徽标，周期性）/ broadcast（事件流，突发性） */
  feed: 'badge' | 'broadcast';
  /** 期待心跳间隔（ms）。给了才会参与 stale 判定；事件型源不写这个字段 */
  expectIntervalMs?: number;
  /** 手动停用（健康显示 disabled；心跳照记，恢复开关即恢复判定） */
  enabled?: boolean;
}

/** 健康度（S 的 sections.sources.data.list 里一项的形状；shared/state.ts 有消费端副本） */
export interface SourceHealthEntry {
  id: string;
  type: string;
  feed: string;
  health: 'alive' | 'stale' | 'unknown' | 'expired' | 'disabled';
  /** 最近一次心跳（epoch ms；从未心跳则缺省） */
  lastSeen?: number;
  /** 声明的期待间隔（透传给消费端：前端可显示「期待 N 秒一拍」） */
  expectIntervalMs?: number;
}

/** 读用户层声明：main-config.jsonc 顶层 `sources: [...]`（非法条目丢弃 + 告警，不炸加载）。
 *  只读用户层（不进 mergeEntry / 不进 GET /config 成品聚合）：sources 是宿主的观测配置，
 *  不是渲染参数；设置页阶段二再决定要不要展示。 */
export function readSourceDecls(paths: ConfigPaths): SourceDecl[] {
  let raw: unknown;
  try {
    raw = readUserConfig(paths)?.sources;
  } catch {
    return []; // 用户层读不动（同步预检在别处管）：按无声明处理，绝不炸投喂链路
  }
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    warnSourceOnce('sources:type', '配置的 sources 必须是数组，已忽略整段');
    return [];
  }
  const out: SourceDecl[] = [];
  const seen = new Set<string>();
  raw.forEach((item, i) => {
    if (!item || typeof item !== 'object') {
      warnSourceOnce(`sources:${i}`, `sources[${i}] 不是对象，已丢弃`);
      return;
    }
    const d = item as Record<string, unknown>;
    const type = typeof d.type === 'string' ? d.type.trim() : '';
    const id = typeof d.id === 'string' ? d.id.trim() : '';
    const feed = d.feed;
    if (type !== 'external-push') {
      // 前向兼容占位：认识的 active 类型（builtin-webview 等）阶段三实现；其余整条丢弃
      warnSourceOnce(
        `sources:${i}:type`,
        `sources[${i}] 的 type「${type || '(空)'}」暂不支持，已丢弃（外部推送请写 external-push）`,
      );
      return;
    }
    if (!isValidSourceId(id)) {
      warnSourceOnce(`sources:${i}:id`, `sources[${i}] 的 id 非法（非空、≤64 字符、不含文件名保留符），已丢弃`);
      return;
    }
    if (feed !== 'badge' && feed !== 'broadcast') {
      warnSourceOnce(`sources:${i}:feed`, `sources[${i}] 的 feed 必须是 badge 或 broadcast，已丢弃`);
      return;
    }
    if (seen.has(id)) {
      warnSourceOnce(`sources:${i}:dup`, `sources[${i}] 的 id「${id}」重复，后条已丢弃`);
      return;
    }
    const interval = d.expectIntervalMs;
    if (interval !== undefined && (!Number.isFinite(Number(interval)) || Number(interval) < 1000)) {
      warnSourceOnce(
        `sources:${i}:interval`,
        `sources[${i}]「${id}」的 expectIntervalMs 非法（需 ≥1000 的有限数），已丢弃该字段（事件型口径）`,
      );
    }
    const enabled = d.enabled;
    if (enabled !== undefined && typeof enabled !== 'boolean') {
      warnSourceOnce(`sources:${i}:enabled`, `sources[${i}]「${id}」的 enabled 非布尔，已忽略`);
    }
    const decl: SourceDecl = { type, id, feed };
    if (interval !== undefined && Number.isFinite(Number(interval)) && Number(interval) >= 1000) {
      decl.expectIntervalMs = Math.floor(Number(interval));
    }
    if (typeof enabled === 'boolean') decl.enabled = enabled;
    seen.add(id);
    out.push(decl);
  });
  return out;
}

/** stale 阈值：max(2×interval, 5min)——间隔抖动两倍内不算断，下限 5 分钟防秒级间隔误报 */
export const staleAfterMs = (intervalMs: number): number => Math.max(2 * intervalMs, 5 * 60_000);

/**
 * 健康判定（纯函数，测试直接打）。
 * @param decl 声明
 * @param lastSeen 最近心跳；undefined = 从未
 * @param now 判定时刻（epoch ms）
 */
export function computeHealth(
  decl: SourceDecl,
  lastSeen: number | undefined,
  now: number,
): 'alive' | 'stale' | 'unknown' | 'expired' | 'disabled' {
  if (decl.enabled === false) return 'disabled';
  if (decl.expectIntervalMs === undefined) {
    // 事件型（无 interval 期待）：见过即 alive，**永不 stale**（否则天天误报，ADR §3.4）
    return lastSeen === undefined ? 'unknown' : 'alive';
  }
  if (lastSeen === undefined) return 'unknown';
  return now - lastSeen > staleAfterMs(decl.expectIntervalMs) ? 'stale' : 'alive';
}

/**
 * 心跳注册表（进程内内存态，重启即空；watchdog 每 30s 一拍消费成 sections.sources）。
 * 心跳在**路由受理层**记（POST 到达即算活着——哪怕 body 非法被 400 拒绝，脚本本身确实在跑；
 * 这与「stale = 脚本死了」的语义一致：活着但发坏数据是另一个问题，不该用 stale 表达）。
 */
export class SourceRegistry {
  /** 已声明 id → 最近心跳时刻（含 disabled 的源：心跳照记，恢复开关即恢复判定） */
  private readonly lastSeen = new Map<string, number>();
  /** 匿名心跳（不带 source / 未声明 id）：只做统计展示，不参与健康判定 */
  anonymousLastSeen: number | undefined;

  /** 记一次心跳。返回是否「可见状态变化」（调用方据此决定要不要立即刷叶子）。
   *  秒级去抖：同源 1s 内的重复 POST 完全忽略（不记也不报）——lastSeen 停在该秒的
   *  第一拍，误差上限 1s；换来的是徽标+ts 刷新连发时不触发重渲染风暴。 */
  noteHeartbeat(sourceId: string | undefined, now: number, decls: SourceDecl[]): boolean {
    if (sourceId === undefined) {
      const before = this.anonymousLastSeen;
      if (before !== undefined && now - before < 1000) return false;
      this.anonymousLastSeen = now;
      return before === undefined;
    }
    const known = decls.some((d) => d.id === sourceId);
    if (!known) {
      // 未声明的具名源：与匿名同待遇（记 anonymous 时间戳，不出现在健康列表里）
      const before = this.anonymousLastSeen;
      if (before !== undefined && now - before < 1000) return false;
      this.anonymousLastSeen = now;
      return before === undefined;
    }
    const before = this.lastSeen.get(sourceId);
    if (before !== undefined && now - before < 1000) return false;
    this.lastSeen.set(sourceId, now);
    return true;
  }

  /** 当前快照（判定 + 透传给消费端的形状） */
  snapshot(decls: SourceDecl[], now: number): { list: SourceHealthEntry[]; anonymousLastSeen?: number } {
    const list: SourceHealthEntry[] = decls.map((d) => {
      const seen = this.lastSeen.get(d.id);
      const entry: SourceHealthEntry = {
        id: d.id,
        type: d.type,
        feed: d.feed,
        health: computeHealth(d, seen, now),
      };
      if (seen !== undefined) entry.lastSeen = seen;
      if (d.expectIntervalMs !== undefined) entry.expectIntervalMs = d.expectIntervalMs;
      return entry;
    });
    return this.anonymousLastSeen === undefined ? { list } : { list, anonymousLastSeen: this.anonymousLastSeen };
  }
}

/**
 * 投喂请求体里的 source 字段收窄（与 tone/items 同一口径：非法**静默丢字段**，绝不拒收）。
 * trim 后非空、≤64 字符、无控制字符 / 文件名保留符。
 */
export function normalizeSourceField(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const s = raw.trim();
  return isValidSourceId(s) ? s : undefined;
}
