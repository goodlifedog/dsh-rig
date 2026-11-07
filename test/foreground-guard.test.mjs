'use strict';
// 前台类验收互斥：两个会话同时跑会互相污染报告（实测踩过）
import test from 'node:test';
import assert from 'node:assert/strict';
import { findForeignUiRuns } from '../core/foreground-guard.mjs';

test('识别出别人的 acceptance / bg-verify / 矩阵进程', () => {
  const ps = [
    '100 node /repo/core/acceptance.mjs',
    '200 node /repo/scripts/bg-verify.mjs',
    '300 node /repo/core/tasks/app-matrix.mjs',
    '400 node /repo/core/tasks/background-control.mjs',
    '500 node /repo/core/tasks/background-stability.mjs',
    '600 /usr/bin/grep acceptance.mjs',
    '700 node /repo/core/runner.mjs run ok-task',
  ].join('\n');
  const got = findForeignUiRuns(ps);
  assert.deepEqual(got.map((r) => r.pid), [100, 200, 300, 400, 500], 'grep 和普通任务不算');
});

test('自己的进程不算冲突', () => {
  const ps = '100 node /repo/core/acceptance.mjs\n200 node /repo/scripts/bg-verify.mjs';
  assert.deepEqual(findForeignUiRuns(ps, { selfPids: [100, 200] }), []);
  assert.equal(findForeignUiRuns(ps, { selfPids: [100] }).length, 1);
});

test('空输入/异常输入安全', () => {
  assert.deepEqual(findForeignUiRuns(''), []);
  assert.deepEqual(findForeignUiRuns(null), []);
  assert.deepEqual(findForeignUiRuns('not a ps line'), []);
});

test('超过 200 字符的命令截断（日志不爆炸）', () => {
  const long = 'node ' + '/repo/core/acceptance.mjs --x'.repeat(20);
  const got = findForeignUiRuns('123 ' + long);
  assert.equal(got.length, 1);
  assert.ok(got[0].command.length <= 200);
});
