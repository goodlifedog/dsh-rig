'use strict';
// AppleEvent 入口的静默预检守卫：app-matrix 的前台还原 + form-fill 的运行门禁。
// 全程注入假 run/preflight/execFile，不控制任何应用、不发真实 AppleEvent、不碰 TCC。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { restoreFront, applyRestoreToRow } from '../core/tasks/app-matrix.mjs';
import { SYSTEM_EVENTS_BUNDLE_ID } from '../core/appleevent-preflight.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SYSTEM_EVENTS_SCRIPT = 'tell application "System Events" to set frontmost of process "Safari" to true';

function deniedPreflight(status = 'denied', warning = '自动化未授权（' + status + '），已跳过该 AppleEvent（不弹授权框）') {
  const seen = [];
  const preflight = async (input) => {
    seen.push(input);
    return { allowed: false, status, warning };
  };
  preflight.seen = seen;
  return preflight;
}

function systemEventsRun() {
  const calls = [];
  const execFile = (bin, args, callback) => {
    calls.push({ bin, args });
    callback(null, '', '');
  };
  return { calls, execFile };
}

test('app-matrix 前台还原：granted → 同样的 System Events 脚本，返回 ok', async () => {
  const { calls, execFile } = systemEventsRun();
  const seen = [];
  const preflight = async (input) => { seen.push(input); return { allowed: true, status: 'granted' }; };
  const r = await restoreFront('Safari', { execFile, preflight });
  assert.equal(r.ok, true);
  assert.equal(r.skipped, '');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].bin, '/usr/bin/osascript');
  assert.deepEqual(calls[0].args, ['-e', SYSTEM_EVENTS_SCRIPT], '还原脚本必须逐字不变');
  assert.equal(seen[0].bundleId, SYSTEM_EVENTS_BUNDLE_ID, '预检目标必须是 System Events');
  assert.match(seen[0].action, /前台还原/);
});

test('app-matrix 前台还原：denied → 0 次 osascript（no-op）+ 一行警告', async () => {
  let execCalls = 0;
  const warnings = [];
  const r = await restoreFront('Safari', {
    execFile: () => { execCalls += 1; throw new Error('未授权时不该执行 osascript'); },
    preflight: deniedPreflight('denied'),
    onWarning: (message) => warnings.push(message),
  });
  assert.equal(execCalls, 0);
  assert.equal(r.ok, false);
  assert.equal(r.allowed, false);
  assert.equal(r.skipped, 'not-authorized');
  assert.equal(warnings.length, 1);
});

test('app-matrix 前台还原：unknown → 仍然尝试', async () => {
  const { calls, execFile } = systemEventsRun();
  const r = await restoreFront('Safari', { execFile, preflight: async () => ({ allowed: true, status: 'unknown' }) });
  assert.equal(r.ok, true);
  assert.equal(calls.length, 1);
});

test('app-matrix 前台还原：预检抛错 → 仍然尝试', async () => {
  const { calls, execFile } = systemEventsRun();
  const r = await restoreFront('Safari', { execFile, preflight: async () => { throw new Error('boom'); } });
  assert.equal(r.ok, true);
  assert.equal(calls.length, 1);
});

// ---------- L4：app-matrix restoreFront 的 execFile error 不能再被吞 ----------

test('app-matrix 前台还原：execFile 返回 -1743 → skipped:not-authorized（不记 ok）', async () => {
  const calls = [];
  const warnings = [];
  const execFile = (bin, args, callback) => {
    calls.push({ bin, args });
    callback(Object.assign(new Error('osascript failed'), { code: 1 }), '', 'execution error: 不允许发送 Apple 事件 (-1743)');
  };
  const r = await restoreFront('Safari', {
    execFile,
    preflight: async () => ({ allowed: true, status: 'granted' }),
    onWarning: (message) => warnings.push(message),
  });
  assert.equal(calls.length, 1, '要真的执行并拿到错误');
  assert.equal(r.ok, false, 'execFile 失败不能当还原成功');
  assert.equal(r.skipped, 'not-authorized');
  assert.match(r.error, /-1743/);
  assert.equal(warnings.length, 0, '这种归类走调用方环境跳过，不额外打警告');
});

test('app-matrix 前台还原：其它 execFile 错误 → ok:false 且不带 skipped', async () => {
  const execFile = (bin, args, callback) => {
    callback(Object.assign(new Error('boom'), { code: 1 }), '', 'weird failure');
  };
  const r = await restoreFront('Safari', { execFile, preflight: async () => ({ allowed: true, status: 'granted' }) });
  assert.equal(r.ok, false);
  assert.equal(r.skipped, '');
  assert.match(r.error, /weird failure/);
});

test('applyRestoreToRow：未授权/应用没在运行 → frontRestored 绝不记 true', () => {
  const row = { frontRestored: true };
  applyRestoreToRow(row, { ok: false, skipped: 'not-authorized', warning: 'w' });
  assert.equal(row.frontRestored, false);
  assert.equal(row.frontRestoreSkipped, 'not-authorized');
  assert.equal(row.frontRestoreWarning, 'w');

  const row2 = {};
  applyRestoreToRow(row2, { ok: false, skipped: 'app-not-running', warning: 'x' });
  assert.equal(row2.frontRestored, false);
  assert.equal(row2.frontRestoreSkipped, 'app-not-running');

  const row3 = { frontRestored: true };
  applyRestoreToRow(row3, { ok: false, skipped: 'not-authorized' }, { afterQuit: true });
  assert.equal(row3.frontRestoredAfterQuit, false);
  assert.equal(row3.frontRestored, false, '内存里之前的 true 也要清掉');

  const okRow = { frontRestored: false };
  applyRestoreToRow(okRow, { ok: true, attempts: 2 });
  assert.equal(okRow.frontRestored, true);
  assert.equal(okRow.frontRestoreAttempts, 2);
});

test('静态回归：app-matrix 的 AppleEvent 走统一预检，未授权有环境跳过兜底', () => {
  const read = (file) => fs.readFileSync(path.join(HERE, '..', file), 'utf8');
  const matrix = read('core/tasks/app-matrix.mjs');
  const fill = read('core/tasks/form-fill.mjs');
  assert.match(matrix, /appleevent-preflight\.mjs/, 'app-matrix 要引入静默预检模块');
  assert.match(matrix, /runAppleEventGuarded/, 'app-matrix 要用统一执行器');
  assert.match(matrix, /not-authorized/, 'app-matrix 要有未授权兜底');
  assert.match(matrix, /SYSTEM_EVENTS_BUNDLE_ID/, 'System Events bundle id 要用常量');
  assert.match(matrix, /classifyOsascriptError/, 'L4：restoreFront 要检查 execFile error 并分类');
  assert.match(matrix, /applyRestoreToRow/, 'L4：还原结果要统一写进行里');
  assert.match(matrix, /restoreSkipped/, '矩阵要把还原跳过计入环境跳过，而不是前台被抢占');
  // form-fill 改造后不再发 AppleEvent，但「未运行先跳过」和「结构化环境跳过」两条语义要保留
  assert.match(fill, /isAppRunning/, 'M3：碰应用前要先确认它在运行');
  assert.match(fill, /环境跳过/, '环境不具备时要按环境跳过，不判失败');
  assert.match(fill, /JSON\.stringify\(\{ ok: true, skipped: true, reason/, 'form-fill 要有结构化 skipped JSON');
});
