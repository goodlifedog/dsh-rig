/**
 * 通用表单填充：在 Chrome 当前页面里找一个可写文本栏，写入指定值、读回校验、再恢复原值。
 *
 * 不依赖任何具体站点：页面里没有可写的文本栏就按「环境跳过」退出 0，不判失败。
 *
 *   FILL_KEYWORD="hello world" node core/tasks/form-fill.mjs
 *
 * 环境变量：
 *   TARGET_APP      目标应用（默认 Google Chrome）
 *   FILL_KEYWORD    要写入的临时值（默认 form-fill-test）
 *   FILL_JS_TIMEOUT_MS  页内脚本超时（默认 90000）
 */
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { ocu, guard } from '../agentd.mjs';
import { resolveOcu, isScreenLocked, lockedSkipNotice } from '../platform.mjs';
import { hidIdleMs } from '../front-watch.mjs';
import { shouldDeferForActiveUser } from '../user-activity.mjs';
import { isAppRunning } from '../background.mjs';
import { requireAppRunning, reportAppPresence } from '../app-presence.mjs';
import { isMac } from '../platform.mjs';
import { isDirectRun } from '../direct-run.mjs';

// 只有直接运行时才按平台退出：单测会 import 本模块，不能在 import 时 process.exit
const invokedDirectly = isDirectRun(import.meta.url);
if (!isMac && invokedDirectly) {
  console.error('此任务依赖 osascript 或 sky_key（macOS 专属），Windows 版待移植；跨平台通路验证请跑 platform-demo');
  process.exit(2);
}

const APP = process.env.TARGET_APP || 'Google Chrome';
const OCU = resolveOcu() || path.join(os.homedir(), '.local/bin/ocu');
const NEW_VALUE = process.env.FILL_KEYWORD || 'form-fill-test';
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

// 内层：找到可写文本栏，记录原值 -> 改成新值 -> 读回校验 -> 恢复原值 -> 再校验。
function buildFill() {
  return String.raw`
var APP = __APP__;
var NEWVAL = __NEW__;
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
// 通用定位：先按无障碍 role 找文本类输入框（中英文 role 都认），
// 找不到再退一步，挑第一个带 Value: 的可写行。不依赖任何具体站点的文案。
function findField(state) {
  var lines = state.split("\n");
  var re = /^\t*(\d+)\s+(文本栏|文本框|搜索框|text field|search field|text area|combo box)\b/i;
  for (var i = 0; i < lines.length; i++) {
    var m = re.exec(lines[i]);
    if (m) return { index: m[1], line: lines[i].trim() };
  }
  for (var j = 0; j < lines.length; j++) {
    if (/^\t*\d+\s+/.test(lines[j]) && /Value: /.test(lines[j]) && !/button|link|菜单|menu/i.test(lines[j])) {
      var m2 = /^\t*(\d+)\s+/.exec(lines[j]);
      if (m2) return { index: m2[1], line: lines[j].trim() };
    }
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
    var hit = findField(st);
    if (!hit) { await sleep(500); continue; }
    try { await app.click(hit.index, { clickMethod: "accessibility" }); } catch (e) {}
    await sleep(400);
    try { await app.pressKey("cmd+a", { keyMethod: "sky_key" }); } catch (e) {}
    await sleep(200);
    try { await app.typeText(text, { keyMethod: "sky_key" }); } catch (e) { out.steps.push(label + " type err"); }
    await sleep(600);
    st = await app.getAXState(opts);
    var now = valueOf((findField(st) || {}).line);
    out.steps.push(label + " attempt" + attempt + " -> " + JSON.stringify(now));
    if (now === text) return true;
  }
  return false;
}

try {
  app = await cua.getApp(APP, { initialState: false });
  var s = await app.getAXState(opts);
  out.url = (/HTML 内容.*?URL: (https?:\S+)/.exec(s) || [])[1] || null;
  var input = findField(s);
  out.found = input && input.line;
  out.original = input ? valueOf(input.line) : null;
  if (!input) out.noField = true;

  if (input) {
    out.setNew = await writeValue(NEWVAL, "setNew");
    var s2 = await app.getAXState(opts);
    out.valueAfterNew = valueOf((findField(s2) || {}).line);
    out.restored = await writeValue(out.original, "restore");
    var s3 = await app.getAXState(opts);
    out.valueAfterRestore = valueOf((findField(s3) || {}).line);
    out.ok = out.setNew === true && out.restored === true && out.valueAfterRestore === out.original;
  }
} catch (e) {
  out.error = String((e && e.message) || e);
  // 中途抛异常也要把输入框恢复成用户原来的值：停在测试值会影响用户下次使用
  try {
    if (app && out.original !== null && out.original !== undefined) {
      out.restoredAfterError = await writeValue(out.original, "restore-after-error");
      var sErr = await app.getAXState(opts);
      out.valueAfterRestore = valueOf((findField(sErr) || {}).line);
    }
  } catch (e2) {
    out.restoreError = String((e2 && e2.message) || e2);
  }
  out.ok = false;
}
nodeRepl.write("FILL_JSON=" + JSON.stringify(out));
`
    .replaceAll('__APP__', JSON.stringify(APP))
    .replaceAll('__NEW__', JSON.stringify(NEW_VALUE));
}

/**
 * 兜底恢复脚本：页面侧脚本整个崩掉、没留下恢复结果时，主进程再单独跑一次。
 * 只做「把输入框写回原值」这一件事，参数只有原值和 APP，失败也会返回结构化结果。
 */
function buildRestore(original) {
  return String.raw`
var APP = __APP__;
var TARGET = __ORIG__;
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function findField(state) {
  var lines = state.split("\n");
  var re = /^\t*(\d+)\s+(文本栏|文本框|搜索框|text field|search field|text area|combo box)\b/i;
  for (var i = 0; i < lines.length; i++) {
    var m = re.exec(lines[i]);
    if (m) return { index: m[1], line: lines[i].trim() };
  }
  for (var j = 0; j < lines.length; j++) {
    if (/^\t*\d+\s+/.test(lines[j]) && /Value: /.test(lines[j]) && !/button|link|菜单|menu/i.test(lines[j])) {
      var m2 = /^\t*(\d+)\s+/.exec(lines[j]);
      if (m2) return { index: m2[1], line: lines[j].trim() };
    }
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
    var hit = findField(st);
    if (!hit) { await sleep(500); continue; }
    try { await app.click(hit.index, { clickMethod: "accessibility" }); } catch (e) {}
    await sleep(400);
    try { await app.pressKey("cmd+a", { keyMethod: "sky_key" }); } catch (e) {}
    await sleep(200);
    try { await app.typeText(TARGET, { keyMethod: "sky_key" }); } catch (e) {}
    await sleep(600);
    st = await app.getAXState(opts);
    ok = valueOf((findField(st) || {}).line) === TARGET;
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
    return 0;
  }
  // 运行检查放在最前面（比后面的「Chrome 是前台就拒绝」更早）：Chrome 没运行就直接环境跳过，
  // 因为 ocu 的 get_app_state/snapshot 会把未运行的 Chrome 拉起来（带登录 profile）并顶到前台。
  const presence = await requireAppRunning(APP, { isAppRunning });
  if (reportAppPresence(presence)) return 0;
  // 这个任务会往当前页面里写东西：你正在用电脑时不做，免得打断输入
  const activity = shouldDeferForActiveUser(await hidIdleMs());
  if (activity.defer) {
    console.log('环境跳过：' + activity.reason);
    return 0;
  }
  const evidence = { steps: [] };
  const frontBefore = await ocu.frontmost();
  evidence.frontmostBefore = frontBefore;
  console.log('[1] 初始前台:', frontBefore);
  if (frontBefore === APP) throw new Error('Chrome 当前就是前台，为避免干扰用户，拒绝执行');

  console.log('[2] 后台写入表单 + 读回校验 + 恢复 …');
  const guarded = await guard(APP, async () => runOcuJs(buildFill(), 'FILL_JSON='), { label: '表单写入完成' });
  const fill = guarded.result;
  evidence.fill = fill;
  evidence.frontmostDuringWrite = { before: guarded.before, after: guarded.after };
  console.log('    前台:', guarded.before, '->', guarded.after);
  if (!fill) throw new Error('没有拿到写入结果');
  // 页面里一个可写文本栏都没有：不是能力缺失，是当前页面不适合这个任务
  if (fill.noField) {
    console.log('环境跳过：当前页面没有可写的文本栏（url=' + (fill.url || '未知') + '）');
    console.log(JSON.stringify({ ok: true, skipped: true, reason: 'no-form-field', detail: fill.url || '' }, null, 2));
    return 0;
  }
  console.log('    原值:', JSON.stringify(fill.original));
  console.log('    新值:', JSON.stringify(fill.valueAfterNew));
  console.log('    恢复:', JSON.stringify(fill.valueAfterRestore));
  console.log('    步骤:', JSON.stringify(fill.steps));

  // 页面侧脚本如果整个崩了（拿不到结果/没走到恢复），主进程再单独恢复一次：
  // 输入框停在测试值会影响用户下一次使用，这一层不能省。
  let restoredValue = fill.valueAfterRestore === undefined ? null : fill.valueAfterRestore;
  if (fill.original !== null && fill.original !== undefined && restoredValue !== fill.original) {
    console.log('    恢复未确认，主进程再试一次 …');
    const fallback = await runOcuJs(buildRestore(fill.original), 'RESTORE_JSON=').catch(() => null);
    evidence.restoreFallback = fallback;
    if (fallback && fallback.ok) restoredValue = fill.original;
    else console.log('    ⚠️ 输入框可能仍停在测试值，请手动恢复原内容：' + fill.original);
  }

  const frontAfter = await ocu.frontmost();
  evidence.frontmostAfter = frontAfter;
  console.log('[3] 结束前台:', frontAfter);

  const checks = [
    ['文本框定位成功', !!fill.found],
    ['改成了指定值', fill.valueAfterNew === NEW_VALUE],
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
// 断言失败（页面结构变了/写不成指定值）仍然按 FAIL 报真失败，不许再借环境规则洗掉。
const ENV_CONDITIONS = /当前就是前台|没有可写的文本栏/;

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
