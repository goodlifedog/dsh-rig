'use strict';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { shouldEvictSession } = require('../overlay/session-policy.js');

const MIN = 60 * 1000;
const NOW = 1_700_000_000_000;

test('闲置超过 TTL 的会话应被回收', () => {
  assert.equal(shouldEvictSession({ lastActivityAt: NOW - 31 * MIN }, NOW, 30 * MIN), true);
});

test('刚活动过的不回收', () => {
  assert.equal(shouldEvictSession({ lastActivityAt: NOW - 5 * MIN }, NOW, 30 * MIN), false);
});

test('固定显示 / 放大 / 可见 / 悬停 都不回收', () => {
  const old = { lastActivityAt: NOW - 60 * MIN };
  assert.equal(shouldEvictSession({ ...old, pinned: true }, NOW, 30 * MIN), false);
  assert.equal(shouldEvictSession({ ...old, expanded: true }, NOW, 30 * MIN), false);
  assert.equal(shouldEvictSession({ ...old, visible: true }, NOW, 30 * MIN), false);
  assert.equal(shouldEvictSession({ ...old, hovering: true }, NOW, 30 * MIN), false);
});

test('TTL 设 0 表示关闭回收', () => {
  assert.equal(shouldEvictSession({ lastActivityAt: NOW - 999 * MIN }, NOW, 0), false);
});

test('没有活动时间时用创建时间兜底', () => {
  assert.equal(shouldEvictSession({ createdAt: NOW - 31 * MIN }, NOW, 30 * MIN), true);
});

test('异常输入不误删', () => {
  assert.equal(shouldEvictSession(null, NOW, 30 * MIN), false);
  assert.equal(shouldEvictSession({}, NOW, 30 * MIN), false);
  assert.equal(shouldEvictSession({ lastActivityAt: NOW }, NOW, NaN), false);
});
