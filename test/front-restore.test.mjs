'use strict';
// 前台还原决策：大小写不敏感 + 候选别名（本地化名 vs 进程名）
import test from 'node:test';
import assert from 'node:assert/strict';
import { decideRestore, normalizeFrontName } from '../core/front-restore.mjs';

test('大小写不敏感：Calculator vs calculator 不再误判 leave-user', () => {
  assert.equal(decideRestore({ current: 'Calculator', before: 'DeepSeek Harness', touched: ['计算器', 'calculator'] }), 'restore');
  assert.equal(decideRestore({ current: 'calculator', before: 'DeepSeek Harness', touched: ['计算器', 'Calculator'] }), 'restore');
  assert.equal(decideRestore({ current: 'Notes', before: 'DeepSeek Harness', touched: ['备忘录', 'notes'] }), 'restore');
});

test('候选别名：相等或互相包含（小写比较）都算我们动过的应用', () => {
  assert.equal(decideRestore({ current: 'Calculator', before: 'DeepSeek Harness', touched: ['Calculator'] }), 'restore');
  assert.equal(decideRestore({ current: 'Calculator', before: 'DeepSeek Harness', touched: ['calc'] }), 'restore');
  assert.equal(decideRestore({ current: 'Clash Verge', before: 'DeepSeek Harness', touched: ['clash-verge'] }), 'restore');
  assert.equal(decideRestore({ current: 'WPS Office', before: 'DeepSeek Harness', touched: ['wpsoffice'] }), 'restore');
});

test('宿主名大小写不同也算已还原（noop）', () => {
  assert.equal(decideRestore({ current: 'deepseek harness', before: 'DeepSeek Harness', touched: ['Notes'] }), 'noop');
});

test('用户切到无关应用：大小写不敏感也不能误伤', () => {
  assert.equal(decideRestore({ current: 'Google Chrome', before: 'DeepSeek Harness', touched: ['计算器', 'calculator'] }), 'leave-user');
  assert.equal(decideRestore({ current: 'Ghostty', before: 'DeepSeek Harness', touched: ['计算器', 'calculator'] }), 'leave-user');
});

test('前台读不到 / 不知道宿主：不动（noop）', () => {
  assert.equal(decideRestore({ current: '', before: 'DeepSeek Harness', touched: ['Calculator'] }), 'noop');
  assert.equal(decideRestore({ current: 'Notes', before: '', touched: ['Notes'] }), 'noop');
});

test('M-2 证据场景：touched 只有本地化名+英文小写，前台是进程名 Calculator', () => {
  // reports/app-matrix-2026-11-08T08-09-42-935Z.json：frontStart=DeepSeek Harness、frontEnd=Calculator
  const touchedAll = ['计算器', 'calculator', 'FastZip', 'cn.better365.FastZip'.split('.').pop()];
  assert.equal(decideRestore({ current: 'Calculator', before: 'DeepSeek Harness', touched: touchedAll }), 'restore');
});

test('normalizeFrontName：小写 + 去首尾空白 + 去分隔符', () => {
  assert.equal(normalizeFrontName('  Calculator '), 'calculator');
  assert.equal(normalizeFrontName('Clash Verge'), 'clashverge');
  assert.equal(normalizeFrontName('clash-verge'), 'clashverge');
  assert.equal(normalizeFrontName('WPS Office'), 'wpsoffice');
  assert.equal(normalizeFrontName(null), '');
});