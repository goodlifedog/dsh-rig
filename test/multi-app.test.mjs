'use strict';
// multi-app 的纯逻辑测试：该不该探测、并行结果怎么判。
// 重点锁住 2026-11-08 那次事故：对没运行的应用调用 ocu.snapshot 会把它拉起并顶到前台。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  shouldProbeApp,
  summarizeMultiApp,
  SKIP_NOT_RUNNING_REASON,
} from '../core/tasks/multi-app.mjs';

test('shouldProbeApp：确定在运行才允许探测', () => {
  const decision = shouldProbeApp({ running: true });
  assert.equal(decision.probe, true);
  assert.equal(decision.reason, '');
});

test('shouldProbeApp：没在运行就跳过，理由写清「不启动不激活」', () => {
  const decision = shouldProbeApp({ running: false });
  assert.equal(decision.probe, false);
  assert.equal(decision.reason, SKIP_NOT_RUNNING_REASON);
  assert.match(decision.reason, /没在运行/);
  assert.match(decision.reason, /启动/);
  assert.match(decision.reason, /前台/);
});

test('shouldProbeApp：拿不到运行状态时按「不在运行」处理（宁可跳过也不误启动）', () => {
  assert.equal(shouldProbeApp({}).probe, false);
  assert.equal(shouldProbeApp(null).probe, false);
  assert.equal(shouldProbeApp(undefined).probe, false);
});

test('summarizeMultiApp：跳过不计入失败，在运行的都读到内容就算通过', () => {
  const v = summarizeMultiApp([
    { status: 'skipped', value: { app: 'Calculator', nodes: 0, reason: SKIP_NOT_RUNNING_REASON } },
    { status: 'fulfilled', value: { app: 'Finder', nodes: 108 } },
  ], 2);
  assert.equal(v.ok, true);
  assert.equal(v.envSkip, false);
  assert.equal(v.success, 1);
  assert.equal(v.skipped, 1);
  assert.equal(v.graded, 1);
  assert.equal(v.problem, '');
});

test('summarizeMultiApp：全部没在运行 → envSkip，不算成功也不误报失败', () => {
  const v = summarizeMultiApp([
    { status: 'skipped', value: { app: 'Finder', nodes: 0 } },
    { status: 'skipped', value: { app: 'Calculator', nodes: 0 } },
  ], 2);
  assert.equal(v.ok, false);
  assert.equal(v.envSkip, true);
  assert.equal(v.success, 0);
  assert.equal(v.skipped, 2);
  assert.equal(v.graded, 0);
  assert.match(v.problem, /环境跳过/);
});

test('summarizeMultiApp：既有行为不回归（节点 0 / rejected / 空输入 / null）', () => {
  const zero = summarizeMultiApp([
    { status: 'fulfilled', value: { nodes: 25 } },
    { status: 'fulfilled', value: { nodes: 0 } },
  ], 2);
  assert.equal(zero.ok, false);
  assert.equal(zero.success, 1);
  assert.match(zero.problem, /1\/2/);

  assert.equal(summarizeMultiApp([{ status: 'rejected', reason: new Error('x') }], 1).ok, false);
  assert.equal(summarizeMultiApp([], 0).ok, false);
  assert.doesNotThrow(() => summarizeMultiApp(null, 2));
});
