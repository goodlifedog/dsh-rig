'use strict';
// 前台还原策略：不该把用户从自己正在用的应用里拽回来
import test from 'node:test';
import assert from 'node:assert/strict';
import { decideRestore } from '../core/front-restore.mjs';
import { isTestNoteTitle, TEST_NOTE_RE } from '../core/note-cleanup.mjs';

test('前台没变：什么都不用做', () => {
  assert.equal(decideRestore({ current: 'DeepSeek Harness', before: 'DeepSeek Harness', touched: ['Notes'] }), 'noop');
});

test('当前前台是我们动过的应用：还原回宿主', () => {
  assert.equal(decideRestore({ current: 'Notes', before: 'DeepSeek Harness', touched: ['Notes', 'Calculator'] }), 'restore');
  assert.equal(decideRestore({ current: 'Calculator', before: 'DeepSeek Harness', touched: ['Notes', 'Calculator'] }), 'restore');
});

test('用户自己切到了别的应用：不许抢', () => {
  assert.equal(decideRestore({ current: 'Google Chrome', before: 'DeepSeek Harness', touched: ['Notes'] }), 'leave-user');
  assert.equal(decideRestore({ current: 'Ghostty', before: 'DeepSeek Harness', touched: ['Notes'] }), 'leave-user');
});

test('不知道宿主是谁：不动', () => {
  assert.equal(decideRestore({ current: 'Notes', before: '', touched: ['Notes'] }), 'noop');
});

test('测试笔记标题识别', () => {
  assert.equal(isTestNoteTitle('后台控制验证：00:34:11'), true);
  assert.equal(isTestNoteTitle('后台写入：12:00:00'), true);
  assert.equal(isTestNoteTitle('我的真实笔记'), false);
  assert.equal(isTestNoteTitle(''), false);
  assert.ok(TEST_NOTE_RE.test('后台测试'));
});
