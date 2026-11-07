'use strict';
// 清理时的「不打扰用户」判定：自己开的自己收，用户在用就别动
import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldQuitApp, shouldRunNoteCleanup } from '../core/cleanup-policy.mjs';

test('本次清理自己拉起的应用：关掉', () => {
  assert.equal(shouldQuitApp({ launchedByUs: true, userActive: true }).quit, true, '自己开的，用户在用也收掉');
  assert.equal(shouldQuitApp({ launchedByUs: true, userActive: false }).quit, true);
});

test('不是本次启动、用户正在用：绝不关', () => {
  const r = shouldQuitApp({ launchedByUs: false, userActive: true });
  assert.equal(r.quit, false);
  assert.match(r.reason, /别打扰/);
});

test('不是本次启动、用户已离开：可以清理残留', () => {
  const r = shouldQuitApp({ launchedByUs: false, userActive: false });
  assert.equal(r.quit, true);
  assert.match(r.reason, /残留/);
});

test('用户在用电脑时不跑笔记清理（连启动都不该）', () => {
  assert.equal(shouldRunNoteCleanup({ userActive: true }).run, false);
  assert.equal(shouldRunNoteCleanup({ userActive: true, force: true }).run, true, '显式 --force 可以强跑');
  assert.equal(shouldRunNoteCleanup({ userActive: false }).run, true);
});
