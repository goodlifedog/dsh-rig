import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { ocu, guard } from '../agentd.mjs';

const APP = process.env.TARGET_APP || 'Google Chrome';
const FRAG = 'zhipin.com/web/geek/jobs';
import { resolveOcu } from '../platform.mjs';

import { isMac } from '../platform.mjs';
if (!isMac) {
  console.error('此任务依赖 macOS 的 ocu/osascript，Windows 版待移植；跨平台通路验证请跑 platform-demo');
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

async function switchTabByAppleScript() {
  const tabs = await run('osascript', ['-e', 'tell application "Google Chrome" to get URL of every tab of window 1']);
  if (tabs.code !== 0) return { ok: false, error: tabs.stderr.trim() };
  const list = tabs.stdout.split(', ').map((s) => s.trim());
  const index = list.findIndex((u) => u.includes(FRAG));
  if (index < 0) return { ok: false, error: '没有 BOSS 职位页标签' };
  await run('osascript', ['-e', 'tell application "Google Chrome" to set active tab index of window 1 to ' + (index + 1)]);
  await new Promise((r) => setTimeout(r, 900));
  const check = await run('osascript', ['-e', 'tell application "Google Chrome" to get URL of active tab of window 1']);
  return { ok: check.stdout.trim().includes(FRAG), url: check.stdout.trim(), tabIndex: index + 1 };
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
try {
  var app = await cua.getApp(APP, { initialState: false });
  var opts = { emit: false, maxTreeNodes: 8000, maxTreeDepth: 96, textLimit: 500 };
  var s = await app.getAXState(opts);
  out.url = (/HTML 内容.*?URL: (https?:\S+)/.exec(s) || [])[1] || null;
  var input = findSearch(s);
  out.found = input && input.line;
  out.original = input ? valueOf(input.line) : null;

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

  if (out.original !== null) {
    out.setNew = await writeValue(NEWVAL, "setNew");
    var s2 = await app.getAXState(opts);
    out.valueAfterNew = valueOf((findSearch(s2) || {}).line);
    out.restored = await writeValue(out.original, "restore");
    var s3 = await app.getAXState(opts);
    out.valueAfterRestore = valueOf((findSearch(s3) || {}).line);
    out.ok = out.setNew === true && out.restored === true && out.valueAfterRestore === out.original;
  }
} catch (e) { out.error = String((e && e.message) || e); }
nodeRepl.write("FILL_JSON=" + JSON.stringify(out));
`
    .replaceAll('__APP__', JSON.stringify(APP))
    .replaceAll('__NEW__', JSON.stringify(NEW_KEYWORD))
    .replaceAll('__FRAG__', JSON.stringify(FRAG));
}

async function main() {
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

  const frontAfter = await ocu.frontmost();
  evidence.frontmostAfter = frontAfter;
  console.log('[4] 结束前台:', frontAfter);

  const checks = [
    ['搜索框定位成功', !!fill.found],
    ['改成了指定关键词', fill.valueAfterNew === NEW_KEYWORD],
    ['已恢复原值', fill.ok === true && fill.valueAfterRestore === fill.original],
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

main()
  .then((code) => process.exit(code))
  .catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
