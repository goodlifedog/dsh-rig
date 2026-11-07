'use strict';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { shouldEvictSession, pickEvictionVictim } = require('../overlay/session-policy.js');

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

// ---------- 会话数到上限时的回收选择 ----------

const SEVEN_MIN = 7 * MIN;

function makeList(count, { idleMs = SEVEN_MIN, startIndex = 0 } = {}) {
  return Array.from({ length: count }, (_, i) => ({
    id: 's' + (startIndex + i),
    lastActivityAt: NOW - idleMs - i * 1000,   // 下标越大越久没活动
    visible: false,
    pinned: false,
  }));
}

test('上限时回收最久没活动的那个', () => {
  const list = makeList(12);
  assert.equal(pickEvictionVictim(list, { now: NOW, protectMs: 60_000 }), 's11');
});

test('最近一分钟内有活动的不回收，挑次旧的', () => {
  const list = makeList(12);
  list[11].lastActivityAt = NOW - 5_000;   // 最新那个其实刚被用过
  assert.equal(pickEvictionVictim(list, { now: NOW, protectMs: 60_000 }), 's10');
});

test('全都在一分钟内活动过：一个都不动，返回 null 让调用方如实报 409', () => {
  const list = Array.from({ length: 12 }, (_, i) => ({ id: 'hot' + i, lastActivityAt: NOW - i * 1000 }));
  assert.equal(pickEvictionVictim(list, { now: NOW, protectMs: 60_000 }), null);
});

test('默认会话、可见、固定/悬停的都不回收', () => {
  const list = [
    { id: 'default', lastActivityAt: NOW - 99 * MIN },
    { id: 'seen', lastActivityAt: NOW - 99 * MIN, visible: true },
    { id: 'pinned', lastActivityAt: NOW - 99 * MIN, pinned: true },
    { id: 'pinned-flag', lastActivityAt: NOW - 99 * MIN, flags: { pinned: true } },
    { id: 'idle', lastActivityAt: NOW - 99 * MIN },
  ];
  assert.equal(pickEvictionVictim(list, { now: NOW, protectMs: MIN }), 'idle');
});

test('protectMs 设 0：退回「只按可见/固定判断」，刚活动过的也能回收', () => {
  const list = [
    { id: 'fresh', lastActivityAt: NOW - 1000 },
    { id: 'older', lastActivityAt: NOW - 2000 },
  ];
  assert.equal(pickEvictionVictim(list, { now: NOW, protectMs: 0 }), 'older');
});

test('没有活动时间时用创建时间兜底；都没有的不参与回收', () => {
  const list = [
    { id: 'no-time' },
    { id: 'created-old', createdAt: NOW - 99 * MIN },
  ];
  assert.equal(pickEvictionVictim(list, { now: NOW, protectMs: MIN }), 'created-old');
});

test('空列表 / 非法输入返回 null，不抛异常', () => {
  assert.equal(pickEvictionVictim([], { now: NOW }), null);
  assert.equal(pickEvictionVictim(null, { now: NOW }), null);
  assert.equal(pickEvictionVictim([null, {}, { id: '' }], { now: NOW }), null);
});
