#!/usr/bin/env node
/**
 * 应用能力矩阵：逐个真实应用探明后台能力，全程检查前台有没有被抢占。
 *
 *   node core/tasks/app-matrix.mjs
 *
 * 环境变量：
 *   MATRIX_APPS_JSON   覆盖应用列表
 *   MATRIX_QUIT=0      探测完不关自己拉起来的应用（默认会关，避免留一堆窗口）
 *   MATRIX_DISMISS=0   不点首启欢迎弹窗（默认会点白名单按钮）
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureAppRunning, frontName, state, find, windowControls, readSafe, findSafe, settleFront, waitForWindow, dismissOnboarding, quitApp } from '../background.mjs';
import { isScreenLocked } from '../platform.mjs';
import { closeOcuMcp } from '../ocu-mcp.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');
const OVERLAY = process.env.OVERLAY_URL || 'http://127.0.0.1:7788';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 可用 MATRIX_APPS_JSON 覆盖默认列表，方便按门类分批探测
const DEFAULT_APPS = [
  { name: '备忘录', bundle: 'com.apple.Notes', process: 'Notes' },
  { name: '文本编辑', bundle: 'com.apple.TextEdit', process: 'TextEdit' },
  { name: '计算器', bundle: 'com.apple.calculator', process: 'Calculator' },
  { name: '访达', bundle: 'com.apple.finder', process: 'Finder' },
  { name: '系统设置', bundle: 'com.apple.systempreferences', process: 'System Settings' },
  { name: 'Clash Verge', bundle: 'com.nicenormalboy.clash-verge', process: 'clash-verge' },
  { name: 'Telegram', bundle: 'com.tdesktop.Telegram', process: 'Telegram' },
  // 补三个门类：终端、Electron 聊天、原生浏览器、办公文档
  { name: 'Ghostty', bundle: 'com.mitchellh.ghostty', process: 'ghostty' },
  { name: 'ChatGPT', bundle: 'com.openai.chat', process: 'ChatGPT' },
  { name: 'Safari', bundle: 'com.apple.Safari', process: 'Safari' },
  { name: 'WPS Office', bundle: 'com.kingsoft.wpsoffice.mac', process: 'wpsoffice' },
];

let APPS = DEFAULT_APPS;
if (process.env.MATRIX_APPS_JSON) {
  try {
    const parsed = JSON.parse(process.env.MATRIX_APPS_JSON);
    if (Array.isArray(parsed) && parsed.length) APPS = parsed;
  } catch (e) {
    console.error('MATRIX_APPS_JSON 解析失败，用默认列表：' + String(e.message).slice(0, 80));
  }
}

async function restoreFront(target) {
  try {
    await new Promise((resolve) => {
      execFile('/usr/bin/osascript', ['-e', 'tell application "System Events" to set frontmost of process ' + JSON.stringify(target) + ' to true'], () => resolve());
    });
  } catch {}
}

const getJson = async (url) => {
  try { return await (await fetch(url, { signal: AbortSignal.timeout(3000) })).json(); } catch { return null; }
};
const post = (pathname, body) => fetch(OVERLAY + pathname, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body || {}),
  signal: AbortSignal.timeout(5000),
}).then((r) => r.json()).catch(() => null);

// 有些应用（菜单栏工具、自绘界面）AX 里窗口数是 0，但系统窗口层明明有窗口；
// 判断"窗口就绪"时两个来源都看，避免误判成没窗口。
async function overlayWindowCount(pattern) {
  const list = await getJson(OVERLAY + '/windows');
  const windows = (list && list.windows) || [];
  return windows.filter((w) => pattern.test(String(w.owner || '') + ' ' + String(w.title || ''))).length;
}

async function probeCapture(session, pattern, titleHint) {
  const list = await getJson(OVERLAY + '/windows');
  const windows = (list && list.windows) || [];
  const match = windows.find((w) => pattern.test(w.owner || w.title || ''));
  if (!match) return { state: 'none', reason: '没有窗口' };
  await post('/status', { session, text: '矩阵探测中', titleHint });
  await post('/window', { session, windowId: match.windowId });
  await post('/visible', { session, visible: true });
  await sleep(1800);
  const h = await getJson(OVERLAY + '/health?session=' + encodeURIComponent(session));
  const result = {
    state: (h && h.thumbnail && h.thumbnail.state) || 'none',
    bytes: (h && h.frameBytes) || 0,
    windowId: match.windowId,
    owner: match.owner,
    onscreen: match.onscreen,
    reason: (h && h.thumbnail && h.thumbnail.error) || '',
  };
  await post('/window', { session, windowId: null });
  await post('/status', { session, clear: true });
  await post('/visible', { session, visible: false });
  return result;
}

async function main() {
  // 锁屏时 AX 整体不可用（已知系统限制），这时跑矩阵只会得到"全不可读"的假结论
  if (await isScreenLocked()) {
    console.log('环境跳过：屏幕已锁，锁屏下 AX/抓图都不可用，等解锁后再跑 npm run matrix');
    process.exitCode = 0;
    return;
  }
  const titleHint = (await getJson(OVERLAY + '/health?session=__none__'))?.dshTitle || '';
  const frontStart = await frontName();
  const rows = [];
  let seq = 0;

  for (const app of APPS) {
    seq += 1;
    const session = 'matrix-' + seq;
    // 跑一半锁屏了：剩下的标环境跳过，不要产出"全部不可读"的假结论
    if (await isScreenLocked()) {
      rows.push({ app: app.name, skipped: true, reason: '中途锁屏' });
      console.log(JSON.stringify({ app: app.name, skipped: true, reason: '中途锁屏' }));
      continue;
    }
    const pattern = new RegExp(app.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '|' + app.bundle.split('.').pop(), 'i');
    const row = { app: app.name, bundle: app.bundle };
    const before = await frontName();
    const steps = {};

    const launch = await ensureAppRunning(
      { bundleId: app.bundle, appName: app.name, processName: app.process },
      { waitMs: 15000 },
    );
    steps.launch = await frontName();
    row.launch = launch.error ? 'error' : (launch.launched ? 'launched' : 'running');
    row.launchFrontUnchanged = launch.frontUnchanged !== false;
    // 刚启动时窗口可能还没建好：等它出现再探测，否则会得到"没有窗口"的假结论
    const ready = await waitForWindow(app.name, { timeoutMs: 12000 });
    row.windowWaitMs = ready.waitedMs;
    row.windowAttempts = ready.attempts;
    // AX 看不到窗口时退一步看系统窗口层（菜单栏工具、自绘界面实测会这样）
    let cgCount = 0;
    if (!ready.ok) cgCount = await overlayWindowCount(pattern);
    row.windowReady = ready.ok || cgCount > 0;
    row.windowReadySource = ready.ok ? 'ax' : (cgCount > 0 ? 'cgwindow' : 'none');
    if (!row.windowReady) row.captureNote = '等了 ' + ready.waitedMs + 'ms 仍没有窗口';
    // 首启欢迎弹窗会卡住 Apple 事件：点掉白名单按钮（默认开，MATRIX_DISMISS=0 关）
    if (process.env.MATRIX_DISMISS !== '0') {
      const dis = await dismissOnboarding(app.name, { timeoutMs: 6000 });
      if (dis.dismissed) {
        row.onboardingDismissed = true;
        row.onboardingButton = dis.button;
        row.onboardingDialog = dis.dialog;
        await sleep(600);
      }
    }
    await sleep(1200);

    // 用带前台保护的读取：某些应用（Ghostty/ChatGPT 实测）一读就被顶到前台
    let tree = '';
    const readRes = await readSafe(app.name);
    tree = readRes.text || '';
    row.readStoleFront = readRes.frontStolen;
    steps.read = await frontName();
    row.readable = Boolean(tree && tree.length > 40);
    row.nodes = (tree.match(/^\s*\d+ /gm) || []).length;

    try {
      const btn = await findSafe(app.name, { role: 'AXButton', limit: 60 });
      row.buttons = btn.matches.length;
      row.queryStoleFront = Boolean(row.queryStoleFront || btn.frontStolen);
      const area = await findSafe(app.name, { role: 'AXTextArea', limit: 10 });
      row.textAreas = area.matches.length;
      const field = await findSafe(app.name, { role: 'AXTextField', limit: 10 });
      row.textFields = field.matches.length;
      // 菜单命令：很多关键动作只在菜单里（保存/新建/切换标签）
      const menu = await findSafe(app.name, { role: 'AXMenuItem', limit: 40 });
      row.menuItems = menu.matches.length;
      row.windowControls = (await windowControls(app.name)).length;
    } catch (e) {
      row.buttons = -1; row.textAreas = -1; row.textFields = -1; row.menuItems = -1; row.windowControls = -1;
    }

    steps.elements = await frontName();
    const cap = await probeCapture(session, pattern, titleHint);
    // 抓帧也可能触发应用异步激活（Gemini 实测）：延迟复查并还原
    const capSettle = await settleFront(before, { waitMs: 250, retries: 2 });
    row.captureStoleFront = capSettle.stolen;
    steps.capture = await frontName();
    row.capture = cap.state;
    row.captureBytes = cap.bytes;
    row.windowOnscreen = cap.onscreen;
    row.captureNote = cap.reason;

    const after = await frontName();
    row.frontUnchanged = before === after && launch.frontUnchanged !== false;
    row.frontDetail = before + ' -> ' + after;
    row.stepFronts = steps;
    row.firstFocusSteal = Object.entries(steps).find(([k, v]) => v !== before) || null;
    // 探测过程中万一被抢了前台，立刻还给用户
    if (after !== before) await restoreFront(before);
    // 只关自己拉起来的应用，用户本来就在用的不动（MATRIX_QUIT=0 可关掉这个行为）
    if (row.launch === 'launched' && process.env.MATRIX_QUIT !== '0') {
      const quit = await quitApp({ bundleId: app.bundle, appName: app.name, processName: app.process });
      row.autoQuit = quit.mode;
      row.autoQuitOk = quit.quit;
      if (!quit.quit) row.autoQuitDetail = quit.detail;
    }
    rows.push(row);
    console.log(JSON.stringify(row));
  }

  const frontEnd = await frontName();
  const allFrontOk = rows.filter((r) => !r.skipped).every((r) => r.frontUnchanged);
  const skippedRows = rows.filter((r) => r.skipped);
  const summary = {
    ok: allFrontOk,
    skipped: skippedRows.length,
    skippedApps: skippedRows.map((r) => r.app),
    frontStart,
    frontEnd,
    frontUnchangedAll: allFrontOk,
    readable: rows.filter((r) => r.readable).length,
    launchable: rows.filter((r) => r.launch !== 'error' && r.launchFrontUnchanged).length,
    clickable: rows.filter((r) => r.buttons > 0).length,
    liveCapture: rows.filter((r) => r.capture === 'live').length,
    windowReady: rows.filter((r) => r.windowReady !== false).length,
    onboardingDismissed: rows.filter((r) => r.onboardingDismissed).length,
    autoQuit: rows.filter((r) => r.autoQuit && r.autoQuit !== 'already-stopped').length,
    total: rows.length,
    rows,
  };

  const dir = path.join(ROOT, 'reports');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  fs.writeFileSync(path.join(dir, 'app-matrix-' + stamp + '.json'), JSON.stringify(summary, null, 2));

  const lines = [
    '# 应用后台能力矩阵',
    '',
    '- 时间：' + new Date().toISOString(),
    '- 前台：' + frontStart + ' -> ' + frontEnd + (allFrontOk ? '（未变）' : '（被抢占）'),
    '- 汇总：' + summary.readable + '/' + summary.total + ' 可读界面，' + summary.clickable + '/' + summary.total +
      ' 有可点击元素，' + summary.liveCapture + '/' + summary.total + ' 画面可直接回显',
    '',
    '| 应用 | 启动 | 窗口就绪 | 读界面 | 节点 | 按钮 | 文本区 | 菜单项 | 窗口按钮 | 画面 | 前台未变 | 收尾 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const r of rows) {
    if (r.skipped) {
      lines.push('| ' + r.app + ' | SKIP | - | - | - | - | - | - | - | - | - | - |');
      continue;
    }
    const stealNote = (r.readStoleFront || r.queryStoleFront || r.captureStoleFront) ? '操作中短暂抢前台，已还原' : '';
    const readyNote = r.windowReady === false ? '等了 ' + r.windowWaitMs + 'ms 仍无窗口' : 'yes';
    const quitNote = r.autoQuit ? r.autoQuit : '-';
    lines.push('| ' + r.app + ' | ' + r.launch + ' | ' + readyNote + ' | ' + (r.readable ? 'yes' : 'no') + ' | ' + r.nodes +
      ' | ' + r.buttons + ' | ' + r.textAreas + ' | ' + (r.menuItems === undefined ? '-' : r.menuItems) +
      ' | ' + (r.windowControls === undefined ? '-' : r.windowControls) + ' | ' + r.capture + ' | ' +
      (r.frontUnchanged ? 'yes' : 'NO') + (stealNote ? '（' + stealNote + '）' : '') + ' | ' + quitNote + ' |');
  }
  lines.push('');
  lines.push('offscreen = 窗口在别的桌面、系统返回纯色帧（仍可后台操作，只是画面抓不到）。');
  lines.push('收尾：quit = 探测完已退出；term = 弹窗卡住 Apple 事件、按进程 TERM；already-stopped = 目标本来就在运行，没动它。');
  fs.writeFileSync(path.join(dir, 'app-matrix-' + stamp + '.md'), lines.join('\n'));

  console.log('\n汇总: ' + JSON.stringify({ ok: summary.ok, readable: summary.readable, clickable: summary.clickable, liveCapture: summary.liveCapture, total: summary.total }));
  console.log('报告: reports/app-matrix-' + stamp + '.md');
  await closeOcuMcp().catch(() => {});
  if (!allFrontOk) process.exitCode = 1;
}

main().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
