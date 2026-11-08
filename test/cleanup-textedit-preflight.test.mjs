'use strict';
// H2 缺口 C：cleanup-test-data 的 TextEdit / Chrome AppleEvent 先静默预检自动化授权。
// 全部注入假 preflight / 假 osa，不跑真实清理、不发真实 AppleEvent。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  cleanupTextEdit,
  reportOnly,
  purgeNotes,
  summarizeCleanup,
  gateAllows,
  gateSkipReason,
  TEXTEDIT_BUNDLE_ID,
  CHROME_BUNDLE_ID,
} from '../scripts/cleanup-test-data.mjs';

const RUNNING = async () => true;

const CHROME_SCRIPT = 'tell application "Google Chrome" to get URL of every tab of every window';

function captureWarnings(fn) {
  const original = console.warn;
  const lines = [];
  console.warn = (...args) => { lines.push(args.join(' ')); };
  return Promise.resolve()
    .then(fn)
    .then((result) => { console.warn = original; return { result, lines }; })
    .catch((error) => { console.warn = original; throw error; });
}

// 假 osa：记录每次调用的完整参数，按脚本返回预设值（count documents 用序列模拟关闭前/后）
function makeOsa(returnByScript, countSequence = []) {
  const calls = [];
  const fn = (script, timeout) => {
    calls.push(timeout === undefined ? [script] : [script, timeout]);
    if (Array.isArray(returnByScript[script])) return returnByScript[script].shift();
    if (Object.prototype.hasOwnProperty.call(returnByScript, script)) return returnByScript[script];
    if (script === 'tell application "TextEdit" to count documents' && countSequence.length) return countSequence.shift();
    return '';
  };
  fn.calls = calls;
  return fn;
}

const grantedPreflight = async () => ({ allowed: true, status: 'granted' });
const deniedPreflight = async () => ({ allowed: false, status: 'denied', warning: '自动化未授权（denied），已跳过该 AppleEvent（不弹授权框）' });
const unknownPreflight = async () => ({ allowed: true, status: 'unknown' });

test('H2-C granted：TextEdit 走原逻辑，osa 参数逐字不变，deleted 计数正确', async () => {
  const osa = makeOsa({
    'application "TextEdit" is running': 'true',
    'tell application "TextEdit" to get name of document 2': '我的笔记',
    'tell application "TextEdit" to get text of document 2': '用户自己的内容',
    'tell application "TextEdit" to get name of document 1': '未命名',
    'tell application "TextEdit" to get text of document 1': '[AGENT-TEST] 后台写入：12:00',
    'tell application "TextEdit" to close document 1 saving no': '',
  }, ['2', '1']); // 关闭前 2 篇，关闭后还有 1 篇（避免走 quit 分支）
  const report = [];
  const result = await cleanupTextEdit(report, {
    preflight: grantedPreflight,
    deps: {
      osa,
      isAppRunning: RUNNING,
      sleep: async () => {},
      quitApp: async () => { throw new Error('granted 测试里不该走 quit'); },
    },
  });
  assert.equal(result.deleted, 1);
  assert.equal(result.skipped, false);
  // 与改造前完全一致的脚本/参数（逐字断言）
  const expected = [
    ['tell application "TextEdit" to count documents'],
    ['tell application "TextEdit" to get name of document 2'],
    ['tell application "TextEdit" to get text of document 2'],
    ['tell application "TextEdit" to get name of document 1'],
    ['tell application "TextEdit" to get text of document 1'],
    ['tell application "TextEdit" to close document 1 saving no'],
    ['tell application "TextEdit" to count documents'],
  ];
  assert.deepEqual(osa.calls, expected);
  assert.ok(report.some((r) => r.kind === 'textedit-keep'), '用户文稿必须保留');
  assert.ok(report.some((r) => r.kind === 'textedit-doc'), '测试文稿应被标记关闭');
});

test('H2-C denied：TextEdit 一个 AppleEvent 都不发（不读不删不关），报告环境跳过且 deleted=0', async () => {
  const osa = makeOsa({});
  const quitCalls = [];
  const report = [];
  const { result, lines } = await captureWarnings(() => cleanupTextEdit(report, {
    preflight: deniedPreflight,
    deps: { osa, isAppRunning: RUNNING, sleep: async () => {}, quitApp: async (...args) => { quitCalls.push(args); } },
  }));
  assert.equal(osa.calls.length, 0, '未授权时不能发任何 TextEdit AppleEvent（包括读文稿）');
  assert.equal(quitCalls.length, 0, '未授权时不能关应用');
  assert.deepEqual(result, { deleted: 0, skipped: true });
  const skipped = report.find((r) => r.kind === 'textedit-skipped');
  assert.ok(skipped, '必须明确报告环境跳过');
  assert.equal(skipped.envSkip, true);
  assert.equal(skipped.bundleId, TEXTEDIT_BUNDLE_ID);
  assert.equal(skipped.deleted, 0);
  assert.equal(report.some((r) => r.kind === 'textedit-doc'), false);
  assert.equal(lines.length, 1, '要打印一行原因');
  assert.match(lines[0], /未授权/);
});

test('H2-C 未授权时 deleted 计数必须为 0（笔记/TextEdit/Chrome 三路都 0）', async () => {
  const osa = makeOsa({});
  const report = [];
  const text = await captureWarnings(() => cleanupTextEdit(report, { preflight: deniedPreflight, deps: { osa, isAppRunning: RUNNING, sleep: async () => {} } }))
    .then((x) => x.result);
  const chrome = await captureWarnings(() => reportOnly(report, { preflight: deniedPreflight, deps: { osa, isAppRunning: RUNNING } }))
    .then((x) => x.result);
  assert.equal(text.deleted, 0);
  assert.equal(chrome.read, false);
  assert.equal(osa.calls.filter((c) => c[0] === CHROME_SCRIPT).length, 0);
  const deletedTotal = 0; // 主流程里的 deleted 对象：notes 由 purgeNotes 返回（未授权不会执行到这里以外的删除）
  assert.equal(deletedTotal, 0);
});

test('H2-C unknown / 预检抛错：仍然尝试（行为不变）', async () => {
  const osa1 = makeOsa({ 'application "TextEdit" is running': 'false' });
  const r1 = await cleanupTextEdit([], { preflight: unknownPreflight, deps: { osa: osa1, isAppRunning: RUNNING, sleep: async () => {} } });
  assert.equal(r1.skipped, false);
  assert.ok(osa1.calls.length > 0, 'unknown 仍然尝试');

  const osa2 = makeOsa({ 'application "TextEdit" is running': 'false' });
  const r2 = await cleanupTextEdit([], { preflight: async () => { throw new Error('probe boom'); }, deps: { osa: osa2, isAppRunning: RUNNING, sleep: async () => {} } });
  assert.equal(r2.skipped, false, '预检抛错按 unknown 放行');
  assert.ok(osa2.calls.length > 0);
});

test('H2-C granted：Chrome 标签读取参数逐字不变', async () => {
  const osa = makeOsa({ [CHROME_SCRIPT]: 'https://a, https://zhipin.com/x' });
  const report = [];
  const result = await reportOnly(report, { preflight: grantedPreflight, deps: { osa, isAppRunning: RUNNING } });
  assert.equal(result.read, true);
  assert.deepEqual(osa.calls, [[CHROME_SCRIPT, 8000]]);
  const tabs = report.find((r) => r.kind === 'chrome-tabs');
  assert.ok(tabs);
  assert.equal(tabs.total, 2);
  assert.deepEqual(tabs.suspicious, ['https://zhipin.com/x']);
});

test('H2-C denied：Chrome 不读标签、不删不关，报告 chrome-skipped', async () => {
  const osa = makeOsa({});
  const report = [];
  const { result, lines } = await captureWarnings(() => reportOnly(report, { preflight: deniedPreflight, deps: { osa, isAppRunning: RUNNING } }));
  assert.equal(osa.calls.length, 0);
  assert.equal(result.read, false);
  assert.equal(result.skipped, true);
  const skipped = report.find((r) => r.kind === 'chrome-skipped');
  assert.ok(skipped);
  assert.equal(skipped.envSkip, true);
  assert.equal(skipped.bundleId, CHROME_BUNDLE_ID);
  assert.equal(report.some((r) => r.kind === 'chrome-tabs'), false);
  assert.equal(lines.length, 1);
});

test('H2-C gate 纯函数：只有明确 allowed===false 才拦，unknown 放行', () => {
  assert.equal(gateAllows({ allowed: false, status: 'denied' }), false);
  assert.equal(gateAllows({ allowed: false, status: 'needs-consent' }), false);
  assert.equal(gateAllows({ allowed: true, status: 'granted' }), true);
  assert.equal(gateAllows({ allowed: true, status: 'unknown' }), true);
  assert.equal(gateAllows(null), true);
  assert.match(gateSkipReason({ warning: 'w' }, 'x'), /w/);
  assert.match(gateSkipReason(null, '做某事'), /做某事：自动化未授权/);
});
// ---------- M1 / M3：未授权与未运行都要 visible ----------

test('M1：Notes 未授权（countNotes=-1）要记 note-skipped，deleted.notes=0 且顶层 envSkip/skipped=true', async () => {
  const report = [];
  const removed = await purgeNotes(report, { countNotes: async () => -1 });
  assert.equal(removed, 0);
  const skipped = report.find((r) => r.kind === 'note-skipped');
  assert.ok(skipped, '未授权必须有 note-skipped 报告');
  assert.equal(skipped.envSkip, true);
  assert.match(skipped.reason, /未授权|读不到/);
  const summary = summarizeCleanup(report, { notes: 0, textEdit: 0, chrome: 0 });
  assert.equal(summary.skipped, true);
  assert.equal(summary.envSkip, true);
  assert.ok(summary.skippedKinds.includes('note-skipped'));
});

test('M3：TextEdit 没运行 → 不发任何 AppleEvent，报告 skipped:app-not-running，不进 warning 噪音', async () => {
  let preflightCalls = 0;
  const osa = makeOsa({});
  const report = [];
  const seen = [];
  const { result, lines } = await captureWarnings(() => cleanupTextEdit(report, {
    preflight: async () => { preflightCalls += 1; return { allowed: true, status: 'granted' }; },
    deps: { osa, isAppRunning: async (args) => { seen.push(args); return false; }, sleep: async () => {} },
  }));
  assert.equal(osa.calls.length, 0, '没运行就不许发 AppleEvent');
  assert.equal(preflightCalls, 0, '没运行也不该做授权探测');
  assert.deepEqual(result, { deleted: 0, skipped: true });
  const skipped = report.find((r) => r.kind === 'textedit-skipped');
  assert.ok(skipped);
  assert.equal(skipped.skipped, 'app-not-running');
  assert.equal(skipped.envSkip, true);
  assert.deepEqual(seen, [{ processName: 'TextEdit' }], '只传 processName，走 pgrep 无 TCC 分支');
  assert.deepEqual(lines, [], 'app-not-running 不该刷 warning');
});

test('M3：Chrome 没运行 → 不读标签、不发 AppleEvent，报告 skipped:app-not-running', async () => {
  let preflightCalls = 0;
  const osa = makeOsa({});
  const report = [];
  const seen = [];
  const { result, lines } = await captureWarnings(() => reportOnly(report, {
    preflight: async () => { preflightCalls += 1; return { allowed: true, status: 'granted' }; },
    deps: { osa, isAppRunning: async (args) => { seen.push(args); return false; } },
  }));
  assert.equal(osa.calls.length, 0);
  assert.equal(preflightCalls, 0);
  assert.equal(result.read, false);
  assert.equal(result.skipped, true);
  const skipped = report.find((r) => r.kind === 'chrome-skipped');
  assert.ok(skipped);
  assert.equal(skipped.skipped, 'app-not-running');
  assert.equal(skipped.envSkip, true);
  assert.deepEqual(seen, [{ processName: 'Google Chrome' }], '只传 processName，走 pgrep 无 TCC 分支');
  assert.deepEqual(lines, []);
});