'use strict';
// P0 批次D #11：并行演示在碰任何 raw ocu 调用之前，必须跳过「没在运行」的应用
// （ocu 的 get_app_state 会把没运行的应用启动起来并带出窗口）
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEMO_TARGETS, pickRunningTargets } from '../core/tasks/parallel-real-demo.mjs';

test('目标清单只含计算器/文本编辑，且带 appName/processName 供 isAppRunning 判定', () => {
  assert.deepEqual(DEMO_TARGETS.map((t) => t.app), ['计算器', '文本编辑']);
  for (const target of DEMO_TARGETS) {
    assert.ok(target.appName, target.app + ' 缺少 appName');
    assert.ok(target.processName, target.app + ' 缺少 processName');
  }
});

test('两个应用都在运行：都要跑，不跳过', () => {
  const picked = pickRunningTargets(DEMO_TARGETS, new Set(['计算器', '文本编辑']));
  assert.deepEqual(picked.run.map((t) => t.app), ['计算器', '文本编辑']);
  assert.deepEqual(picked.skipped, []);
});

test('两个都没运行：全部跳过（调用方据此 exit 0，不启动任何应用）', () => {
  const picked = pickRunningTargets(DEMO_TARGETS, new Set());
  assert.deepEqual(picked.run, []);
  assert.deepEqual(picked.skipped.map((t) => t.app), ['计算器', '文本编辑']);
});

test('只有一个在运行：只跑在运行的那个，另一个标为跳过', () => {
  const picked = pickRunningTargets(DEMO_TARGETS, ['文本编辑']);
  assert.deepEqual(picked.run.map((t) => t.app), ['文本编辑']);
  assert.deepEqual(picked.skipped.map((t) => t.app), ['计算器']);
});

test('不在清单里的运行项不会被误当成目标', () => {
  const picked = pickRunningTargets(DEMO_TARGETS, ['Safari', 'Calculator']);
  assert.deepEqual(picked.run, [], '运行集合里是别的应用名，目标不算在运行');
  assert.equal(picked.skipped.length, 2);
});

test('空/未定义集合时全部跳过，不抛异常', () => {
  assert.deepEqual(pickRunningTargets(DEMO_TARGETS, undefined).run, []);
  assert.deepEqual(pickRunningTargets(DEMO_TARGETS, null).skipped.length, 2);
  assert.deepEqual(pickRunningTargets([], new Set()).run, []);
});
