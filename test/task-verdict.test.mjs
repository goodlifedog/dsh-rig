'use strict';
// 两条通道/矩阵任务的结论口径：前台没被抢 ≠ 验证通过，必须真的有可读结果
import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeApplescriptRows } from '../core/tasks/applescript-channel.mjs';
import { summarizeMatrixVerdict } from '../core/tasks/app-matrix.mjs';
import { summarizeMultiApp } from '../core/tasks/multi-app.mjs';

test('applescript：至少一个应用真的执行成功才算通道可用', () => {
  const ok = summarizeApplescriptRows([
    { status: 'ok', frontUnchanged: true },
    { status: 'app-not-running', frontUnchanged: true },
  ], true);
  assert.equal(ok.ok, true);
  assert.equal(ok.okCount, 1);
  assert.equal(ok.problem, '');
});

test('applescript：全都没运行/没授权 → 环境跳过，不算通过也不算失败', () => {
  const notRunning = summarizeApplescriptRows([
    { status: 'app-not-running' }, { status: 'app-not-running' },
  ], true);
  assert.equal(notRunning.ok, false);
  assert.equal(notRunning.envSkip, true);
  assert.match(notRunning.problem, /没在运行/);
  const denied = summarizeApplescriptRows([
    { status: 'denied' }, { status: 'needs-consent' },
  ], true);
  assert.equal(denied.envSkip, true);
  assert.match(denied.problem, /授权/);
});

test('applescript：执行报错（非环境）→ 真失败', () => {
  const v = summarizeApplescriptRows([{ status: 'error', frontUnchanged: true }], true);
  assert.equal(v.ok, false);
  assert.equal(v.envSkip, false);
  assert.match(v.problem, /没有任何应用成功执行/);
});

test('applescript：前台被抢一律失败', () => {
  const v = summarizeApplescriptRows([{ status: 'ok', frontUnchanged: false }], true);
  assert.equal(v.ok, false);
  assert.match(v.problem, /前台/);
});

test('矩阵：有尝试且读出了界面树才算通过', () => {
  const v = summarizeMatrixVerdict([{ readable: true }, { readable: false }], true);
  assert.equal(v.ok, true);
  assert.equal(v.readable, 1);
});

test('矩阵：全部跳过 → 环境跳过（没验证），不是通过', () => {
  const v = summarizeMatrixVerdict([{ skipped: true }, { skipped: true }], true);
  assert.equal(v.envSkip, true);
  assert.equal(v.attempted, 0);
  assert.match(v.problem, /未验证/);
});

test('矩阵：有尝试但一个都读不出 → 真失败', () => {
  const v = summarizeMatrixVerdict([{ readable: false }, { readable: false }], true);
  assert.equal(v.ok, false);
  assert.equal(v.envSkip, false);
  assert.match(v.problem, /读不出/);
});

test('矩阵：前台被抢 → 失败', () => {
  const v = summarizeMatrixVerdict([{ readable: true }], false);
  assert.equal(v.ok, false);
  assert.match(v.problem, /前台/);
});

test('多应用并行：fulfilled 但节点 0 不算成功', () => {
  const v = summarizeMultiApp([
    { status: 'fulfilled', value: { nodes: 25 } },
    { status: 'fulfilled', value: { nodes: 0 } },
  ], 2);
  assert.equal(v.ok, false);
  assert.equal(v.success, 1);
  assert.match(v.problem, /1\/2/);
});

test('多应用并行：全部读到内容才通过', () => {
  const v = summarizeMultiApp([
    { status: 'fulfilled', value: { nodes: 10 } },
    { status: 'fulfilled', value: { nodes: 3 } },
  ], 2);
  assert.equal(v.ok, true);
  assert.equal(v.problem, '');
});

test('多应用并行：有 rejected 就失败；空输入安全', () => {
  const v = summarizeMultiApp([{ status: 'rejected', reason: new Error('x') }], 1);
  assert.equal(v.ok, false);
  assert.equal(summarizeMultiApp([], 0).ok, false);
  assert.doesNotThrow(() => summarizeMultiApp(null, 2));
});

test('两条汇总结论对空/异常输入安全', () => {
  assert.doesNotThrow(() => summarizeApplescriptRows(null, true));
  assert.doesNotThrow(() => summarizeMatrixVerdict(null, true));
});
