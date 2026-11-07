'use strict';
// 验收任务间的前台还原：只在「当前是测试应用/用户原应用」时才还，用户自己切走的不动。
import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldRestoreFront, TEST_APPS } from '../core/acceptance.mjs';

test('当前是测试应用：应该还给用户', () => {
  assert.equal(shouldRestoreFront('Calculator', 'Google Chrome'), true);
  assert.equal(shouldRestoreFront('Notes', 'Google Chrome'), true);
});

test('当前就是用户原应用：不用动', () => {
  assert.equal(shouldRestoreFront('Google Chrome', 'Google Chrome'), false);
});

test('用户自己切到别处：不抢（leave-user）', () => {
  assert.equal(shouldRestoreFront('Ghostty', 'Google Chrome'), false);
  assert.equal(shouldRestoreFront('com.apple.Terminal', 'Google Chrome'), false);
});

test('缺少起点信息时不还', () => {
  assert.equal(shouldRestoreFront('Calculator', ''), false);
  assert.equal(shouldRestoreFront('', 'Google Chrome'), false);
});

test('测试应用清单包含验收会用到的那些', () => {
  for (const app of ['Calculator', 'Notes', 'TextEdit', 'FastZip', 'iRightMouse']) {
    assert.ok(TEST_APPS.includes(app), app);
  }
});
