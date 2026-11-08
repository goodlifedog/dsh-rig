'use strict';
// 用户正在操作时，动他应用内容的后台任务要主动让路
import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldDeferForActiveUser, ACTIVE_USER_MS } from '../core/user-activity.mjs';

test('刚动过键鼠：让路（并说明原因）', () => {
  const r = shouldDeferForActiveUser(300);
  assert.equal(r.defer, true);
  assert.match(r.reason, /正在操作电脑/);
});

test('空闲足够久：不拦', () => {
  assert.equal(shouldDeferForActiveUser(ACTIVE_USER_MS + 1000).defer, false);
});

test('读不到空闲时间：不拦（不能因为读不到就全都不跑）', () => {
  assert.equal(shouldDeferForActiveUser(-1).defer, false);
  assert.equal(shouldDeferForActiveUser(NaN).defer, false);
});

test('阈值可调', () => {
  assert.equal(shouldDeferForActiveUser(8000, { thresholdMs: 10000 }).defer, true);
  assert.equal(shouldDeferForActiveUser(8000, { thresholdMs: 5000 }).defer, false);
});
