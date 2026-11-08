'use strict';
// 矩阵收尾的两个判定（task-41 / 来源 task-38）：
//   shouldAutoQuit —— 只关「本次自己拉起来的」，用户原有应用绝不碰
//   countAutoQuit  —— 报告里的 autoQuit 不能把 already-stopped 算成我们的功劳
// 这两个以前内联在 main 循环里，没法单测；抽成纯函数后这里锁住语义，防止以后改动把
// 「用户正在用的应用」意外关掉。
import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldAutoQuit, countAutoQuit } from '../core/tasks/app-matrix.mjs';

// ---------- shouldAutoQuit ----------

test('shouldAutoQuit：本次 launched 的应用默认会关（未设 MATRIX_QUIT）', () => {
  assert.equal(shouldAutoQuit({ launch: 'launched' }, {}), true);
  assert.equal(shouldAutoQuit({ launch: 'launched' }, { MATRIX_QUIT: undefined }), true);
  assert.equal(shouldAutoQuit({ launch: 'launched' }), true, 'env 缺省也不该崩');
});

test('shouldAutoQuit：用户原有应用（running）绝不 quit，哪怕显式传了环境变量', () => {
  assert.equal(shouldAutoQuit({ launch: 'running' }, {}), false);
  assert.equal(shouldAutoQuit({ launch: 'running' }, { MATRIX_QUIT: '1' }), false);
  assert.equal(shouldAutoQuit({ launch: 'running' }, { MATRIX_QUIT: '' }), false);
});

test('shouldAutoQuit：启动失败（error）不 quit，别去动一个可能半死不活的应用', () => {
  assert.equal(shouldAutoQuit({ launch: 'error' }, {}), false);
  assert.equal(shouldAutoQuit({ launch: 'error' }, { MATRIX_QUIT: '1' }), false);
});

test('shouldAutoQuit：MATRIX_QUIT=0 生效（显式关掉自动退出）', () => {
  assert.equal(shouldAutoQuit({ launch: 'launched' }, { MATRIX_QUIT: '0' }), false);
});

test('shouldAutoQuit：只认严格的字符串 "0"，其它值不关（避免 "0 " / "false" 被误当开关）', () => {
  for (const value of ['1', '', 'false', 'no', '00', ' 0', '0 ', null, undefined]) {
    assert.equal(shouldAutoQuit({ launch: 'launched' }, { MATRIX_QUIT: value }), true,
      'MATRIX_QUIT=' + JSON.stringify(value) + ' 不该关闭自动退出（只有字符串 "0" 才关）');
  }
  assert.equal(shouldAutoQuit({ launch: 'launched' }, { MATRIX_QUIT: '0' }), false);
});

test('shouldAutoQuit：缺行 / 缺 launch / 非对象传入都安全返回 false', () => {
  assert.equal(shouldAutoQuit(), false);
  assert.equal(shouldAutoQuit(null), false);
  assert.equal(shouldAutoQuit(undefined, {}), false);
  assert.equal(shouldAutoQuit({}), false);
  assert.equal(shouldAutoQuit({ launch: '' }), false);
  assert.equal(shouldAutoQuit({ launch: 'already-stopped' }), false, 'already-stopped 是 quit 结果，不是 launch 值');
});

test('shouldAutoQuit：纯函数，不改 row 也不改 env', () => {
  const row = { launch: 'launched', app: 'FastZip' };
  const env = { MATRIX_QUIT: '0' };
  const rowSnapshot = JSON.stringify(row);
  const envSnapshot = JSON.stringify(env);
  shouldAutoQuit(row, env);
  assert.equal(JSON.stringify(row), rowSnapshot);
  assert.equal(JSON.stringify(env), envSnapshot);
});

// ---------- countAutoQuit ----------

test('countAutoQuit：空输入（null / undefined / [] / 非数组）返回 0', () => {
  assert.equal(countAutoQuit(), 0);
  assert.equal(countAutoQuit(null), 0);
  assert.equal(countAutoQuit([]), 0);
  assert.equal(countAutoQuit('not-an-array'), 0);
  assert.equal(countAutoQuit({ length: 3 }), 0);
});

test('countAutoQuit：只统计真正被关掉的（quit / term 等模式都算）', () => {
  const rows = [
    { launch: 'launched', autoQuit: 'quit' },
    { launch: 'launched', autoQuit: 'term' },
    { launch: 'launched', autoQuit: 'needs-confirm' },
  ];
  assert.equal(countAutoQuit(rows), 3);
});

test('countAutoQuit：already-stopped 不算我们关的（目标本来就没在跑）', () => {
  const rows = [
    { launch: 'launched', autoQuit: 'already-stopped' },
    { launch: 'launched', autoQuit: 'quit' },
  ];
  assert.equal(countAutoQuit(rows), 1);
  assert.equal(countAutoQuit([{ autoQuit: 'already-stopped' }]), 0);
});

test('countAutoQuit：没走过退出分支的行（用户原有应用 / 启动失败 / 跳过）不计数', () => {
  const rows = [
    { launch: 'running' },
    { launch: 'error' },
    { app: 'x', skipped: true },
    { launch: 'launched' },              // MATRIX_QUIT=0 时就是这种：launched 但没 autoQuit
    { launch: 'launched', autoQuit: '' },
    { launch: 'launched', autoQuit: null },
    { launch: 'launched', autoQuit: undefined },
  ];
  assert.equal(countAutoQuit(rows), 0);
});

test('countAutoQuit：坏行（null / 非对象）安全跳过，不制造假计数', () => {
  const rows = [null, undefined, { autoQuit: 'quit' }, null];
  assert.equal(countAutoQuit(rows), 1);
  assert.doesNotThrow(() => countAutoQuit([null, undefined, 0, '', false]));
  assert.equal(countAutoQuit([null, undefined, 0, '', false]), 0);
});

test('countAutoQuit：混合场景端到端口径（与 main 里的用法一致）', () => {
  // 模拟一轮矩阵：用户本来开着的计算器、我们自己拉起来的 FastZip、启动失败的 Steam、跳过的一个
  const rows = [
    { app: '计算器', launch: 'running' },
    { app: 'FastZip', launch: 'launched', autoQuit: 'quit' },
    { app: 'Steam', launch: 'error' },
    { app: 'Keynote', skipped: true },
    { app: 'TextEdit', launch: 'launched', autoQuit: 'already-stopped' },
  ];
  assert.equal(countAutoQuit(rows), 1, '只有 FastZip 真被我们关掉');
});

test('两个判定一致：MATRIX_QUIT=0 时一轮跑下来 autoQuit 必为 0', () => {
  const env = { MATRIX_QUIT: '0' };
  const rows = [
    { launch: 'launched' },
    { launch: 'launched' },
  ].filter((row) => shouldAutoQuit(row, env));
  assert.deepEqual(rows, [], '一条都不该进退出分支');
  assert.equal(countAutoQuit(rows), 0);
});
