// 宠物「调整大小」滑杆浮层（src/shared，浏览器 bundle 先接入；桌面 sprite 可复用同款）。
// 与 menu.ts / chat.ts 同类的「两端共用同一份 DOM」例外：样式常量 + 挂载函数一份实现。
//
// 交互语义（右键菜单「调整大小」→ 本浮层）：
//   - 滑杆拖动 → onPreview 实时回调（调用方只改本地渲染 state，**不落盘**——宠物当场变大变小）；
//   - 「确认」→ 组件内部 POST /pet-size 写配置（与 mountChatDialog 内部 sendChat 同一模式：
//     共享组件自带保存逻辑，调用方不用重复一份）；成功 → 关闭 + onSaved(聚合配置)；失败 →
//     就地显示错误、浮层保留（用户可重试或取消）；
//   - 取消 / Esc / 点外关闭 → onCancel 回调（调用方把尺寸恢复到打开时的原值）。
// 预览与落盘分离的原因：拖动过程每帧都写盘既慢又容易把 JSONC 写坏，确认才是一次真正的保存。
//
// 浮层定位：调用方传宠物附近坐标（建议取身体命中区右上角，与对话弹窗同源），自动夹回视口。

import { PET_SIZE_MAX, PET_SIZE_MIN } from './types';

/** 滑杆步长：细到肉眼平滑，又不至于一拖就跳几十像素 */
const STEP = 2;

/** POST /dsh-pet-7340/pet-size {id,size} 的回执：业务失败 = HTTP 200 + {ok:false,reason,message}（与 pet-display 同口径） */
export type PetSizeState =
  | { ok: true; aggregate: Record<string, Record<string, unknown>> }
  | {
      ok: false;
      reason: 'pet-required' | 'bad-size' | 'unknown-pet' | 'bad-request' | 'generate-error';
      message?: string;
    };

const SAVE_TIMEOUT_MS = 15_000;

/** 保存一只宠物的大小（写用户配置层）。网络/解析失败显式抛错（调用方决定报错方式）。 */
export async function savePetSize(baseUrl: string, petId: string, size: number): Promise<PetSizeState> {
  const res = await fetch(baseUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: petId, size }),
    signal: AbortSignal.timeout(SAVE_TIMEOUT_MS),
  });
  const raw: unknown = await res.json().catch(() => null);
  if (!raw || typeof raw !== 'object') throw new Error('dsh-pet: 调整大小响应非法');
  const o = raw as Record<string, unknown>;
  if (o.ok === false) {
    return {
      ok: false,
      reason:
        o.reason === 'pet-required' ||
        o.reason === 'unknown-pet' ||
        o.reason === 'generate-error' ||
        o.reason === 'bad-request'
          ? o.reason
          : 'bad-size',
      message: typeof o.message === 'string' ? o.message : undefined,
    };
  }
  // 成功：响应体 = 改动后的成品聚合（与 pet-display / PUT config 同形），直接交给调用方 reload
  return { ok: true, aggregate: (raw as Record<string, Record<string, unknown>>) ?? {} };
}

/** 浮层样式 —— 与 chat 弹窗同一套视觉语言（同字体/同圆角/同阴影），两端一致 */
export const SIZE_CSS = [
  '.dsh-pet-size{position:fixed;z-index:2147483001;width:230px;max-width:80vw;',
  'background:rgba(255,255,255,.98);border:1px solid rgba(0,0,0,.12);border-radius:10px;',
  'box-shadow:0 10px 32px rgba(0,0,0,.22);color:#2b2b2b;font-size:14px;line-height:1.5;',
  "font-family:var(--dsh-pet-font-family,'ShangshouSoftCandy','Yuanti SC','YouYuan','幼圆','Comic Sans MS','PingFang SC','Microsoft YaHei',sans-serif);",
  'user-select:none;padding:10px 12px 11px}',
  '.dsh-pet-size *{box-sizing:border-box}',
  '.dsh-pet-size-row{display:flex;align-items:baseline;justify-content:space-between;margin-bottom:7px}',
  '.dsh-pet-size-title{font-size:13px;color:rgba(43,43,43,.75)}',
  '.dsh-pet-size-value{font-size:15px;font-weight:600;font-variant-numeric:tabular-nums;color:#2b2b2b}',
  '.dsh-pet-size input[type=range]{display:block;width:100%;height:22px;margin:0 0 4px;cursor:pointer;accent-color:#e0649a;background:transparent}',
  '.dsh-pet-size-scale{display:flex;justify-content:space-between;font-size:11px;color:rgba(43,43,43,.45);margin-bottom:8px;font-variant-numeric:tabular-nums}',
  '.dsh-pet-size-hint{font-size:11px;color:rgba(43,43,43,.55);margin-bottom:8px}',
  '.dsh-pet-size-btns{display:flex;gap:8px;justify-content:flex-end}',
  '.dsh-pet-size-btn{border:1px solid rgba(0,0,0,.14);border-radius:7px;padding:3px 14px;font-size:13px;',
  'font-family:inherit;background:#fff;color:#2b2b2b;cursor:pointer}',
  '.dsh-pet-size-btn:hover{background:rgba(0,0,0,.05)}',
  '.dsh-pet-size-btn.is-primary{background:#e0649a;border-color:#e0649a;color:#fff}',
  '.dsh-pet-size-btn.is-primary:hover{background:#d55a8c}',
  '.dsh-pet-size-btn:disabled{opacity:.5;cursor:default}',
  '.dsh-pet-size-err{color:#d94f3d;font-size:12px;margin-top:6px;white-space:pre-wrap;overflow-wrap:anywhere}',
].join('');

let sizeCssInjected = false;
function injectSizeCss(): void {
  if (sizeCssInjected || typeof document === 'undefined') return;
  sizeCssInjected = true;
  const tag = document.createElement('style');
  tag.dataset.plugin = 'dsh-pet';
  tag.dataset.pluginCss = 'dsh-pet/size';
  tag.textContent = SIZE_CSS;
  document.head.appendChild(tag);
}

export interface SizeDialogHandle {
  /** 关闭浮层：未确认（含取消/Esc/点外/外部调用）都会触发 onCancel——调用方据此恢复原尺寸 */
  close: () => void;
}

/**
 * 挂载「调整大小」浮层。
 *
 * @param opts.current    打开时的宠物尺寸（滑杆初值，也是取消时的恢复值）
 * @param opts.x / opts.y 浮层出现坐标（宠物附近；自动夹回视口）
 * @param opts.baseUrl    保存端点完整 URL（如 /dsh-pet-7340/pet-size）
 * @param opts.petId      要改尺寸的宠物 id
 * @param opts.onPreview  滑杆拖动实时预览（调用方改本地 state，不落盘）
 * @param opts.onSaved    保存成功（参数 = 服务端返回的成品聚合 + 最终尺寸）：调用方交给 petBridge.reload
 * @param opts.onCancel   未确认就关闭（取消/Esc/点外）：调用方恢复 original size
 */
export function mountSizeDialog(opts: {
  current: number;
  x: number;
  y: number;
  baseUrl: string;
  petId: string;
  onPreview: (size: number) => void;
  onSaved: (aggregate: Record<string, Record<string, unknown>>, size: number) => void;
  onCancel?: () => void;
}): SizeDialogHandle {
  injectSizeCss();

  const root = document.createElement('div');
  root.className = 'dsh-pet-size';

  const row = document.createElement('div');
  row.className = 'dsh-pet-size-row';
  const title = document.createElement('span');
  title.className = 'dsh-pet-size-title';
  title.textContent = '调整大小';
  const value = document.createElement('span');
  value.className = 'dsh-pet-size-value';
  value.textContent = Math.round(opts.current) + ' px';
  row.append(title, value);

  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = String(PET_SIZE_MIN);
  slider.max = String(PET_SIZE_MAX);
  slider.step = String(STEP);
  slider.value = String(Math.min(PET_SIZE_MAX, Math.max(PET_SIZE_MIN, Math.round(opts.current))));

  const scale = document.createElement('div');
  scale.className = 'dsh-pet-size-scale';
  const scaleMin = document.createElement('span');
  scaleMin.textContent = String(PET_SIZE_MIN);
  const scaleMax = document.createElement('span');
  scaleMax.textContent = String(PET_SIZE_MAX);
  scale.append(scaleMin, scaleMax);

  const hint = document.createElement('div');
  hint.className = 'dsh-pet-size-hint';
  hint.textContent = '拖动实时预览；确认后写入配置，下次启动自动生效';

  const btns = document.createElement('div');
  btns.className = 'dsh-pet-size-btns';
  const btnCancel = document.createElement('button');
  btnCancel.type = 'button';
  btnCancel.className = 'dsh-pet-size-btn';
  btnCancel.textContent = '取消';
  const btnOk = document.createElement('button');
  btnOk.type = 'button';
  btnOk.className = 'dsh-pet-size-btn is-primary';
  btnOk.textContent = '确认';
  btns.append(btnCancel, btnOk);

  const err = document.createElement('div');
  err.className = 'dsh-pet-size-err';
  err.style.display = 'none';

  root.append(row, slider, scale, hint, btns, err);

  // 定位：调用方给的坐标是「期望的左上角」，超出视口自动夹回（宽 232 高约 170 的余量估算）
  const W = 232;
  const H = 175;
  const left = Math.max(8, Math.min(opts.x, window.innerWidth - W - 8));
  const top = Math.max(8, Math.min(opts.y, window.innerHeight - H - 8));
  root.style.left = left + 'px';
  root.style.top = top + 'px';

  document.body.appendChild(root);

  let closed = false;
  let confirmed = false; // 已走上保存路径：后续关闭不算「取消」
  const close = (): void => {
    if (closed) return;
    closed = true;
    document.removeEventListener('mousedown', onDocPointerDown, true);
    document.removeEventListener('keydown', onDocKeyDown, true);
    root.remove();
    if (!confirmed && opts.onCancel) opts.onCancel();
  };

  const currentSize = (): number => Number(slider.value);

  slider.addEventListener('input', () => {
    const n = currentSize();
    value.textContent = n + ' px';
    opts.onPreview(n);
  });

  const doConfirm = (): void => {
    if (closed || confirmed) return;
    confirmed = true;
    err.style.display = 'none';
    btnOk.disabled = true;
    btnCancel.disabled = true;
    savePetSize(opts.baseUrl, opts.petId, currentSize())
      .then((state) => {
        if (state.ok) {
          // 成功才关浮层；确认路径 close() 不再触发 onCancel（confirmed 已置位）
          if (opts.onSaved) opts.onSaved(state.aggregate, currentSize());
          close();
        } else {
          // 业务失败：浮层保留、就地报错、解锁按钮（重试或取消都行）
          confirmed = false;
          err.textContent = '保存失败：' + (state.message ?? state.reason);
          err.style.display = 'block';
          btnOk.disabled = false;
          btnCancel.disabled = false;
          slider.focus();
        }
      })
      .catch((e: unknown) => {
        // 网络/超时/响应非法：同样保留浮层就地报错
        confirmed = false;
        err.textContent = '保存异常：' + String(e && (e as Error).message ? (e as Error).message : e);
        err.style.display = 'block';
        btnOk.disabled = false;
        btnCancel.disabled = false;
        slider.focus();
      });
  };
  btnOk.addEventListener('click', doConfirm);
  btnCancel.addEventListener('click', close);

  // 点浮层外关闭（取消语义）；点浮层内部不算
  const onDocPointerDown = (e: MouseEvent): void => {
    if (closed) return;
    if (root.contains(e.target as Node)) return;
    close();
  };
  // Esc 关闭（取消语义）；滑杆聚焦时方向键仍可微调（方向键不是 Esc，互不打架）
  const onDocKeyDown = (e: KeyboardEvent): void => {
    if (closed) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  };
  document.addEventListener('mousedown', onDocPointerDown, true);
  document.addEventListener('keydown', onDocKeyDown, true);

  // Enter = 确认（滑杆聚焦时的自然键盘路径）
  root.addEventListener('keydown', (e) => {
    if (closed || confirmed) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      doConfirm();
    }
  });

  requestAnimationFrame(() => slider.focus());

  return { close };
}
