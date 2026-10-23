// 「显示位置」子菜单（displayMenuBranch）单测 + 两侧接线守卫。
// 被测：host 参数（桌面/浏览器视角）下的标签矩阵与取值恒定；以及 sprite.js / pet.ts
// 是否各自传对了视角（读源码断言——同 storage-paths.test.ts 校验 main.js 的手法，
// runtime JS 无构建产物可比对，就钉住调用点本身，改了不同步就红）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { displayMenuBranch, type MenuLeaf } from './menu';

const here = dirname(fileURLToPath(import.meta.url));
const runtimeSprite = join(here, '../../runtime/electron-helper/sprite.js');
const clientPet = join(here, '../client/pet.ts');

const leafsOf = (branch: ReturnType<typeof displayMenuBranch>): MenuLeaf[] =>
  branch.children.filter((n): n is MenuLeaf => !('children' in n));

test('浏览器视角（缺省）：四项 = 仅网页/仅桌面/两者/都不（原文案不变）', () => {
  const items = leafsOf(displayMenuBranch());
  assert.deepEqual(
    items.map((i) => i.label),
    ['仅网页', '仅桌面', '两者', '都不'],
  );
  assert.deepEqual(
    items.map((i) => i.display),
    ['web', 'desktop', 'both', 'none'],
  );
  assert.ok(items.every((i) => i.action === 'set-display'));
});

test('桌面视角：web 档改叫「隐藏」，取值与其余三项与浏览器端完全一致（不漂移）', () => {
  const desk = leafsOf(displayMenuBranch('desktop'));
  const web = leafsOf(displayMenuBranch('web'));
  assert.deepEqual(
    desk.map((i) => i.label),
    ['隐藏', '仅桌面', '两者', '都不'],
  );
  // 取值是唯一契约：两端 actions/displays 逐项相等（文案可以随视角，取值绝不能漂）
  assert.deepEqual(
    desk.map((i) => [i.action, i.display]),
    web.map((i) => [i.action, i.display]),
  );
});

test('接线守卫：sprite.js 传 desktop 视角、pet.ts 传 web 视角（改了不同步就红）', () => {
  const sprite = readFileSync(runtimeSprite, 'utf8');
  const pet = readFileSync(clientPet, 'utf8');
  // 桌面端：S.displayMenuBranch('desktop')——视角传错会把「隐藏」错渲染成「仅网页」
  assert.match(sprite, /S\.displayMenuBranch\('desktop'\)/, 'sprite.js 必须显式传 desktop 视角');
  assert.doesNotMatch(sprite, /S\.displayMenuBranch\(\)\s*,/, 'sprite.js 不许无参调用（缺省=web 视角）');
  // 浏览器端：displayMenuBranch('web')——显式优于隐式（本端 web 档字面准确）
  assert.match(pet, /displayMenuBranch\('web'\)/, 'pet.ts 必须显式传 web 视角');
});
