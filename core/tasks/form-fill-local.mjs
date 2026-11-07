import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * 本地对照：起一个最小 HTML 表单页（file:// + Electron accessory 窗口，不抢焦点），
 * 用同一套 ocu 流程填 文本框 / contenteditable / select(下拉) / select(listbox) / checkbox，
 * 再读回 AX 校验。没有 submit，不提交任何表单。
 */

import { resolveOcu, isScreenLocked, lockedSkipNotice } from '../platform.mjs';

import { isMac } from '../platform.mjs';
if (!isMac) {
  console.error('此任务依赖 osascript 或 sky_key（macOS 专属），Windows 版待移植；跨平台通路验证请跑 platform-demo');
  process.exit(2);
}
const OCU = resolveOcu() || path.join(os.homedir(), '.local/bin/ocu');
// 用一个独立 bundle id 的 Electron 副本承载本地表单：
// overlay 本身也是 Electron(com.github.Electron)，同名会撞车，且我们不想弹窗打扰用户。
const HOST_APP = process.env.FORM_HOST_APP || '/tmp/OCUFormHost.app';
const HOST_APP_NAME = 'OCU Form Host';
const HOST_BUNDLE_ID = 'com.local.ocuformhost';
const HOST_APP_BINARY = path.join(HOST_APP, 'Contents/MacOS/Electron');
const ELECTRON_SRC = process.env.FORM_HOST_ELECTRON
  || path.join(os.homedir(), 'Desktop/desktop-agent/desktop-agent/overlay/node_modules/electron/dist/Electron.app');
const JS_TIMEOUT_MS = Number(process.env.FILL_JS_TIMEOUT_MS || 90000);

const TEXT_VALUE = 'OCU-TEXT-9527';
const EDIT_VALUE = 'OCU-EDIT-9527';
const SELECT_TARGET = '上海 Shanghai';

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
  const dir = await mkdtemp('/tmp/form-fill-local-');
  try {
    const file = path.join(dir, 'inner.mjs');
    await writeFile(file, source, 'utf8');
    const result = await run(OCU, ['js', '--json', '--timeout', String(JS_TIMEOUT_MS), '--file', file], {
      timeout: JS_TIMEOUT_MS + 20000,
    });
    const stdout = result.stdout;
    await writeFile('/tmp/form-fill-local-last-inner.mjs', source, 'utf8').catch(() => {});
    await writeFile('/tmp/form-fill-local-run.json', JSON.stringify({ code: result.code, stdout: stdout, stderr: String(result.stderr || '') }), 'utf8').catch(() => {});
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
      try { return JSON.parse(text.slice(at + marker.length)); } catch { await writeFile('/tmp/form-fill-local-raw.txt', 'PARSE_FAIL\n' + stdout + '\n---STDERR---\n' + String(result.stderr || ''), 'utf8').catch(() => {}); return null; }
    }
    await writeFile('/tmp/form-fill-local-raw.txt', 'NO_MARKER\n' + stdout + '\n---STDERR---\n' + String(result.stderr || ''), 'utf8').catch(() => {});
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

const FORM_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>OCU Form Write Test</title>
<style>
  body { font: 16px -apple-system, sans-serif; padding: 32px; max-width: 640px; }
  h1 { font-size: 20px; }
  label { display: block; margin: 16px 0; }
  input[type=text], select, #bio { font-size: 15px; padding: 6px 8px; margin-left: 8px; min-width: 260px; }
  #bio { border: 1px solid #999; min-height: 48px; margin-top: 6px; }
  .hint { color: #666; font-size: 13px; }
</style>
</head>
<body>
  <h1>OCU 后台写操作对照表单</h1>
  <p class="hint">仅用于验证 AX 写入能力；没有 submit，按钮点了也不会提交。</p>
  <form id="f" onsubmit="return false">
    <label>姓名 <input id="name" type="text" placeholder="请输入姓名" value="原值A"></label>
    <label>简介
      <div id="bio" contenteditable="true" role="textbox" aria-label="简介" tabindex="0">原始简介文本</div>
    </label>
    <label>城市（下拉）
      <select id="city">
        <option value="bj">北京 Beijing</option>
        <option value="sh">上海 Shanghai</option>
        <option value="wh" selected>武汉 Wuhan</option>
      </select>
    </label>
    <label>城市（列表）
      <select id="city2" size="3" aria-label="城市列表">
        <option value="bj">北京 Beijing</option>
        <option value="sh">上海 Shanghai</option>
        <option value="wh" selected>武汉 Wuhan</option>
      </select>
    </label>
    <label><input id="agree" type="checkbox"> 同意条款</label>
    <button type="button" id="noop">无动作按钮</button>
  </form>
  <pre id="out" class="hint"></pre>
</body>
</html>
`;

const HOST_JS = `const { app, BrowserWindow } = require('electron');
// accessory + 完全透明 + 屏幕外：AX 可读、能收键盘，但用户完全看不到，也不会抢焦点。
app.dock.hide();
app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 820,
    height: 780,
    show: false,
    frame: false,
    opacity: 0,
    x: -5000,
    y: -5000,
    skipTaskbar: true,
  });
  win.loadFile(process.env.FORM_HTML_PATH);
  win.once('ready-to-show', () => win.showInactive());
});
app.on('window-all-closed', () => app.quit());
`;

const INNER = String.raw`var APP = __APP__;
var FRAG = __FRAG__;
var TEXT_V = __TEXT__;
var EDIT_V = __EDIT__;
var SEL_T = __SEL__;
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function find(state, re) {
  var ls = state.split("\n");
  for (var i = 0; i < ls.length; i++) {
    var m = /^\t*(\d+)\s/.exec(ls[i]);
    if (m && re.test(ls[i])) return { index: m[1], line: ls[i].trim() };
  }
  return null;
}
function lineOf(state, re) { var hit = find(state, re); return hit && hit.line; }
function valueOf(line) { var m = /Value: (.*?)(?:, Placeholder:|$)/.exec(line || ""); return m ? m[1] : null; }

var out = { steps: [], ok: false };
try {
  var app = await cua.getApp(APP, { initialState: false });
  var opts = { emit: false, maxTreeNodes: 6000, maxTreeDepth: 96, textLimit: 500 };
  var s = await app.getAXState(opts);
  out.url = (/HTML 内容.*?URL: (file:\/\/\S+)/.exec(s) || [])[1] || null;

  // ---- 1) 文本输入框：click 聚焦 + cmd+a 全选 + sky_key 键入 ----
  var t = find(s, /文本栏.*请输入姓名/);
  out.textInput = { before: t && t.line };
  out.textOk = false;
  for (var ta = 1; ta <= 3 && !out.textOk; ta++) {
    var st = await app.getAXState(opts);
    var hit = find(st, /文本栏.*请输入姓名/);
    if (!hit) { await sleep(400); continue; }
    try { await app.click(hit.index, { clickMethod: "accessibility" }); } catch (e) {}
    await sleep(400);
    try { await app.pressKey("cmd+a", { keyMethod: "sky_key" }); } catch (e) {}
    try { await app.typeText(TEXT_V, { keyMethod: "sky_key" }); } catch (e) { out.steps.push("text type err"); }
    await sleep(600);
    st = await app.getAXState(opts);
    out.textInput.after = lineOf(st, /文本栏.*请输入姓名/);
    out.textOk = String(out.textInput.after || "").indexOf(TEXT_V) >= 0;
    if (!out.textOk) out.steps.push("text attempt" + ta + " failed");
  }

  // ---- 2) contenteditable：同样方式 ----
  s = await app.getAXState(opts);
  var c = find(s, /文本输入区.*简介/);
  out.editable = { before: c && c.line };
  out.editableOk = false;
  for (var ea = 1; ea <= 3 && !out.editableOk; ea++) {
    var st2 = await app.getAXState(opts);
    var ch = find(st2, /文本输入区.*简介/);
    if (!ch) { await sleep(400); continue; }
    try { await app.click(ch.index, { clickMethod: "accessibility" }); } catch (e) {}
    await sleep(400);
    try { await app.pressKey("cmd+a", { keyMethod: "sky_key" }); } catch (e) {}
    try { await app.typeText(EDIT_V, { keyMethod: "sky_key" }); } catch (e) {}
    await sleep(600);
    st2 = await app.getAXState(opts);
    out.editable.after = lineOf(st2, /文本输入区.*简介/);
    out.editableOk = String(out.editable.after || "").indexOf(EDIT_V) >= 0;
    if (!out.editableOk) out.steps.push("editable attempt" + ea + " failed");
  }

  // ---- 3) select（下拉/popup）：先点开，AX 会暴露菜单项，再点选项 ----
  s = await app.getAXState(opts);
  var pop = find(s, /弹出式按钮.*城市（下拉）/);
  out.selectPopup = { before: pop && pop.line };
  out.selectPopupOk = false;
  for (var sa = 1; sa <= 3 && !out.selectPopupOk; sa++) {
    var st3 = await app.getAXState(opts);
    var p = find(st3, /弹出式按钮.*城市（下拉）/);
    if (!p) { await sleep(400); continue; }
    if (String(p.line).indexOf("expanded") < 0) {
      try { await app.click(p.index, { clickMethod: "accessibility" }); } catch (e) {}
      await sleep(700);
      st3 = await app.getAXState(opts);
    }
    var item = find(st3, /菜单项.*上海 Shanghai/);
    out.selectPopup.menuSeen = !!item;
    if (item) {
      try { await app.click(item.index, { clickMethod: "accessibility" }); } catch (e) {}
      await sleep(600);
      st3 = await app.getAXState(opts);
      out.selectPopup.after = lineOf(st3, /弹出式按钮.*城市（下拉）/);
      out.selectPopupOk = valueOf(out.selectPopup.after) === SEL_T;
    }
    // 选完按 Esc 确保原生下拉菜单收起，避免在屏幕上留下菜单窗口
    try { await app.pressKey("Escape", { keyMethod: "sky_key" }); } catch (e) {}
    await sleep(300);
    if (!out.selectPopupOk) out.steps.push("select popup attempt" + sa + " failed");
  }

  // ---- 4) select（listbox）：直接点选项 ----
  s = await app.getAXState(opts);
  out.selectList = { before: lineOf(s, /列表框/) };
  out.selectListOk = false;
  var bj = find(s, /菜单项 Value: 北京 Beijing/);
  if (bj) {
    try { await app.click(bj.index, { clickMethod: "accessibility" }); } catch (e) {}
    await sleep(600);
    s = await app.getAXState(opts);
    out.selectList.after = lineOf(s, /菜单项 \(selected\) Value: 北京 Beijing/);
    out.selectListOk = !!out.selectList.after;
  } else {
    out.steps.push("no listbox option 北京");
  }

  // ---- 5) checkbox：AXPress 切换 ----
  s = await app.getAXState(opts);
  out.checkbox = { before: lineOf(s, /复选框.*同意条款/) };
  out.checkboxOk = false;
  var cb = find(s, /复选框.*同意条款/);
  if (cb) {
    try { await app.click(cb.index, { clickMethod: "accessibility" }); } catch (e) {}
    await sleep(500);
    s = await app.getAXState(opts);
    out.checkbox.after = lineOf(s, /复选框.*同意条款/);
    out.checkboxOk = /Value: on/.test(out.checkbox.after || "");
  }

  out.ok = out.textOk && out.editableOk && out.selectPopupOk && out.selectListOk && out.checkboxOk;
} catch (e) { out.error = String((e && e.message) || e); }
nodeRepl.write("LOCAL_FILL_JSON=" + JSON.stringify(out));
`
  .replaceAll('__APP__', JSON.stringify(HOST_APP_NAME))
  .replaceAll('__FRAG__', JSON.stringify('ocu-form-write'))
  .replaceAll('__TEXT__', JSON.stringify(TEXT_VALUE))
  .replaceAll('__EDIT__', JSON.stringify(EDIT_VALUE))
  .replaceAll('__SEL__', JSON.stringify(SELECT_TARGET));

function frontmost() {
  return new Promise((resolve) => {
    execFile('osascript', ['-e', 'tell application "System Events" to get name of first application process whose frontmost is true'], { encoding: 'utf8' }, (err, stdout) => {
      resolve((stdout || '').trim());
    });
  });
}

async function waitForHostWindow(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    const snap = await run(OCU, ['snapshot', '--max-tree-nodes', '4000', HOST_APP_NAME]);
    last = snap.stdout || snap.stderr;
    if (last.indexOf('OCU Form Write Test') >= 0) return { ok: true, snapshot: last };
    await new Promise((r) => setTimeout(r, 700));
  }
  return { ok: false, snapshot: last };
}

// 准备一个独立 bundle id 的 Electron 副本（一次性，约 263MB）。
// 目的：不和 overlay 的 Electron 撞名，并且宿主窗口始终透明+屏幕外，不打扰用户。
async function ensureHostApp() {
  if (existsSync(HOST_APP_BINARY)) return { ok: true, binary: HOST_APP_BINARY, cached: true };
  if (!existsSync(ELECTRON_SRC)) return { ok: false, error: '找不到 Electron.app：' + ELECTRON_SRC };
  console.log('    首次运行：从 Electron.app 复制独立宿主（约 263MB，一次性）…');
  const cp = await run('cp', ['-R', ELECTRON_SRC, HOST_APP], { timeout: 180000 });
  if (cp.code !== 0) return { ok: false, error: '复制失败: ' + cp.stderr };
  const pb = path.join(HOST_APP, 'Contents/Info.plist');
  await run('/usr/libexec/PlistBuddy', ['-c', 'Set :CFBundleIdentifier ' + HOST_BUNDLE_ID, pb]);
  await run('/usr/libexec/PlistBuddy', ['-c', 'Set :CFBundleName OCUFormHost', pb]);
  await run('/usr/libexec/PlistBuddy', ['-c', 'Set :CFBundleDisplayName ' + HOST_APP_NAME, pb]);
  await run('codesign', ['--force', '--deep', '--sign', '-', HOST_APP], { timeout: 180000 });
  return { ok: existsSync(HOST_APP_BINARY), binary: HOST_APP_BINARY, cached: false };
}

async function main() {
  // 锁屏下 AX/抓图不可用：这是环境限制，不是任务失败（手动跑也不该红）
  if (await isScreenLocked()) {
    console.log(lockedSkipNotice('form-fill-local.mjs'));
    return;
  }
  const evidence = {};
  const frontBefore = await frontmost();
  evidence.frontmostBefore = frontBefore;
  console.log('[1] 初始前台:', frontBefore || '(unknown)');
  if (frontBefore === 'Google Chrome') throw new Error('Chrome 当前是前台，拒绝执行（请等 Chrome 不在前台时再跑）');

  const host = await ensureHostApp();
  console.log('[2] 本地宿主 App:', HOST_APP, host.ok ? (host.cached ? 'OK（复用）' : 'OK（已创建）') : '不可用');
  if (!host.ok) throw new Error('本地宿主不可用：' + host.error);

  const dir = await mkdtemp('/tmp/ocu-form-host-');
  const htmlPath = path.join(dir, 'form.html');
  const hostPath = path.join(dir, 'host.js');
  await writeFile(htmlPath, FORM_HTML, 'utf8');
  await writeFile(hostPath, HOST_JS, 'utf8');

  const env = Object.assign({}, process.env, { FORM_HTML_PATH: htmlPath });
  delete env.ELECTRON_RUN_AS_NODE;
  console.log('[3] 后台启动本地宿主（独立 bundle、透明窗口在屏幕外，不弹窗/不抢焦点）…');
  const child = spawn(host.binary, [hostPath], { env, stdio: 'ignore', detached: false });

  let fill = null;
  try {
    const ready = await waitForHostWindow(20000);
    evidence.hostWindowReady = ready.ok;
    console.log('    窗口就绪:', ready.ok);
    if (!ready.ok) {
      throw new Error('Electron 宿主窗口没起来（可能是 Electron 被其它实例接管）:\n' + String(ready.snapshot).slice(0, 800));
    }
    const frontDuring = await frontmost();
    evidence.frontmostDuring = frontDuring;
    console.log('    启动后前台:', frontDuring || '(unknown)');

    console.log('[4] 执行后台写入 + 读回校验 …');
    fill = await runOcuJs(INNER, 'LOCAL_FILL_JSON=');
    if (!fill) throw new Error('没有拿到本地写入结果');
    evidence.fill = fill;
  } finally {
    try { child.kill('SIGTERM'); } catch (e) {}
    await new Promise((r) => setTimeout(r, 600));
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }

  const frontAfter = await frontmost();
  evidence.frontmostAfter = frontAfter;
  console.log('[5] 结束前台:', frontAfter || '(unknown)');

  const checks = [
    ['文本框写入成功', fill.textOk === true, fill.textInput && fill.textInput.after],
    ['contenteditable 写入成功', fill.editableOk === true, fill.editable && fill.editable.after],
    ['下拉(select popup) 选中上海', fill.selectPopupOk === true, fill.selectPopup && fill.selectPopup.after],
    ['列表(select listbox) 选中北京', fill.selectListOk === true, fill.selectList && fill.selectList.after],
    ['复选框勾选成功', fill.checkboxOk === true, fill.checkbox && fill.checkbox.after],
    ['全程前台不是 Chrome', frontBefore !== 'Google Chrome' && frontAfter !== 'Google Chrome' && evidence.frontmostDuring !== 'Google Chrome', frontAfter],
  ];
  console.log('');
  console.log('--- 验收 ---');
  let allPass = true;
  for (const [name, pass, extra] of checks) {
    console.log((pass ? '  PASS  ' : '  FAIL  ') + name + (extra ? '  [' + extra + ']' : ''));
    if (!pass) allPass = false;
  }
  evidence.acceptance = Object.fromEntries(checks.map((c) => [c[0], c[1]]));
  evidence.ok = allPass;
  console.log('结果:', allPass ? '全部通过' : '存在失败项');
  console.log(JSON.stringify(evidence, null, 2));
  return allPass ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
