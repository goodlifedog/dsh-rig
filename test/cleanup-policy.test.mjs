'use strict';
// 清理时的「不打扰用户」判定：自己开的自己收；不是本次启动的一律保留（L4b）
import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldQuitApp, shouldRunNoteCleanup } from '../core/cleanup-policy.mjs';

test('本次清理自己拉起的应用：关掉', () => {
  assert.equal(shouldQuitApp({ launchedByUs: true, userActive: true }).quit, true, '自己开的，用户在用也收掉');
  assert.equal(shouldQuitApp({ launchedByUs: true, userActive: false }).quit, true);
  assert.equal(shouldQuitApp({ launchedByUs: true, userActive: false, quitResidual: true }).quit, true);
});

test('不是本次启动、用户正在用：绝不关', () => {
  const r = shouldQuitApp({ launchedByUs: false, userActive: true });
  assert.equal(r.quit, false);
  assert.match(r.reason, /别打扰/);
});

test('不是本次启动、用户已离开：默认也保留（L4b 收紧）', () => {
  const r = shouldQuitApp({ launchedByUs: false, userActive: false });
  assert.equal(r.quit, false, '用户自己开着的应用，离开电脑也不该被清理脚本关掉');
  assert.match(r.reason, /保留/);
  assert.match(r.reason, /CLEANUP_QUIT_RESIDUAL=1/, 'reason 要告诉排障的人怎么恢复旧行为');
});

test('CLEANUP_QUIT_RESIDUAL=1 语义（quitResidual:true）：恢复旧行为，清理非本次启动的残留', () => {
  const r = shouldQuitApp({ launchedByUs: false, userActive: false, quitResidual: true });
  assert.equal(r.quit, true);
  assert.match(r.reason, /CLEANUP_QUIT_RESIDUAL=1/);
  assert.match(r.reason, /残留/);
});

test('quitResidual 只认严格 true，字符串/数字不放行', () => {
  for (const bad of ['1', 'true', 1, 'yes']) {
    const r = shouldQuitApp({ launchedByUs: false, userActive: false, quitResidual: bad });
    assert.equal(r.quit, false, 'quitResidual=' + String(bad));
  }
});

test('用户正在用 + 非本次启动：即使开了 quitResidual 也先按用户在用处理（保留）', () => {
  const r = shouldQuitApp({ launchedByUs: false, userActive: true, quitResidual: true });
  assert.equal(r.quit, false);
  assert.match(r.reason, /别打扰/);
});

test('用户在用电脑时不跑笔记清理（连启动都不该）', () => {
  assert.equal(shouldRunNoteCleanup({ userActive: true }).run, false);
  assert.equal(shouldRunNoteCleanup({ userActive: true, force: true }).run, true, '显式 --force 可以强跑');
  assert.equal(shouldRunNoteCleanup({ userActive: false }).run, true);
});
