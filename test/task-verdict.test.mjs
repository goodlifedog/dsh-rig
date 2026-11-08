'use strict';
// 两条通道/矩阵任务的结论口径：前台没被抢 ≠ 验证通过，必须真的有可读结果
import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeApplescriptRows } from '../core/tasks/applescript-channel.mjs';
import { summarizeMatrixVerdict, collectTouchedAliases } from '../core/tasks/app-matrix.mjs';
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
test('矩阵收尾候选别名：补上进程名，避免只有本地化名对不上', () => {
  const aliases = collectTouchedAliases([
    { app: '计算器', bundle: 'com.apple.calculator', process: 'Calculator' },
    { app: 'FastZip', bundle: 'cn.better365.FastZip', process: 'FastZip' },
  ]);
  assert.ok(aliases.includes('计算器'));
  assert.ok(aliases.includes('Calculator'), '必须包含可执行进程名 Calculator');
  assert.ok(aliases.includes('calculator'));
  assert.ok(aliases.includes('FastZip'));
  // 去重：FastZip 同时来自 app/process/bundle 末段
  assert.equal(aliases.filter((x) => x === 'FastZip').length, 1);
  assert.doesNotThrow(() => collectTouchedAliases(null));
});

// ---------- collectTouchedAliases 边界（task-38） ----------

test('矩阵别名：row 缺 process / 缺 bundle 不崩，也不会塞进 undefined/null', () => {
  const aliases = collectTouchedAliases([
    { app: 'Notes' },
    { app: 'TextEdit', process: undefined },
    { app: 'Keynote', bundle: null },
    { process: 'Calculator' },
    { bundle: 'com.apple.calculator' },
  ]);
  assert.ok(aliases.includes('Notes'));
  assert.ok(aliases.includes('TextEdit'));
  assert.ok(aliases.includes('Keynote'));
  assert.ok(aliases.includes('Calculator'), '只有 process 的行也要收进来');
  assert.ok(aliases.includes('calculator'), '只有 bundle 的行也要收末段');
  for (const bad of ['undefined', 'null', 'NaN', '']) {
    assert.equal(aliases.includes(bad), false, '不该出现伪造别名: ' + bad);
  }
});

test('矩阵别名：坏行（null / undefined / 非对象）安全跳过', () => {
  assert.deepEqual(collectTouchedAliases([null, undefined]), []);
  assert.doesNotThrow(() => collectTouchedAliases([null, {}, '', 0, false]));
  assert.deepEqual(collectTouchedAliases([]), []);
  assert.deepEqual(collectTouchedAliases(), []);
});

test('矩阵别名：本地化名、进程名、bundle 末段三者都收，且顺序稳定', () => {
  const aliases = collectTouchedAliases([
    { app: '计算器', bundle: 'com.apple.calculator', process: 'Calculator' },
  ]);
  assert.deepEqual(aliases, ['计算器', 'Calculator', 'calculator'],
    '顺序：app → process → bundle 末段（decideRestore 只依赖集合，顺序只影响可读性）');
});

test('矩阵别名：去重只在完全相同的时候生效（大小写不同算两个别名）', () => {
  const aliases = collectTouchedAliases([
    { app: 'FastZip', process: 'FastZip', bundle: 'FastZip' },
    { app: 'FastZip' },
  ]);
  assert.deepEqual(aliases, ['FastZip'], '同一个名字出现多次只留一份');
  const mixed = collectTouchedAliases([{ app: 'Calculator', process: 'calculator' }]);
  assert.deepEqual(mixed, ['Calculator', 'calculator'], '大小写不同保留两个（decideRestore 会统一小写比较）');
});

test('矩阵别名：bundle 带尾点 / 无点 / 前点都不产生空别名', () => {
  const aliases = collectTouchedAliases([
    { app: 'A', bundle: 'FastZip' },        // 没有点：整串就是末段
    { app: 'B', bundle: 'com.foo.' },        // 尾点：末段是空串，应跳过
    { app: 'C', bundle: '.leading' },        // 前点：末段是 leading
    { app: 'D', bundle: '...' },             // 全点：末段空串，跳过
  ]);
  assert.deepEqual(aliases, ['A', 'FastZip', 'B', 'C', 'leading', 'D']);
});

test('矩阵别名：空白 / 纯空格的名字跳过，非字符串值不崩', () => {
  const aliases = collectTouchedAliases([
    { app: '   ', process: '' },
    { app: ' Notes ' },
    { app: 42, bundle: 123 },
  ]);
  assert.deepEqual(aliases, ['Notes', '42', '123'],
    '数字会被 String() 转成别名（现实中不会出现，但不该崩）');
});

test('矩阵别名：row 很多时保持收集顺序、返回独立数组', () => {
  const rows = [
    { app: 'R1', process: 'P1', bundle: 'a.b.C1' },
    { app: 'R2', process: 'P2', bundle: 'a.b.C2' },
    { app: 'R3', process: 'P3', bundle: 'a.b.C3' },
  ];
  const first = collectTouchedAliases(rows);
  assert.deepEqual(first, ['R1', 'P1', 'C1', 'R2', 'P2', 'C2', 'R3', 'P3', 'C3']);
  first.push('污染');
  assert.deepEqual(collectTouchedAliases(rows), ['R1', 'P1', 'C1', 'R2', 'P2', 'C2', 'R3', 'P3', 'C3'],
    '每次调用应返回新数组，不被上一次的结果污染');
});
