/**
 * 读取 BOSS 职位列表并统计，只读不投递
 */
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ocu, overlay, guard, parseJobs, countElements } from '../agentd.mjs';
import { isAppRunning } from '../background.mjs';
import { requireAppRunning, reportAppPresence } from '../app-presence.mjs';

const APP = process.env.TARGET_APP || 'Google Chrome';
// H2：Chrome 标签的 AppleEvent 一律先过静默预检（未授权时不会发事件、不弹授权框）
const CHROME_BUNDLE_ID = 'com.google.Chrome';
const chromeAppleEventPreflight = createAppleEventPreflight({ bundleId: CHROME_BUNDLE_ID });
const APPLEEVENT_BLOCKED = Object.freeze({ code: -1, stdout: '', stderr: 'automation-not-authorized' });
const TARGET_FRAGMENT = 'zhipin.com/web/geek/jobs';
import { resolveOcu, isScreenLocked, lockedSkipNotice } from '../platform.mjs';
import { createAppleEventPreflight, runAppleEventGuarded } from '../appleevent-preflight.mjs';

import { isMac } from '../platform.mjs';
// 只有直接运行时才按平台退出：单测会 import 本模块，不能在 import 时 process.exit
const invokedDirectly = Boolean(process.argv[1])
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (!isMac && invokedDirectly) {
  console.error('此任务依赖 osascript 或 sky_key（macOS 专属），Windows 版待移植；跨平台通路验证请跑 platform-demo');
  process.exit(2);
}
const OCU = resolveOcu() || path.join(os.homedir(), '.local/bin/ocu');
const MIN_JOBS = Number(process.env.MIN_JOBS || 10);
const MAX_JOB_LOGS = Number(process.env.MAX_JOB_LOGS || 50);
const JS_TIMEOUT_MS = Number(process.env.SCAN_JS_TIMEOUT_MS || 90000);

function run(cmd, args, { timeout = 120000 } = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({
        code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
        stdout: stdout || '',
        stderr: stderr || '',
        error: err ? String(err.message || err) : null,
      });
    });
  });
}

// 跑一段 ocu js 代码（持久原生会话），返回脚本里以 marker 打出的 JSON。
async function runOcuJs(source, marker) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'boss-scan-'));
  try {
    const file = path.join(dir, 'inner.mjs');
    await writeFile(file, source, 'utf8');
    const { stdout, stderr } = await run(
      OCU,
      ['js', '--json', '--timeout', String(JS_TIMEOUT_MS), '--file', file],
      { timeout: JS_TIMEOUT_MS + 20000 }
    );
    let items = [];
    try {
      const parsed = JSON.parse(stdout);
      if (Array.isArray(parsed.content)) {
        items = parsed.content.filter((x) => x && x.type === 'text').map((x) => x.text);
      }
    } catch {
      items = (stdout || '').split('\n');
    }
    for (let i = items.length - 1; i >= 0; i--) {
      const text = items[i];
      if (typeof text !== 'string') continue;
      const at = text.lastIndexOf(marker);
      if (at < 0) continue;
      try {
        return JSON.parse(text.slice(at + marker.length));
      } catch {
        return null;
      }
    }
    return { error: 'no marker in output', stderr: (stderr || '').slice(0, 500) };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// 内层脚本：检查当前标签页是不是 BOSS 职位页；不是就用 AX 点击对应标签页切回来。
// 全程只在后台窗口上做 AX 操作，不激活 Chrome。
function buildTabSwitcher(attempts = 3) {
  return String.raw`
var APP = __APP__;
var FRAG = __FRAG__;
var ATTEMPTS = __ATTEMPTS__;

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function activeUrl(state) {
  var m = /HTML 内容.*?URL: (https?:\S+)/.exec(state);
  return m ? m[1] : null;
}
function findTab(state) {
  var lines = state.split("\n");
  for (var i = 0; i < lines.length; i++) {
    var m = /^\t*(\d+)\s+标签\s+.*(BOSS直聘|zhipin)/i.exec(lines[i]);
    if (m) return { index: m[1], line: lines[i].trim() };
  }
  return null;
}

var out = { before: null, after: null, tab: null, attempts: [], switched: false, ok: false };
try {
  var app = await cua.getApp(APP, { initialState: false });
  var opts = { emit: false, maxTreeNodes: 8000, maxTreeDepth: 96, textLimit: 500 };

  var state = await app.getAXState(opts);
  out.before = activeUrl(state);
  if (out.before && out.before.indexOf(FRAG) >= 0) {
    out.ok = true;
    out.after = out.before;
  } else {
    for (var attempt = 0; attempt < ATTEMPTS && !out.ok; attempt++) {
      state = await app.getAXState(opts);
      var tab = findTab(state);
      out.tab = tab;
      if (!tab) { out.attempts.push('no-tab'); break; }
      try {
        await app.click(tab.index, { clickMethod: 'accessibility' });
        out.attempts.push('a11y-tab@' + tab.index);
      } catch (e) {
        out.attempts.push('a11y-tab:err:' + String((e && e.message) || e));
      }
      for (var poll = 0; poll < 3; poll++) {
        await sleep(900);
        state = await app.getAXState(opts);
        out.after = activeUrl(state);
        if (out.after && out.after.indexOf(FRAG) >= 0) { out.ok = true; out.switched = true; break; }
      }
    }
  }
} catch (e) {
  out.error = String((e && e.message) || e);
}
nodeRepl.write('BOSS_TAB_JSON=' + JSON.stringify(out));
`
    .replaceAll('__APP__', JSON.stringify(APP))
    .replaceAll('__FRAG__', JSON.stringify(TARGET_FRAGMENT))
    .replaceAll('__ATTEMPTS__', String(attempts));
}

// AppleScript 兜底：按 URL 找到 BOSS 标签页并设为活动标签（Chrome 自身 API，不会激活窗口）。
// H2：每个 AppleEvent 都先过 core/appleevent-preflight.mjs 的静默预检——
//   granted/unknown → 照旧执行（参数逐字不变）；denied/needs-consent → 不发事件，返回 skipped。
// options 仅供单测注入（run/preflight/onWarning），生产调用不传。
export async function switchTabByAppleScript(options = {}) {
  const opts = options || {};
  const call = typeof opts.run === 'function' ? opts.run : run;
  const preflight = typeof opts.preflight === 'function' ? opts.preflight : chromeAppleEventPreflight;
  const onWarning = typeof opts.onWarning === 'function'
    ? opts.onWarning
    : ((message) => console.warn('⚠️ ' + message));
  const fragment = String(opts.fragment || TARGET_FRAGMENT);
  const guarded = (action, args) => runAppleEventGuarded({
    action,
    bundleId: CHROME_BUNDLE_ID,
    preflight,
    fallback: APPLEEVENT_BLOCKED,
    onWarning,
    run: () => call('osascript', args),
  });

  const urls = await guarded('读取 Chrome 标签页（AppleEvent）', [
    '-e',
    'tell application "Google Chrome" to get URL of every tab of window 1',
  ]);
  if (urls.allowed === false) return { ok: false, skipped: 'not-authorized', warning: urls.warning, error: urls.warning };
  if (urls.value.code !== 0) return { ok: false, error: urls.value.stderr.trim() };
  const list = urls.value.stdout.split(', ').map((s) => s.trim());
  const index = list.findIndex((u) => u.includes(fragment));
  if (index < 0) return { ok: false, error: 'tabs 里没有 BOSS 职位页', tabs: list };
  const set = await guarded('切换 Chrome 标签页（AppleEvent）', [
    '-e',
    'tell application "Google Chrome" to set active tab index of window 1 to ' + (index + 1),
  ]);
  if (set.allowed === false) return { ok: false, skipped: 'not-authorized', warning: set.warning, error: set.warning };
  if (set.value.code !== 0) return { ok: false, error: set.value.stderr.trim() };
  await new Promise((r) => setTimeout(r, 800));
  const check = await guarded('读取 Chrome 当前标签页（AppleEvent）', [
    '-e',
    'tell application "Google Chrome" to get URL of active tab of window 1',
  ]);
  if (check.allowed === false) return { ok: false, skipped: 'not-authorized', warning: check.warning, error: check.warning };
  const url = check.value.stdout.trim();
  return { ok: url.includes(fragment), url, tabIndex: index + 1 };
}

async function listAppsFirstLine() {
  const text = await ocu.listApps();
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  return lines[0] || '(unknown)';
}

async function bindThumbnail() {
  const win = await overlay.findWindow(/BOSS直聘|Chrome/i);
  if (!win) return { bound: false, reason: 'overlay /windows 里没有 Chrome 窗口' };
  await overlay.window(win.windowId);
  for (let i = 0; i < 6; i++) {
    const health = await overlay.health();
    const thumb = health && health.thumbnail;
    if (thumb && thumb.state === 'live') {
      return { bound: true, windowId: win.windowId, title: win.title, state: thumb.state };
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  const health = await overlay.health();
  return {
    bound: false,
    windowId: win.windowId,
    title: win.title,
    reason: '缩略图未进入 live：' + JSON.stringify(health && health.thumbnail),
  };
}

async function main() {
  // 锁屏下 AX/抓图不可用：这是环境限制，不是任务失败（手动跑也不该红）
  if (await isScreenLocked()) {
    console.log(lockedSkipNotice('boss-scan.mjs'));
    return;
  }
  // 目标应用没在跑就跳过：ocu.snapshot 对未运行的应用会把 Chrome 拉起来（带登录 profile）并顶到前台，
  // 所以碰它之前先确认它在跑；没跑就环境跳过，不为了测试去启动用户的浏览器。
  const presence = await requireAppRunning(APP, { isAppRunning });
  if (reportAppPresence(presence)) return 0;
  const t0 = Date.now();
  const evidence = { steps: [] };

  console.log('[1] 连接 overlay …');
  const health0 = await overlay.health();
  console.log('    overlay:', health0.ok ? '在线 pid=' + health0.pid : '离线（仅输出终端）');

  console.log('[2] 记录初始前台 …');
  const frontBefore = await ocu.frontmost();
  const listFirstBefore = await listAppsFirstLine();
  evidence.frontmostBefore = frontBefore;
  evidence.listAppsFirstLineBefore = listFirstBefore;
  console.log('    frontmost:', frontBefore);
  console.log('    list-apps 第一行:', listFirstBefore);

  await overlay.status('后台扫描：准备切回 BOSS 职位页');

  console.log('[3] 检查当前标签页 …');
  // 默认不切标签：用户可能正在用 Chrome，切标签会把他看的页面跳走。
  // 需要切换时显式设置 SCAN_ALLOW_TAB_SWITCH=1。
  const ALLOW_SWITCH = process.env.SCAN_ALLOW_TAB_SWITCH === '1';
  if (!ALLOW_SWITCH) {
    const probe = await ocu.snapshot(APP, { nodes: 2000 });
    const m = /HTML 内容.*?URL: (https?:\/\/\S+)/.exec(probe);
    const currentUrl = m ? m[1] : null;
    if (!currentUrl || !currentUrl.includes(TARGET_FRAGMENT)) {
      console.log('    当前标签不是 BOSS 页（' + currentUrl + '），不切换、直接跳过');
      await overlay.status('跳过：当前不在 BOSS 页（不打扰用户）');
      await overlay.log('跳过扫描：当前标签 ' + (currentUrl || '未知'));
      evidence.skipped = { reason: 'not-on-target-tab', currentUrl, allowSwitch: false };
      console.log(JSON.stringify({ ok: true, skipped: true, reason: 'not-on-target-tab', currentUrl }, null, 2));
      return;
    }
    console.log('    当前已在 BOSS 页，无需切换');
  }
  let tabResult = ALLOW_SWITCH
    ? await runOcuJs(buildTabSwitcher(), 'BOSS_TAB_JSON=')
    : { before: null, after: null, switched: false, ok: true, reason: 'already-on-target' };
  if (!tabResult || !tabResult.ok) {
    console.log('    AX 切换未成功，尝试 AppleScript 兜底 …');
    const asResult = await switchTabByAppleScript();
    tabResult = { ...(tabResult || {}), appleScript: asResult };
    if (asResult.ok) tabResult.ok = true;
    else if (asResult.skipped === 'not-authorized') {
      // 未授权不是失败：按环境跳过退出 0，等到系统设置 → 隐私与安全性 → 自动化授权后再跑
      console.log('环境跳过：Chrome 自动化未授权，不发送 AppleEvent 切标签（' + (asResult.warning || '') + '）');
      await overlay.status('环境跳过：Chrome 自动化未授权');
      await overlay.log('跳过扫描：Chrome 自动化未授权（不弹授权框）');
      evidence.skipped = { reason: 'automation-not-authorized', detail: asResult.warning || '' };
      console.log(JSON.stringify({ ok: true, skipped: true, reason: 'automation-not-authorized' }, null, 2));
      return;
    }
  }
  evidence.tabSwitch = tabResult;
  console.log('    当前 URL:', tabResult && tabResult.after, '| ok=', !!(tabResult && tabResult.ok));
  if (!tabResult || !tabResult.ok) {
    throw new Error('无法把 Chrome 切回 BOSS 职位页：' + JSON.stringify(tabResult));
  }
  await overlay.log('已切到 BOSS 职位页：' + tabResult.after);

  console.log('[4] 后台读取界面树（不激活窗口）…');
  await overlay.status('正在读取 ' + APP + ' 界面树');
  const guarded = await guard(APP, async () => {
    const text = await ocu.snapshot(APP, { nodes: 8000 });
    await overlay.log('读取 ' + APP + ' 界面树：' + countElements(text) + ' 个节点');
    return text;
  }, { label: '读取完成' });
  const ax = guarded.result;
  evidence.frontmostDuringRead = { before: guarded.before, after: guarded.after };
  console.log('    前台：', guarded.before, '→', guarded.after);

  console.log('[5] 解析并推送岗位 …');
  const rawJobs = parseJobs(ax);
  // 去重 / 过滤：同一个岗位可能在详情面板里再出现一次（带 securityId 查询串），
  // 也会出现「查看更多信息」这类非岗位卡片链接。
  const seenIds = new Set();
  const jobs = [];
  for (const job of rawJobs) {
    const m = /job_detail\/([^?/]+)\.html/.exec(job.url);
    const id = m ? m[1] : job.url;
    if (seenIds.has(id)) continue;
    if (!job.title || /^查看更多/.test(job.title)) continue;
    seenIds.add(id);
    jobs.push(job);
  }
  evidence.rawJobsCount = rawJobs.length;
  evidence.jobsCount = jobs.length;
  console.log('    找到岗位:', jobs.length);
  if (jobs.length < MIN_JOBS) {
    throw new Error('岗位数量 ' + jobs.length + ' 少于要求的 ' + MIN_JOBS + ' 条');
  }
  let pushed = 0;
  for (const job of jobs) {
    if (pushed >= MAX_JOB_LOGS) break;
    pushed += 1;
    console.log('      -', job.title);
    await overlay.log('岗位 ' + pushed + '/' + jobs.length + '：' + job.title);
  }
  evidence.jobsPushed = pushed;

  console.log('[6] 绑定缩略图窗口 …');
  const thumb = await bindThumbnail();
  evidence.thumbnail = thumb;
  console.log('    缩略图:', thumb.bound ? 'windowId=' + thumb.windowId : '不可用（' + thumb.reason + '）');
  await overlay.log(thumb.bound ? '缩略图已绑定窗口 ' + thumb.windowId : '缩略图不可用：' + thumb.reason);

  console.log('[7] 运行中可见性检查 …');
  const healthRunning = await overlay.health();
  evidence.overlayVisibleDuring = healthRunning.visible === true;
  evidence.overlayActivityDuring = healthRunning.activity;
  console.log('    overlay visible:', healthRunning.visible, '| activity:', healthRunning.activity);

  const frontAfter = await ocu.frontmost();
  const listFirstAfter = await listAppsFirstLine();
  evidence.frontmostAfter = frontAfter;
  evidence.listAppsFirstLineAfter = listFirstAfter;
  console.log('    结束前台:', frontAfter);
  console.log('    list-apps 第一行:', listFirstAfter);

  await overlay.status('扫描完成：' + jobs.length + ' 个岗位，用时 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');

  console.log('[8] 等 9 秒验证空闲隐藏 …');
  await new Promise((r) => setTimeout(r, 9000));
  const healthIdle = await overlay.health();
  evidence.overlayVisibleAfterIdle = healthIdle.visible === true;
  evidence.overlayActivityAfterIdle = healthIdle.activity;
  console.log('    overlay visible:', healthIdle.visible, '| activity:', healthIdle.activity);

  evidence.elapsedSeconds = Number(((Date.now() - t0) / 1000).toFixed(1));
  const result = {
    jobs: jobs.slice(0, 20),
    jobsCount: jobs.length,
    frontmost_before: frontBefore,
    frontmost_after: frontAfter,
    frontmost_during_read: evidence.frontmostDuringRead,
    listAppsFirstLine_before: listFirstBefore,
    listAppsFirstLine_after: listFirstAfter,
    tabSwitch: { before: tabResult.before, after: tabResult.after, attempts: tabResult.attempts, switched: tabResult.switched },
    thumbnail: thumb,
    overlay: {
      visibleDuring: evidence.overlayVisibleDuring,
      activityDuring: evidence.overlayActivityDuring,
      visibleAfterIdle: evidence.overlayVisibleAfterIdle,
      activityAfterIdle: evidence.overlayActivityAfterIdle,
    },
    elapsedSeconds: evidence.elapsedSeconds,
  };

  const checks = [
    ['岗位数 >= ' + MIN_JOBS, jobs.length >= MIN_JOBS, jobs.length],
    ['前台始终没有变成 Chrome', frontBefore !== APP && frontAfter !== APP && guarded.after !== APP, frontAfter],
    ['list-apps 第一行不是 Google Chrome', !listFirstBefore.startsWith('Google Chrome') && !listFirstAfter.startsWith('Google Chrome'), listFirstAfter],
    ['运行期间 overlay 可见', evidence.overlayVisibleDuring === true, String(evidence.overlayVisibleDuring)],
    ['结束后 8~9 秒 overlay 自动隐藏', evidence.overlayVisibleAfterIdle === false, String(evidence.overlayVisibleAfterIdle)],
  ];
  console.log('');
  console.log('--- 验收 ---');
  let allPass = true;
  for (const [name, pass, extra] of checks) {
    console.log((pass ? '  PASS  ' : '  FAIL  ') + name + '  [' + extra + ']');
    if (!pass) allPass = false;
  }
  result.acceptance = Object.fromEntries(checks.map(([n, p]) => [n, p]));
  console.log('');
  console.log('结果:', allPass ? '全部通过' : '存在失败项');
  console.log(JSON.stringify(result, null, 2));
  return allPass ? 0 : 1;
}

if (invokedDirectly) {
  main()
    .then((code) => process.exit(code))
    .catch(async (e) => {
      console.error('FAIL:', e.message);
      await overlay.status('出错：' + e.message);
      process.exit(1);
    });
}