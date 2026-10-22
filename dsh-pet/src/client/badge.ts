// 常驻计数徽标（client 半侧）：宠物头顶的常驻徽标，展示外部投喂的数字。
// 与数据源解耦：组件只知道 { count, label?, href?, tone?, items? }，不知道 Zoho / 油猴——任何数据源都能往这里投。
// 与瞬时气泡（余额/碎碎念）不同：它**常驻**（只要 count > 0 就一直显示，不设自动收起）。
import type { ReactNode } from 'react';
import type { jsx } from 'react/jsx-runtime';
import type { BadgeState } from '../shared/state';

/** 徽标内联样式：小药丸，锚在宠物头顶（比气泡再高一点，两者可共存）。
 *  字号锚在 `--f`（= 气泡正文字号），随宠物大小/字号配置同步缩放。
 *  颜色按 tone 分档（默认红）；有 href 时显示手型光标、可点击打开。
 *  **缓慢呼吸**（count>0 常驻时）：~2.4s 周期 scale 1→1.06 + 同色光环扩散（--tone-ring 随
 *  tone 变色），足够吸引注意又不刺眼；prefers-reduced-motion 时静止。 */
const badgeCss = [
  '@keyframes dsh-pet-badge-breathe{0%{transform:translateX(-50%) scale(1);box-shadow:0 calc(var(--f)*0.2) calc(var(--f)*0.77) rgba(0,0,0,.22),0 0 0 0 var(--tone-ring,rgba(229,57,53,.35))}' +
    '50%{transform:translateX(-50%) scale(1.06);box-shadow:0 calc(var(--f)*0.2) calc(var(--f)*0.9) rgba(0,0,0,.25),0 0 0 calc(var(--f)*0.55) var(--tone-ring,rgba(229,57,53,.25))}' +
    '100%{transform:translateX(-50%) scale(1);box-shadow:0 calc(var(--f)*0.2) calc(var(--f)*0.77) rgba(0,0,0,.22),0 0 0 0 var(--tone-ring,rgba(229,57,53,.35))}}',
  '.dsh-pet-badge{position:absolute;left:50%;transform:translateX(-50%);' +
    'bottom:calc(100% - var(--dsh-pet-size)*0.075);' +
    'display:inline-flex;align-items:center;gap:calc(var(--f)*0.35);' +
    'padding:calc(var(--f)*0.22) calc(var(--f)*0.66);' +
    'background:#e53935;color:#fff;border-radius:999px;' +
    'font-family:var(--dsh-pet-font-family,"ShangshouSoftCandy","Yuanti SC","YouYuan","幼圆","PingFang SC","Microsoft YaHei",sans-serif);' +
    'font-size:calc(var(--f)*0.9);line-height:1;' +
    '--f:var(--dsh-pet-font-bubble,calc(var(--dsh-pet-size)*0.0455));' +
    '--tone-ring:rgba(229,57,53,.35);' +
    'z-index:5;pointer-events:none;white-space:nowrap;' +
    'animation:dsh-pet-badge-breathe 2.4s ease-in-out infinite;' +
    'box-shadow:0 calc(var(--f)*0.2) calc(var(--f)*0.77) rgba(0,0,0,.22)}',
  '@media (prefers-reduced-motion:reduce){.dsh-pet-badge{animation:none}}',
  '.dsh-pet-badge.tone-orange{background:#f57c00;--tone-ring:rgba(245,124,0,.35)}',
  '.dsh-pet-badge.tone-green{background:#2e9e4f;--tone-ring:rgba(46,158,79,.35)}',
  '.dsh-pet-badge.tone-gray{background:#757575;--tone-ring:rgba(117,117,117,.3)}',
  '.dsh-pet-badge.is-link{cursor:pointer}',
].join('\n');

/** 只注入一次 */
function injectBadgeCss(): void {
  if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css="dsh-pet/badge"]') === null) {
    const tag = document.createElement('style');
    tag.dataset.plugin = 'dsh-pet';
    tag.dataset.pluginCss = 'dsh-pet/badge';
    tag.textContent = badgeCss;
    document.head.appendChild(tag);
  }
}

/**
 * 制造常驻计数徽标（工厂）。
 * 组件为哑组件，props = { state }。count = 0（或没有数据）时不渲染任何节点。
 * 显示 = `label + ' ' + count`（无 label 时只显示 count）；tone 决定颜色；
 * href 存在时点击新开标签页；items 存在时悬停显示详情。
 */
export function makeBadge(rt: { h: typeof jsx }): (props: { state: BadgeState | null }) => ReactNode {
  const { h } = rt;
  injectBadgeCss();

  return function Badge({ state }: { state: BadgeState | null }) {
    if (!state || state.count <= 0) return null;
    const text = (state.label ? state.label + ' ' : '') + state.count;
    const interactive = Boolean(state.href || (state.items && state.items.length));
    return h('div', {
      className: 'dsh-pet-badge tone-' + (state.tone ?? 'red') + (state.href ? ' is-link' : ''),
      title: state.items && state.items.length ? state.items.join('\n') : undefined,
      style: interactive ? { pointerEvents: 'auto' } : undefined,
      onClick: state.href
        ? () => {
            window.open(state.href as string, '_blank', 'noopener');
          }
        : undefined,
      children: text,
    });
  };
}
