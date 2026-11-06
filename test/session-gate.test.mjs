'use strict';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { normalizeDshTitle, matchesTitle } = require('../overlay/session-gate.js');

test('去掉 DSH 标题后缀', () => {
  assert.equal(normalizeDshTitle('规划布局探讨 — DeepSeek Harness'), '规划布局探讨');
  assert.equal(normalizeDshTitle('规划布局探讨 - DeepSeek Harness'), '规划布局探讨');
  assert.equal(normalizeDshTitle('别的窗口标题'), '别的窗口标题');
});

test('没有 titleHint 不门控', () => {
  assert.equal(matchesTitle(null, '规划布局探讨 — DeepSeek Harness'), true);
  assert.equal(matchesTitle('', '任意标题'), true);
});

test('读不到 DSH 标题时不误藏', () => {
  assert.equal(matchesTitle('规划布局探讨', null), true);
  assert.equal(matchesTitle('规划布局探讨', ''), true);
});

test('标题命中才显示', () => {
  const dsh = '规划布局探讨 — DeepSeek Harness';
  assert.equal(matchesTitle('规划布局探讨', dsh), true);
  assert.equal(matchesTitle('另一个会话', dsh), false);
});

test('hint 传完整窗口标题也能匹配', () => {
  // 回归：调用方常把整条窗口标题原样当 titleHint 传进来，
  // 只归一宿主一侧会让匹配永远失败、小窗再也不出现
  const dsh = '规划布局探讨 — DeepSeek Harness';
  assert.equal(matchesTitle('规划布局探讨 — DeepSeek Harness', dsh), true);
  assert.equal(matchesTitle('规划布局探讨 - DeepSeek Harness', dsh), true);
  assert.equal(matchesTitle('  规划布局探讨  ', dsh), true);
  assert.equal(matchesTitle('另一个会话 — DeepSeek Harness', dsh), false);
});
