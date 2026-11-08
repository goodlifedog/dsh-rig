'use strict';
// P0（审计 #1）回归：user-active-demo 的候选应用必须先探测"在运行"才允许读/点，
// 一个都没运行就环境跳过，绝不为这个任务自动启动应用。
// 只测纯函数 + 依赖注入的 mock isRunning，不启动任何应用/任务。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CANDIDATES,
  pickRunningCandidates,
  shouldSkipNotRunning,
} from '../core/tasks/user-active-demo.mjs';

const CALC = { name: '计算器', bundleId: 'com.apple.calculator', appName: '计算器', processName: 'Calculator' };
const NOTES = { name: '备忘录', bundleId: 'com.apple.Notes', appName: '备忘录', processName: 'Notes' };
const TEXTEDIT = { name: '文本编辑', bundleId: 'com.apple.TextEdit', appName: '文本编辑', processName: 'TextEdit' };

test('候选应用元数据覆盖计算器/备忘录/文本编辑，且都带 bundle/app/process 名', () => {
  assert.deepEqual(CANDIDATES.map((c) => c.name), ['计算器', '备忘录', '文本编辑']);
  for (const candidate of CANDIDATES) {
    assert.ok(candidate.bundleId, candidate.name + ' 缺 bundleId');
    assert.ok(candidate.appName, candidate.name + ' 缺 appName');
    assert.ok(candidate.processName, candidate.name + ' 缺 processName');
  }
});

test('全部没运行 → 返回空数组，任务应环境跳过', async () => {
  const running = await pickRunningCandidates([CALC, NOTES, TEXTEDIT], async () => false);
  assert.deepEqual(running, []);
  assert.equal(shouldSkipNotRunning(running), true);
});

test('部分运行 → 只保留运行中的候选且保持原顺序', async () => {
  const running = await pickRunningCandidates(
    [CALC, NOTES, TEXTEDIT],
    async (candidate) => candidate.name === '备忘录' || candidate.name === '文本编辑',
  );
  assert.deepEqual(running.map((c) => c.name), ['备忘录', '文本编辑']);
  assert.equal(shouldSkipNotRunning(running), false);
});

test('isRunning 收到完整候选对象（bundle/app/process 名），不是裸字符串', async () => {
  const seen = [];
  await pickRunningCandidates([CALC], async (candidate) => {
    seen.push(candidate);
    return true;
  });
  assert.deepEqual(seen, [CALC]);
});

test('isRunning 抛错按没运行处理，不向上抛（宁可跳过也不冒险拉起）', async () => {
  const running = await pickRunningCandidates([CALC, NOTES], async (candidate) => {
    if (candidate.name === '计算器') throw new Error('pgrep failed');
    return true;
  });
  assert.deepEqual(running.map((c) => c.name), ['备忘录']);
});

test('候选里的 null/undefined 直接跳过', async () => {
  const running = await pickRunningCandidates([null, CALC, undefined, NOTES], async () => true);
  assert.deepEqual(running.map((c) => c.name), ['计算器', '备忘录']);
});

test('非数组候选 / 非函数探测器 → 安全返回空（不会误判为可运行）', async () => {
  assert.deepEqual(await pickRunningCandidates(null, async () => true), []);
  assert.deepEqual(await pickRunningCandidates([CALC], null), []);
  assert.deepEqual(await pickRunningCandidates([CALC], 'not-a-function'), []);
});

test('shouldSkipNotRunning：空/非法输入都按跳过处理', () => {
  assert.equal(shouldSkipNotRunning([]), true);
  assert.equal(shouldSkipNotRunning(null), true);
  assert.equal(shouldSkipNotRunning(undefined), true);
  assert.equal(shouldSkipNotRunning({ length: 0 }), true);
  assert.equal(shouldSkipNotRunning([CALC]), false);
});
