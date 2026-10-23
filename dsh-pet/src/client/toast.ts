// 事件 toast（client 半侧，ADR-001 阶段二）：presenter 档位 = toast / both 时的
// 事件去向——右下角页内浮层堆叠 + 常驻计数片。
//
// 为什么弃 Web Notification（ADR-001 §4.2 的选型表）：
// - 透明度/样式可控（毛玻璃 rgba，与 DSH 视觉一体）；系统通知样式不可改；
// - 8s 自动收 + 手动关；系统通知 ~5s 自动消失且时长系统说了算；
// - 点击意图走 DOM 事件精确路由（open-session/open-url）；Notification 的点击回调受限；
// - 页面聚焦时照常显示——notify.ts 的聚焦门会在聚焦时**跳过**系统通知，
//   而"用户正在看页面"恰恰是页内 toast 最该出现的时候（设计矛盾）。
//
// 与宠物形态（pet 档）的关系：同一份 /state 轮询，换 sink（PetMulti 的渲染分支），
// 不是新插件——轮询循环、叶子分发、任务/会话状态机都复用 PetMulti 的。
// 计数片与徽标（badge.ts）的分工：徽标锚在宠物头顶（要宠物 DOM），计数片锚在视口角落
// （不需要宠物）——同一份 BadgeState 数据，两种宿主形态各用各的载体。
import type { ReactNode } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { jsx } from 'react/jsx-runtime';
import { type BadgeState, type EventIntent, type SayCue } from '../shared/state';

/** toast 档位下一条 say 事件的队列形态（seq 用于 React key + 手动关闭定位） */
export interface ToastItem {
  seq: number;
  petId: string;
  /** 只装 say 形态（clear 在入队前就被过滤：它对 toast 没有语义，到点收条即可） */
  cue: Extract<SayCue, { kind: 'say' }> & { seq: number };
}

/** intent 消费：点击 toast 之后的路由（ADR-001 §4.3）。
 *  - open-url → window.open（新标签页）；
 *  - open-session → uiWorkspace.openSession（装配层注入；取不到降级为 focus 窗口——
 *    与 notify.ts 同一降级哲学：intent 落空不该静默，但也不该报错打断用户）。
 *  消费端放这里而不是 pet 档：pet 档气泡保持非交互（v1 口径，ADR §4.3 末段）。 */
export function consumeIntent(
  intent: EventIntent | undefined,
  openSession: ((sessionId: string) => boolean | null) | null,
): void {
  if (!intent) return;
  if (intent.type === 'open-url' && intent.url) {
    window.open(intent.url, '_blank', 'noopener');
    return;
  }
  if (intent.type === 'open-session' && intent.sessionId) {
    const ok = openSession ? openSession(intent.sessionId) : false;
    if (!ok) window.focus(); // 降级：把 DSH 窗口叫回前台（会话没打开但至少不静默）
  }
}

/** 毛玻璃卡片 + 堆叠动画 + 自动收起。z-index 低于菜单层（菜单 9000+，见 shared/menu.ts）。 */
const toastCss = [
  '@keyframes dsh-pet-toast-in{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:translateY(0)}}',
  '@keyframes dsh-pet-toast-out{from{opacity:1}to{opacity:0;transform:translateX(24px)}}',
  '.dsh-pet-toasts{position:fixed;right:16px;bottom:16px;display:flex;flex-direction:column;gap:8px;' +
    'z-index:8000;pointer-events:none;max-width:min(360px,60vw);' +
    'font-family:var(--dsh-pet-font-family,"ShangshouSoftCandy","Yuanti SC","YouYuan","幼圆","PingFang SC","Microsoft YaHei",sans-serif)}',
  '.dsh-pet-toast{pointer-events:auto;display:flex;align-items:flex-start;gap:8px;padding:10px 12px;' +
    'background:rgba(32,36,44,.88);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);' +
    'color:#f5f6f8;border-radius:12px;border:1px solid rgba(255,255,255,.12);' +
    'font-size:13px;line-height:1.5;box-shadow:0 4px 16px rgba(0,0,0,.3);' +
    'animation:dsh-pet-toast-in .18s ease-out}',
  '.dsh-pet-toast.is-out{animation:dsh-pet-toast-out .18s ease-in forwards}',
  '.dsh-pet-toast.is-clickable{cursor:pointer}',
  '.dsh-pet-toast-img{width:36px;height:36px;border-radius:8px;object-fit:cover;flex:none}',
  '.dsh-pet-toast-x{flex:none;width:18px;height:18px;border:0;border-radius:6px;background:transparent;' +
    'color:rgba(245,246,248,.55);font-size:14px;line-height:18px;text-align:center;cursor:pointer;padding:0}',
  '.dsh-pet-toast-x:hover{background:rgba(255,255,255,.15);color:#fff}',
  // 计数片：badge 数据的"无宠物宿主"载体。呼吸动画同 badge.ts 的 keyframes 语气，
  // tone 变量同款（含 ADR-002 的数据源离线降灰）。
  '@keyframes dsh-pet-chip-breathe{0%{transform:scale(1)}50%{transform:scale(1.05)}100%{transform:scale(1)}}',
  '.dsh-pet-chip{position:fixed;right:16px;bottom:16px;pointer-events:auto;cursor:pointer;' +
    'display:inline-flex;align-items:center;gap:6px;padding:6px 12px;border-radius:999px;' +
    'background:#e53935;color:#fff;font-size:13px;line-height:1;z-index:8000;' +
    'font-family:var(--dsh-pet-font-family,"ShangshouSoftCandy","Yuanti SC","YouYuan","幼圆","PingFang SC","Microsoft YaHei",sans-serif);' +
    'box-shadow:0 2px 10px rgba(0,0,0,.3);animation:dsh-pet-chip-breathe 2.4s ease-in-out infinite}',
  '.dsh-pet-chip.tone-orange{background:#f57c00}.dsh-pet-chip.tone-green{background:#2e9e4f}.dsh-pet-chip.tone-gray{background:#757575}',
  '@media (prefers-reduced-motion:reduce){.dsh-pet-toast,.dsh-pet-chip{animation:none}}',
].join('\n');

function injectToastCss(): void {
  if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css="dsh-pet/toast"]') === null) {
    const tag = document.createElement('style');
    tag.dataset.plugin = 'dsh-pet';
    tag.dataset.pluginCss = 'dsh-pet/toast';
    tag.textContent = toastCss;
    document.head.appendChild(tag);
  }
}

/** toast 一条的显示时长（ms）：与气泡缺省 10s 同值——事件在两种宿主形态下活一样久 */
const TOAST_DURATION_MS = 10 * 1000;

export interface ToastLayerProps {
  /** 当前列表（seq 递增；手动关闭移出队列） */
  items: ToastItem[];
  /** 手动关闭一条（seq 定位） */
  onClose: (seq: number) => void;
  /** intent 消费器（点击路由，见 consumeIntent） */
  onIntent: (intent: EventIntent | undefined) => void;
}

/**
 * 制造事件 toast 层（工厂）：堆叠容器 + 每条的自动收起计时。
 * 显示时长用 cue.duration（/broadcast 的显式值；0 = 不显示 → 宿主没写这条就该过滤掉），
 * 实际收起取 min(cue.duration, TOAST_DURATION_MS) 防超长 toast 钉死屏幕角落。
 */
export function makeToastLayer(rt: {
  h: typeof jsx;
  useState: <T>(init: T) => [T, Dispatch<SetStateAction<T>>];
  useEffect: (fn: () => void | (() => void), deps: unknown[]) => void;
}): (props: ToastLayerProps) => ReactNode {
  const { h, useEffect, useState } = rt;
  injectToastCss();

  function ToastCard({
    item,
    onGone,
    onIntent,
  }: {
    item: ToastItem;
    onGone: (seq: number) => void;
    onIntent: (intent: EventIntent | undefined) => void;
  }): ReactNode {
    const cue = item.cue;
    // 正在退场（被关闭或时长到了）：先播 out 动画，200ms 后通知父层真删（与动画时长同量级）
    const [out, setOut] = useState(false);
    useEffect(() => {
      const live = cue.duration === undefined ? TOAST_DURATION_MS : Math.min(cue.duration, TOAST_DURATION_MS);
      if (live <= 0) return; // 0 = 不显示：队列层已过滤，防御一下
      const t = setTimeout(() => setOut(true), live);
      return () => clearTimeout(t);
    }, [cue.duration]);
    // out 一翻 → 200ms 后从队列真删（动画 forwards 保持终态，闪不出"复活"）
    useEffect(() => {
      if (!out) return;
      const t = setTimeout(() => onGone(item.seq), 200);
      return () => clearTimeout(t);
    }, [out, item.seq, onGone]);
    const clickable = cue.intent !== undefined;
    return h('div', {
      className: 'dsh-pet-toast' + (out ? ' is-out' : '') + (clickable ? ' is-clickable' : ''),
      onClick: () => {
        if (out) return;
        onIntent(cue.intent); // 点击卡片本体 = 走意图（无 intent 时 no-op）
        setOut(true);
      },
      children: [
        cue.image
          ? h('img', {
              className: 'dsh-pet-toast-img',
              src: '/dsh-pet-7340/pic/memes/main/' + cue.image + '.png',
              alt: '',
            })
          : null,
        cue.url ? h('img', { className: 'dsh-pet-toast-img', src: cue.url, alt: '' }) : null,
        h('span', { style: { flex: '1', wordBreak: 'break-word' }, children: cue.text }),
        h('button', {
          className: 'dsh-pet-toast-x',
          type: 'button',
          'aria-label': 'close',
          onClick: (e: Event) => {
            e.stopPropagation(); // 别触发卡片的 intent 点击
            setOut(true);
          },
          children: '✕',
        }),
      ],
    });
  }

  return function ToastLayer({ items, onClose, onIntent }: ToastLayerProps): ReactNode {
    return h('div', {
      className: 'dsh-pet-toasts',
      children: items
        .filter((it) => it.cue.duration !== 0) // duration=0 = 字面「不显示」
        .map((it) => h(ToastCard, { key: it.seq, item: it, onGone: onClose, onIntent })),
    });
  };
}

/**
 * 制造常驻计数片（工厂）：badge 数据的"无宠物宿主"载体。
 * toast 档位下宠物 DOM 不挂载 → 徽标没地方锚；计数片锚在视口右下角，点击开 badge.href。
 * 与徽标同数据同语义（常驻计数），只是载体不同。
 */
export function makeCountChip(rt: { h: typeof jsx }): (props: { state: BadgeState | null }) => ReactNode {
  const { h } = rt;
  injectToastCss();
  return function CountChip({ state }: { state: BadgeState | null }): ReactNode {
    if (!state || state.count <= 0) return null;
    const text = (state.label ? state.label + ' ' : '') + state.count;
    const tone = state.tone ?? 'red';
    return h('button', {
      type: 'button',
      className: 'dsh-pet-chip' + (tone !== 'red' ? ' tone-' + tone : ''),
      title: state.items && state.items.length ? state.items.join('\n') : text,
      onClick: () => {
        if (state.href) window.open(state.href, '_blank', 'noopener');
      },
      children: text,
    });
  };
}
