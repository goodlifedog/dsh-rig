/**
 * 后台改写 BOSS 搜索框并读回校验，最后恢复用户原搜索词（会在用户 Chrome 里写）
 */
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ocu, guard } from '../agentd.mjs';

const APP = process.env.TARGET_APP || 'Google Chrome';
// H2：Chrome 标签的 AppleEvent 一律先过静默预检（未授权时不会发事件、不弹授权框）
const CHROME_BUNDLE_ID = 'com.google.Chrome';
const chromeAppleEventPreflight = createAppleEventPreflight({ bundleId: CHROME_BUNDLE_ID });
const APPLEEVENT_BLOCKED = Object.freeze({ code: -1, stdout: '', stderr: 'automation-not-authorized' });
const FRAG = 'zhipin.com/web/geek/jobs';
import { resolveOcu, isScreenLocked, lockedSkipNotice } from '../platform.mjs';
import { createAppleEventPreflight, runAppleEventGuarded } from '../appleevent-preflight.mjs';
import { classifyOsascriptError } from '../applescript-driver.mjs';
import { hidIdleMs } from '../front-watch.mjs';
import { shouldDeferForActiveUser } from '../user-activity.mjs';
import { isAppRunning } from '../background.mjs';
import { requireAppRunning, reportAppPresence } from '../app-presence.mjs';

import { isMac } from '../platform.mjs';
// 只有直接运行时才按平台退出：单测会 import 本模块，不能在 import 时 process.exit
const invokedDirectly = Boolean(process.argv[1])
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (!isMac && invokedDirectly) {
  console.error('此任务依赖 osascript 或 sky_key（macOS 专属），Windows 版待移植；跨平台通路验证请跑 platform-demo');
  process.exit(2);
}
const OCU = resolveOcu() || path.join(os.homedir(), '.local/bin/ocu');
const NEW_KEYWORD = process.env.FILL_KEYWORD || 'Java开发工程师';
const JS_TIMEOUT_MS = Number(process.env.FILL_JS_TIMEOUT_MS || 90000);

function run(cmd, args, { timeout = 120000 } = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({
        code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
        stdout: stdout || '',
        stderr: stderr || '',
      });
    });
  });
}

async function runOcuJs(source, marker) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'form-fill-'));
  try {
    const file = path.join(dir, 'inner.mjs');
    await writeFile(file, source, 'utf8');
    const result = await run(OCU, ['js', '--json', '--timeout', String(JS_TIMEOUT_MS), '--file', file], {
      timeout: JS_TIMEOUT_MS + 20000,
    });
    const stdout = result.stdout;
    if (!stdout) {
      await writeFile('/tmp/form-fill-raw.txt', 'STDERR: ' + result.stderr + '\nCODE: ' + result.code, 'utf8').catch(() => {});
      return null;
    }
    let items = [];
    try {
      const parsed = JSON.parse(stdout);
      if (Array.isArray(parsed.content)) items = parsed.content.filter((x) => x && x.type === 'text').map((x) => x.text);
    } catch {
      items = stdout.split('\n');
    }
    for (let i = items.length - 1; i >= 0; i--) {
      const text = items[i];
      if (typeof text !== 'string') continue;
      const at = text.lastIndexOf(marker);
      if (at < 0) continue;
      try { return JSON.parse(text.slice(at + marker.length)); } catch { await writeFile('/tmp/form-fill-raw.txt', 'PARSE_FAIL\n' + stdout + '\n---STDERR---\n' + result.stderr, 'utf8').catch(() => {}); return null; }
    }
    await writeFile('/tmp/form-fill-raw.txt', 'NO_MARKER\n' + stdout + '\n---STDERR---\n' + result.stderr, 'utf8').catch(() => {});
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// 用 AX 点标签页把 Chrome 切回 BOSS 职位页（后台，不激活窗口）；失败再用 AppleScript 兜底。
function buildSwitchTab() {
  return String.raw`
var APP = __APP__;
var FRAG = __FRAG__;
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function activeUrl(state) { var m = /HTML 内容.*?URL: (https?:\S+)/.exec(state); return m ? m[1] : null; }
var out = { before: null, after: null, switched: false, ok: false, attempts: [] };
try {
  var app = await cua.getApp(APP, { initialState: false });
  var opts = { emit: false, maxTreeNodes: 8000, maxTreeDepth: 96, textLimit: 500 };
  var s = await app.getAXState(opts);
  out.before = activeUrl(s);
  if (out.before && out.before.indexOf(FRAG) >= 0) { out.ok = true; out.after = out.before; }
  else {
    for (var attempt = 0; attempt < 3 && !out.ok; attempt++) {
      s = await app.getAXState(opts);
      var lines = s.split("\n"), tab = null;
      for (var i = 0; i < lines.length; i++) {
        var m = /^\t*(\d+)\s+标签\s+.*(BOSS直聘|zhipin)/i.exec(lines[i]);
        if (m) { tab = m[1]; break; }
      }
      if (!tab) { out.attempts.push("no-tab"); break; }
      try { await app.click(tab, { clickMethod: "accessibility" }); out.attempts.push("a11y-tab@" + tab); }
      catch (e) { out.attempts.push("a11y-tab:err"); }
      for (var p = 0; p < 3; p++) {
        await sleep(900);
        s = await app.getAXState(opts);
        out.after = activeUrl(s);
        if (out.after && out.after.indexOf(FRAG) >= 0) { out.ok = true; out.switched = true; break; }
      }
    }
  }
} catch (e) { out.error = String((e && e.message) || e); }
nodeRepl.write("SWITCH_TAB_JSON=" + JSON.stringify(out));
`
    .replaceAll('__APP__', JSON.stringify(APP))
    .replaceAll('__FRAG__', JSON.stringify(FRAG));
}

// H2：每个 AppleEvent 都先过 core/appleevent-preflight.mjs 的静默预检——
//   granted/unknown → 照旧执行（参数逐字不变）；denied/needs-consent → 不发事件，返回 skipped。
// options 仅供单测注入（run/preflight/onWarning），生产调用不传。
function classifyAppleEventFailure(stderrText) {
  const kind = classifyOsascriptError(stderrText);
  if (kind === 'denied' || kind === 'needs-consent') {
    return { skipped: 'not-authorized', warning: '自动化未授权（' + kind + '），已停止 AppleEvent（不弹授权框）' };
  }
  if (kind === 'app-not-running') {
    return { skipped: 'app-not-running', warning: 'Chrome 没在运行，AppleEvent 未执行（不为了测试启动它）' };
  }
  return null;
}

export async function switchTabByAppleScript(options = {}) {
  const opts = options || {};
  const call = typeof opts.run === 'function' ? opts.run : run;
  const preflight = typeof opts.preflight === 'function' ? opts.preflight : chromeAppleEventPreflight;
  const checkRunning = typeof opts.isAppRunning === 'function' ? opts.isAppRunning : isAppRunning;
  // M3：Chrome 没在运行时绝不发 AppleEvent（否则 tell 会把它拉起来，未授权时还可能弹框）
  let chromeRunning = false;
  try {
    chromeRunning = Boolean(await checkRunning({ bundleId: CHROME_BUNDLE_ID, appName: APP, processName: APP }));
  } catch {
    chromeRunning = false;
  }
  if (!chromeRunning) {
    return {
      ok: false,
      skipped: 'app-not-running',
      warning: 'Chrome 没在运行，不为了测试去启动它（AppleEvent 会把未运行的应用拉起来）',
    };
  }
  const onWarning = typeof opts.onWarning === 'function'
    ? opts.onWarning
    : ((message) => console.warn('⚠️ ' + message));
  const fragment = String(opts.fragment || FRAG);
  const guarded = (action, args) => runAppleEventGuarded({
    action,
    bundleId: CHROME_BUNDLE_ID,
    preflight,
    fallback: APPLEEVENT_BLOCKED,
    onWarning,
    run: () => call('osascript', args),
  });

  const tabs = await guarded('读取 Chrome 标签页（AppleEvent）', ['-e', 'tell application "Google Chrome" to get URL of every tab of window 1']);
  if (tabs.allowed === false) return { ok: false, skipped: 'not-authorized', warning: tabs.warning, error: tabs.warning };
  if (tabs.value.code !== 0) {
    const classified = classifyAppleEventFailure(tabs.value.stderr);
    if (classified) return { ok: false, ...classified, error: classified.warning };
    return { ok: false, error: tabs.value.stderr.trim() };
  }
  const list = tabs.value.stdout.split(', ').map((s) => s.trim());
  const index = list.findIndex((u) => u.includes(fragment));
  if (index < 0) return { ok: false, error: '没有 BOSS 职位页标签' };
  const set = await guarded('切换 Chrome 标签页（AppleEvent）', ['-e', 'tell application "Google Chrome" to set active tab index of window 1 to ' + (index + 1)]);
  if (set.allowed === false) return { ok: false, skipped: 'not-authorized', warning: set.warning, error: set.warning };
  if (set.value.code !== 0) {
    const classified = classifyAppleEventFailure(set.value.stderr);
    if (classified) return { ok: false, ...classified, error: classified.warning };
    // 其它失败保持原逻辑：不提前返回，交给后面读当前标签再判定
  }
  await new Promise((r) => setTimeout(r, 900));
  const check = await guarded('读取 Chrome 当前标签页（AppleEvent）', ['-e', 'tell application "Google Chrome" to get URL of active tab of window 1']);
  if (check.allowed === false) return { ok: false, skipped: 'not-authorized', warning: check.warning, error: check.warning };
  if (check.value.code !== 0) {
    const classified = classifyAppleEventFailure(check.value.stderr);
    if (classified) return { ok: false, ...classified, error: classified.warning };
    return { ok: false, error: check.value.stderr.trim() };
  }
  const url = check.value.stdout.trim();
  return { ok: url.includes(fragment), url, tabIndex: index + 1 };
}

// 内层：找到搜索框，记录原值 -> 改成新关键词 -> 读回校验 -> 恢复原值 -> 再校验。
function buildFill() {
  return String.raw`
var APP = __APP__;
var NEWVAL = __NEW__;
var FRAG = __FRAG__;
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function findSearch(state) {
  var lines = state.split("\n");
  for (var i = 0; i < lines.length; i++) {
    var m = /^\t*(\d+)\s+文本栏.*搜索职位、公司/.exec(lines[i]);
    if (m) return { index: m[1], line: lines[i].trim() };
  }
  return null;
}
function valueOf(line) { var m = /Value: (.*?)(?:, Placeholder:|$)/.exec(line || ""); return m ? m[1] : null; }
var out = { steps: [], ok: false };
var app = null;
var opts = { emit: false, maxTreeNodes: 8000, maxTreeDepth: 96, textLimit: 500 };

// 放在 try 外面：异常时 catch 里还要用它把用户原值写回去
async function writeValue(text, label) {
  for (var attempt = 1; attempt <= 4; attempt++) {
    var st = await app.getAXState(opts);
    var hit = findSearch(st);
    if (!hit) { await sleep(500); continue; }
    try { await app.click(hit.index, { clickMethod: "accessibility" }); } catch (e) {}
    await sleep(400);
    try { await app.pressKey("cmd+a", { keyMethod: "sky_key" }); } catch (e) {}
    await sleep(200);
    try { await app.typeText(text, { keyMethod: "sky_key" }); } catch (e) { out.steps.push(label + " type err"); }
    await sleep(600);
    st = await app.getAXState(opts);
    var now = valueOf((findSearch(st) || {}).line);
    out.steps.push(label + " attempt" + attempt + " -> " + JSON.stringify(now));
    if (now === text) return true;
  }
  return false;
}

try {
  app = await cua.getApp(APP, { initialState: false });
  var s = await app.getAXState(opts);
  out.url = (/HTML 内容.*?URL: (https?:\S+)/.exec(s) || [])[1] || null;
  var input = findSearch(s);
  out.found = input && input.line;
  out.original = input ? valueOf(input.line) : null;

  if (out.original !== null) {
    out.setNew = await writeValue(NEWVAL, "setNew");
    var s2 = await app.getAXState(opts);
    out.valueAfterNew = valueOf((findSearch(s2) || {}).line);
    out.restored = await writeValue(out.original, "restore");
    var s3 = await app.getAXState(opts);
    out.valueAfterRestore = valueOf((findSearch(s3) || {}).line);
    out.ok = out.setNew === true && out.restored === true && out.valueAfterRestore === out.original;
  }
} catch (e) {
  out.error = String((e && e.message) || e);
  // 中途抛异常也要把搜索框恢复成用户原来的值：停在测试关键词会影响用户下次使用
  try {
    if (app && out.original !== null) {
      out.restoredAfterError = await writeValue(out.original, "restore-after-error");
      var sErr = await app.getAXState(opts);
      out.valueAfterRestore = valueOf((findSearch(sErr) || {}).line);
    }
  } catch (e2) {
    out.restoreError = String((e2 && e2.message) || e2);
  }
  out.ok = false;
}
nodeRepl.write("FILL_JSON=" + JSON.stringify(out));
`
    .replaceAll('__APP__', JSON.stringify(APP))
    .replaceAll('__NEW__', JSON.stringify(NEW_KEYWORD))
    .replaceAll('__FRAG__', JSON.stringify(FRAG));
}

/**
 * 兜底恢复脚本：页面侧脚本整个崩掉、没留下恢复结果时，主进程再单独跑一次。
 * 只做「把搜索框写回原值」这一件事，参数只有原值和 APP，失败也会返回结构化结果。
 */
function buildRestore(original) {
  return String.raw`
var APP = __APP__;
var TARGET = __ORIG__;
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function findSearch(state) {
  var lines = state.split("\n");
  for (var i = 0; i < lines.length; i++) {
    var m = /^\t*(\d+)\s+文本栏.*搜索职位、公司/.exec(lines[i]);
    if (m) return { index: m[1], line: lines[i].trim() };
  }
  return null;
}
function valueOf(line) { var m = /Value: (.*?)(?:, Placeholder:|$)/.exec(line || ""); return m ? m[1] : null; }
try {
  var app = await cua.getApp(APP, { initialState: false });
  var opts = { emit: false, maxTreeNodes: 8000, maxTreeDepth: 96, textLimit: 500 };
  var ok = false;
  for (var attempt = 1; attempt <= 4 && !ok; attempt++) {
    var st = await app.getAXState(opts);
    var hit = findSearch(st);
    if (!hit) { await sleep(500); continue; }
    try { await app.click(hit.index, { clickMethod: "accessibility" }); } catch (e) {}
    await sleep(400);
    try { await app.pressKey("cmd+a", { keyMethod: "sky_key" }); } catch (e) {}
    await sleep(200);
    try { await app.typeText(TARGET, { keyMethod: "sky_key" }); } catch (e) {}
    await sleep(600);
    st = await app.getAXState(opts);
    ok = valueOf((findSearch(st) || {}).line) === TARGET;
  }
  nodeRepl.write("RESTORE_JSON=" + JSON.stringify({ ok: ok, target: TARGET }));
} catch (e) {
  nodeRepl.write("RESTORE_JSON=" + JSON.stringify({ ok: false, error: String((e && e.message) || e) }));
}
`
    .replaceAll('__APP__', JSON.stringify(APP))
    .replaceAll('__ORIG__', JSON.stringify(original));
}

async function main() {
  // 锁屏下 AX/抓图不可用：这是环境限制，不是任务失败（手动跑也不该红）
  if (await isScreenLocked()) {
    console.log(lockedSkipNotice('form-fill.mjs'));
    return;
  }
  // 运行检查放在最前面（比后面的「Chrome 是前台就拒绝」更早）：Chrome 没运行就直接环境跳过，
  // 因为 ocu 的 get_app_state/snapshot 会把未运行的 Chrome 拉起来（带登录 profile）并顶到前台。
  const presence = await requireAppRunning(APP, { isAppRunning });
  if (reportAppPresence(presence)) return;
  // 这个任务会往你 Chrome 的 BOSS 页面里改搜索框：你正在用电脑时不做，免得打断输入
  const activity = shouldDeferForActiveUser(await hidIdleMs());
  if (activity.defer) {
    console.log('环境跳过：' + activity.reason);
    return;
  }
  const evidence = { steps: [] };
  const frontBefore = await ocu.frontmost();
  evidence.frontmostBefore = frontBefore;
  console.log('[1] 初始前台:', frontBefore);
  if (frontBefore === APP) throw new Error('Chrome 当前就是前台，为避免干扰用户，拒绝执行');

  console.log('[2] 确认/切回 BOSS 职位页 …');
  let tab = await runOcuJs(buildSwitchTab(), 'SWITCH_TAB_JSON=');
  if (!tab || !tab.ok) {
    const as = await switchTabByAppleScript();
    tab = Object.assign({}, tab || {}, { appleScript: as, ok: as.ok, after: as.url });
    if (as.skipped) {
      // 未授权 / Chrome 没在运行都不是失败：按环境跳过退出 0（L6 补结构化 JSON，和 boss-scan 一致）
      const reason = as.skipped === 'not-authorized' ? 'automation-not-authorized' : 'chrome-not-running';
      console.log('环境跳过：' + (as.warning || reason));
      console.log(JSON.stringify({ ok: true, skipped: true, reason, detail: as.warning || '' }, null, 2));
      return;
    }
  }
  evidence.tabSwitch = { ok: !!(tab && tab.ok), before: tab && tab.before, after: tab && tab.after, attempts: tab && tab.attempts };
  console.log('    ok=', evidence.tabSwitch.ok, 'url=', evidence.tabSwitch.after);
  if (!evidence.tabSwitch.ok) throw new Error('无法切回 BOSS 职位页：' + JSON.stringify(tab));

  console.log('[3] 后台改写搜索框 + 读回校验 + 恢复 …');
  const guarded = await guard(APP, async () => runOcuJs(buildFill(), 'FILL_JSON='), { label: '表单写入完成' });
  const fill = guarded.result;
  evidence.fill = fill;
  evidence.frontmostDuringWrite = { before: guarded.before, after: guarded.after };
  console.log('    前台:', guarded.before, '->', guarded.after);
  if (!fill) throw new Error('没有拿到写入结果');
  console.log('    原值:', JSON.stringify(fill.original));
  console.log('    新值:', JSON.stringify(fill.valueAfterNew));
  console.log('    恢复:', JSON.stringify(fill.valueAfterRestore));
  console.log('    步骤:', JSON.stringify(fill.steps));

  // 页面侧脚本如果整个崩了（拿不到结果/没走到恢复），主进程再单独恢复一次：
  // 搜索框停在测试关键词会影响用户下一次使用，这一层不能省。
  let restoredValue = fill.valueAfterRestore === undefined ? null : fill.valueAfterRestore;
  if (fill.original !== null && fill.original !== undefined && restoredValue !== fill.original) {
    console.log('    恢复未确认，主进程再试一次 …');
    const fallback = await runOcuJs(buildRestore(fill.original), 'RESTORE_JSON=').catch(() => null);
    evidence.restoreFallback = fallback;
    if (fallback && fallback.ok) restoredValue = fill.original;
    else console.log('    ⚠️ 搜索框可能仍停在测试值，请手动恢复原搜索词：' + fill.original);
  }

  const frontAfter = await ocu.frontmost();
  evidence.frontmostAfter = frontAfter;
  console.log('[4] 结束前台:', frontAfter);

  const checks = [
    ['搜索框定位成功', !!fill.found],
    ['改成了指定关键词', fill.valueAfterNew === NEW_KEYWORD],
    ['已恢复原值', fill.original !== null && restoredValue === fill.original],
    ['全程前台不是 Chrome', frontBefore !== APP && frontAfter !== APP && guarded.after !== APP],
  ];
  console.log('');
  console.log('--- 验收 ---');
  let allPass = true;
  for (const [name, pass] of checks) {
    console.log((pass ? '  PASS  ' : '  FAIL  ') + name);
    if (!pass) allPass = false;
  }
  evidence.acceptance = Object.fromEntries(checks);
  evidence.ok = allPass;
  console.log('结果:', allPass ? '全部通过' : '存在失败项');
  console.log(JSON.stringify(evidence, null, 2));
  return allPass ? 0 : 1;
}

// 已知环境条件用显式「环境跳过」声明，由分类器按跳过处理；
// 断言失败（页面结构变了/改不成关键词）仍然按 FAIL 报真失败，不许再借环境规则洗掉。
const ENV_CONDITIONS = /当前就是前台|无法切回 BOSS 职位页|没有 BOSS 职位页标签/;

if (invokedDirectly) {
  main()
    .then((code) => process.exit(code))
    .catch((e) => {
      const message = String((e && e.message) || e);
      if (ENV_CONDITIONS.test(message)) {
        console.log('环境跳过：' + message);
        process.exit(0);
      }
      console.error('FAIL:', message);
      process.exit(1);
    });
}

export { buildFill, buildRestore };