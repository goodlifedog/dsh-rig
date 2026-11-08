'use strict';
// H2 缺口 B：Chrome 标签 AppleEvent / System Events 前台还原接静默预检。
// 全程注入假 run/preflight/execFile，不控制 Chrome、不发任何真实 AppleEvent、不碰 TCC。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { switchTabByAppleScript as bossSwitchTab } from '../core/tasks/boss-scan.mjs';
import { switchTabByAppleScript as fillSwitchTab } from '../core/tasks/form-fill.mjs';
import { restoreFront, applyRestoreToRow } from '../core/tasks/app-matrix.mjs';
import { SYSTEM_EVENTS_BUNDLE_ID } from '../core/appleevent-preflight.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHROME_BUNDLE_ID = 'com.google.Chrome';
const FRAGMENT = 'zhipin.com/web/geek/jobs';

// 原实现里 3 条 osascript 脚本（逐字对照，granted 时参数必须完全一致）
const CHROME_SCRIPTS = [
  'tell application "Google Chrome" to get URL of every tab of window 1',
  'tell application "Google Chrome" to set active tab index of window 1 to 2',
  'tell application "Google Chrome" to get URL of active tab of window 1',
];
const SYSTEM_EVENTS_SCRIPT = 'tell application "System Events" to set frontmost of process "Safari" to true';

function chromeRun() {
  const calls = [];
  const run = async (cmd, args) => {
    calls.push({ cmd, args });
    const script = args[args.length - 1];
    if (script.includes('get URL of every tab')) {
      return { code: 0, stdout: 'https://example.com/, https://www.zhipin.com/web/geek/jobs, https://other.example/', stderr: '' };
    }
    if (script.includes('set active tab index')) return { code: 0, stdout: '', stderr: '' };
    return { code: 0, stdout: 'https://www.zhipin.com/web/geek/jobs', stderr: '' };
  };
  return { calls, run };
}

function deniedPreflight(status = 'denied', warning = '自动化未授权（' + status + '），已跳过该 AppleEvent（不弹授权框）') {
  const seen = [];
  const preflight = async (input) => {
    seen.push(input);
    return { allowed: false, status, warning };
  };
  preflight.seen = seen;
  return preflight;
}

for (const [label, switchTab] of [['boss-scan', bossSwitchTab], ['form-fill', fillSwitchTab]]) {
  test(label + ' Chrome 切标签：granted → osascript 参数逐字不变（3 条）', async () => {
    const { calls, run } = chromeRun();
    const preflightSeen = [];
    const preflight = async (input) => { preflightSeen.push(input); return { allowed: true, status: 'granted' }; };
    const r = await switchTab({ run, preflight, isAppRunning: async () => true, fragment: FRAGMENT });
    assert.equal(r.ok, true);
    assert.equal(r.tabIndex, 2);
    assert.equal(calls.length, 3, 'granted 时必须保持原来的 3 次 osascript');
    assert.equal(calls[0].cmd, 'osascript');
    assert.deepEqual(calls.map((c) => c.args), CHROME_SCRIPTS.map((s) => ['-e', s]), '脚本参数必须逐字一致');
    assert.equal(preflightSeen.length, 3);
    assert.equal(preflightSeen[0].bundleId, CHROME_BUNDLE_ID, '预检目标必须是 Chrome 的 bundle id');
    assert.match(preflightSeen[0].action, /Chrome/);
  });

  test(label + ' Chrome 切标签：denied/needs-consent → 0 次 osascript + skipped 兜底 + 一行警告', async () => {
    let runCalls = 0;
    const warnings = [];
    const preflight = deniedPreflight('needs-consent');
    const r = await switchTab({
      run: async () => { runCalls += 1; throw new Error('未授权时不该执行 osascript'); },
      preflight,
      isAppRunning: async () => true,
      fragment: FRAGMENT,
      onWarning: (message) => warnings.push(message),
    });
    assert.equal(runCalls, 0, '未授权时绝不能发 AppleEvent（否则弹授权框）');
    assert.equal(r.ok, false);
    assert.equal(r.skipped, 'not-authorized');
    assert.match(r.warning, /未授权/);
    assert.equal(warnings.length, 1, '要打印且只打印一行警告');
    assert.equal(warnings[0], r.warning);
  });

  test(label + ' Chrome 切标签：unknown → 仍然尝试（3 条）', async () => {
    const { calls, run } = chromeRun();
    const r = await switchTab({
      run,
      preflight: async () => ({ allowed: true, status: 'unknown' }),
      isAppRunning: async () => true,
      fragment: FRAGMENT,
    });
    assert.equal(r.ok, true);
    assert.equal(calls.length, 3, '探测抖动不能把原有逻辑弄失效');
  });

  test(label + ' Chrome 切标签：预检抛错 → 仍然尝试（3 条）', async () => {
    const { calls, run } = chromeRun();
    const r = await switchTab({
      run,
      preflight: async () => { throw new Error('preflight boom'); },
      isAppRunning: async () => true,
      fragment: FRAGMENT,
    });
    assert.equal(r.ok, true, '预检抛错按 unknown 放行');
    assert.equal(calls.length, 3);
  });
}


// ---------- M3：Chrome 没在运行 → 连预检/AppleEvent 都不该有 ----------

for (const [label, switchTab] of [['boss-scan', bossSwitchTab], ['form-fill', fillSwitchTab]]) {
  test(label + ' Chrome 切标签：Chrome 没在运行 → 0 次 osascript，skipped:app-not-running（M3）', async () => {
    let runCalls = 0;
    let preflightCalls = 0;
    const r = await switchTab({
      run: async () => { runCalls += 1; throw new Error('不该执行 osascript'); },
      preflight: async () => { preflightCalls += 1; return { allowed: true, status: 'granted' }; },
      isAppRunning: async () => false,
      fragment: FRAGMENT,
    });
    assert.equal(runCalls, 0, 'Chrome 没在运行绝不能发 AppleEvent（tell 会启动它）');
    assert.equal(preflightCalls, 0, '应用没运行就不必浪费一次授权探测');
    assert.equal(r.ok, false);
    assert.equal(r.skipped, 'app-not-running');
    assert.match(r.warning, /没在运行/);
  });

  test(label + ' Chrome 切标签：osascript 返回 -1743 → skipped:not-authorized，不 throw 成 FAIL（M4）', async () => {
    const r = await switchTab({
      run: async () => ({ code: 1, stdout: '', stderr: 'execution error: 不允许发送 Apple 事件 (-1743)' }),
      preflight: async () => ({ allowed: true, status: 'unknown' }),
      isAppRunning: async () => true,
      fragment: FRAGMENT,
    });
    assert.equal(r.ok, false);
    assert.equal(r.skipped, 'not-authorized', '未授权错误要归环境跳过，而不是 FAIL');
    assert.match(r.warning, /未授权/);
  });

  test(label + ' Chrome 切标签：osascript 返回 -1744（需要用户同意）→ skipped:not-authorized', async () => {
    const r = await switchTab({
      run: async () => ({ code: 1, stdout: '', stderr: 'execution error: AppleEvent timed out, would require user consent (-1744)' }),
      preflight: async () => ({ allowed: true, status: 'unknown' }),
      isAppRunning: async () => true,
      fragment: FRAGMENT,
    });
    assert.equal(r.skipped, 'not-authorized');
  });

  test(label + ' Chrome 切标签：其它 osascript 错误保持原样（不伪装成 skipped）', async () => {
    const r = await switchTab({
      run: async () => ({ code: 1, stdout: '', stderr: 'weird failure' }),
      preflight: async () => ({ allowed: true, status: 'granted' }),
      isAppRunning: async () => true,
      fragment: FRAGMENT,
    });
    assert.equal(r.ok, false);
    assert.equal(r.skipped, undefined);
    assert.match(r.error, /weird failure/);
  });
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

test('静态回归：三个任务的 AppleEvent 都走统一预检，未授权有环境跳过兜底', () => {
  const read = (file) => fs.readFileSync(path.join(HERE, '..', file), 'utf8');
  const boss = read('core/tasks/boss-scan.mjs');
  const fill = read('core/tasks/form-fill.mjs');
  const matrix = read('core/tasks/app-matrix.mjs');
  for (const [file, src] of [['boss-scan', boss], ['form-fill', fill], ['app-matrix', matrix]]) {
    assert.match(src, /appleevent-preflight\.mjs/, file + ' 要引入静默预检模块');
    assert.match(src, /runAppleEventGuarded/, file + ' 要用统一执行器');
    assert.match(src, /not-authorized/, file + ' 要有未授权兜底');
  }
  assert.match(boss, /CHROME_BUNDLE_ID = 'com\.google\.Chrome'/, 'Chrome bundle id 要对');
  assert.match(fill, /CHROME_BUNDLE_ID = 'com\.google\.Chrome'/, 'Chrome bundle id 要对');
  assert.match(boss, /环境跳过/, '未授权/没在运行要按环境跳过，不判失败');
  assert.match(fill, /环境跳过/, '未授权/没在运行要按环境跳过，不判失败');
  assert.match(boss, /chrome-not-running/, 'boss-scan 要能报 chrome-not-running');
  assert.match(fill, /chrome-not-running/, 'form-fill 要能报 chrome-not-running');
  assert.match(boss, /classifyOsascriptError/, 'M4：osascript 失败要用分类器判未授权');
  assert.match(fill, /classifyOsascriptError/, 'M4：osascript 失败要用分类器判未授权');
  assert.match(boss, /isAppRunning/, 'M3：发事件前要先确认 Chrome 在运行');
  assert.match(fill, /isAppRunning/, 'M3：发事件前要先确认 Chrome 在运行');
  assert.match(matrix, /SYSTEM_EVENTS_BUNDLE_ID/, 'System Events bundle id 要用常量');
  assert.match(matrix, /classifyOsascriptError/, 'L4：restoreFront 要检查 execFile error 并分类');
  assert.match(matrix, /applyRestoreToRow/, 'L4：还原结果要统一写进行里');
  assert.match(matrix, /restoreSkipped/, '矩阵要把还原跳过计入环境跳过，而不是前台被抢占');
  // L6：form-fill 也要有机器可消费的结构化 skipped JSON
  assert.match(fill, /JSON\.stringify\(\{ ok: true, skipped: true, reason/, 'form-fill 要有结构化 skipped JSON');
  assert.match(boss, /JSON\.stringify\(\{ ok: true, skipped: true, reason/, 'boss-scan 要有结构化 skipped JSON');
});
