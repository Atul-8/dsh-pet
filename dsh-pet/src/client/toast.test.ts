// toast 层冒烟（ADR-001 阶段二）：consumeIntent 的路由与降级。
// makeToastLayer/makeCountChip 依赖运行时注入的 react 能力，DOM 渲染不在 node 里测
//（与 pet.ts 同理：src/client 下组件文件的渲染路径由 DSH 真页面承担）；
// 这里测**纯逻辑**：intent 消费的路由（open-url → window.open / open-session → 装配层
// 注入的唤起器 / 取不到 → 降级 focus）。window 用注入桩替身（node 没有 DOM）。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { consumeIntent } from './toast.ts';

/** window 桩：记录 open 调用（open-url 路由的落点断言） */
function stubWindow() {
  const opened: string[] = [];
  const focused: number[] = [];
  (globalThis as Record<string, unknown>).window = {
    open: (url: string) => {
      opened.push(url);
    },
    focus: () => {
      focused.push(1);
    },
  };
  return { opened, focused };
}

describe('consumeIntent —— toast 点击路由（ADR-001 §4.3）', () => {
  test('undefined / 无 type：no-op（点击无意图的 toast = 关掉，别的什么都不发生）', () => {
    const w = stubWindow();
    consumeIntent(undefined, null);
    consumeIntent({ type: 'nonsense' } as unknown as Parameters<typeof consumeIntent>[0], null);
    assert.equal(w.opened.length, 0);
    assert.equal(w.focused.length, 0);
  });

  test('open-url → window.open 新标签（noopener）', () => {
    const w = stubWindow();
    consumeIntent({ type: 'open-url', url: 'https://zoho.com/t/101' }, null);
    assert.deepEqual(w.opened, ['https://zoho.com/t/101']);
    assert.equal(w.focused.length, 0, 'open-url 不该触发降级 focus');
  });

  test('open-session + 唤起器可用 → 调用它（不降级）', () => {
    const w = stubWindow();
    const called: string[] = [];
    consumeIntent({ type: 'open-session', sessionId: 's-42' }, (id) => {
      called.push(id);
      return true;
    });
    assert.deepEqual(called, ['s-42']);
    assert.equal(w.opened.length, 0);
    assert.equal(w.focused.length, 0, '成功唤起就不降级');
  });

  test('open-session 但服务不可用（null / 返回 false）→ 降级 focus 窗口（不静默）', () => {
    const w = stubWindow();
    consumeIntent({ type: 'open-session', sessionId: 's-42' }, null);
    assert.equal(w.focused.length, 1, '降级 = 把 DSH 窗口叫回前台');
    const w2 = stubWindow();
    consumeIntent({ type: 'open-session', sessionId: 's-42' }, () => false);
    assert.equal(w2.focused.length, 1, '唤起器返回 false 也降级');
    assert.equal(w2.opened.length, 0);
  });

  test('缺 url / 缺 sessionId 的残缺 intent：路由不了就 no-op（宿主写端已过滤，防御）', () => {
    const w = stubWindow();
    // 形状上 type 合法但必填缺——宿主 normalizeBroadcastIntent 会丢掉整只 intent；
    // 这里防御的是"绕过宿主直接塞进叶子"的脏数据（老 host / 手写 state）
    consumeIntent({ type: 'open-url' }, null);
    consumeIntent({ type: 'open-session' }, null);
    assert.equal(w.opened.length, 0);
    assert.equal(w.focused.length, 0);
  });
});
