#!/usr/bin/env node
/**
 * 应用能力矩阵：逐个真实应用探明后台能力，全程检查前台有没有被抢占。
 *
 *   node core/tasks/app-matrix.mjs
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureAppRunning, frontName, state, find, windowControls, readSafe, findSafe } from '../background.mjs';
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
    const pattern = new RegExp(app.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '|' + app.bundle.split('.').pop(), 'i');
    const row = { app: app.name, bundle: app.bundle };
    const before = await frontName();
    const steps = {};

    const launch = await ensureAppRunning({ bundleId: app.bundle, appName: app.name, processName: app.process });
    steps.launch = await frontName();
    row.launch = launch.error ? 'error' : (launch.launched ? 'launched' : 'running');
    row.launchFrontUnchanged = launch.frontUnchanged !== false;
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
    rows.push(row);
    console.log(JSON.stringify(row));
  }

  const frontEnd = await frontName();
  const allFrontOk = rows.every((r) => r.frontUnchanged);
  const summary = {
    ok: allFrontOk,
    frontStart,
    frontEnd,
    frontUnchangedAll: allFrontOk,
    readable: rows.filter((r) => r.readable).length,
    launchable: rows.filter((r) => r.launch !== 'error' && r.launchFrontUnchanged).length,
    clickable: rows.filter((r) => r.buttons > 0).length,
    liveCapture: rows.filter((r) => r.capture === 'live').length,
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
    '| 应用 | 启动 | 读界面 | 节点 | 按钮 | 文本区 | 菜单项 | 窗口按钮 | 画面 | 前台未变 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const r of rows) {
    const stealNote = (r.readStoleFront || r.queryStoleFront) ? '读取会抢前台' : '';
    lines.push('| ' + r.app + ' | ' + r.launch + ' | ' + (r.readable ? 'yes' : 'no') + ' | ' + r.nodes +
      ' | ' + r.buttons + ' | ' + r.textAreas + ' | ' + (r.menuItems === undefined ? '-' : r.menuItems) +
      ' | ' + (r.windowControls === undefined ? '-' : r.windowControls) + ' | ' + r.capture + ' | ' +
      (r.frontUnchanged ? 'yes' : 'NO') + (stealNote ? '（' + stealNote + '）' : '') + ' |');
  }
  lines.push('');
  lines.push('offscreen = 窗口在别的桌面、系统返回纯色帧（仍可后台操作，只是画面抓不到）。');
  fs.writeFileSync(path.join(dir, 'app-matrix-' + stamp + '.md'), lines.join('\n'));

  console.log('\n汇总: ' + JSON.stringify({ ok: summary.ok, readable: summary.readable, clickable: summary.clickable, liveCapture: summary.liveCapture, total: summary.total }));
  console.log('报告: reports/app-matrix-' + stamp + '.md');
  await closeOcuMcp().catch(() => {});
  if (!allFrontOk) process.exitCode = 1;
}

main().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
