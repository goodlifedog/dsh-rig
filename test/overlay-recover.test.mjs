'use strict';
// 抓帧目标恢复：窗口重开后能自动找回同一个应用的新窗口
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { pickReplacementWindow } = require('../overlay/recover.js');

const W = (id, owner, title) => ({ windowId: id, owner, title });

test('同 owner 的新窗口优先（窗口重开 windowId 变了）', () => {
  const windows = [W(2, 'Notes', '备忘录'), W(3, 'Google Chrome', '标签')];
  const hit = pickReplacementWindow(windows, { windowId: 1, owner: 'Notes', title: '备忘录' });
  assert.equal(hit.windowId, 2);
});

test('owner 相同但标题变了也能找回', () => {
  const hit = pickReplacementWindow([W(5, 'Notes', '新笔记')], { windowId: 1, owner: 'Notes', title: '旧标题' });
  assert.equal(hit.windowId, 5);
});

test('排除自身窗口和旧窗口', () => {
  const windows = [W(1, 'Notes', '备忘录'), W(2, 'Notes', '备忘录'), W(9, 'Notes', '备忘录')];
  const hit = pickReplacementWindow(windows, { windowId: 1, owner: 'Notes', title: '备忘录' }, { excludeIds: new Set([1]), selfIds: new Set([9]) });
  assert.equal(hit.windowId, 2);
});

test('并列（两个同名窗口）时不盲选，返回 null', () => {
  const windows = [W(201, '备忘录', '备忘录'), W(202, '备忘录', '备忘录')];
  assert.equal(pickReplacementWindow(windows, { windowId: 199, owner: '备忘录', title: '备忘录' }), null);
});

test('并列但有旧 windowId 偏好时按它选（不算歧义）', () => {
  const windows = [W(201, '备忘录', '备忘录'), W(202, '备忘录', '备忘录')];
  const hit = pickReplacementWindow(windows, { windowId: 202, owner: '备忘录', title: '备忘录' });
  assert.equal(hit.windowId, 202);
});

test('没有任何匹配时返回 null（交给解绑，而不是乱绑别的窗口）', () => {
  assert.equal(pickReplacementWindow([W(3, 'Google Chrome', 'x')], { windowId: 1, owner: 'Notes', title: 'y' }), null);
  assert.equal(pickReplacementWindow([], { owner: 'Notes' }), null);
  assert.equal(pickReplacementWindow([W(3, 'Notes', 'x')], null), null);
});
