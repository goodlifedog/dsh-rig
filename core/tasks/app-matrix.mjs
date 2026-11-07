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
import { ensureAppRunning, frontName, state, find } from '../background.mjs';
import { closeOcuMcp } from '../ocu-mcp.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');
const OVERLAY = process.env.OVERLAY_URL || 'http://127.0.0.1:7788';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const APPS = [
  { name: '备忘录', bundle: 'com.apple.Notes' },
  { name: '文本编辑', bundle: 'com.apple.TextEdit' },
  { name: '计算器', bundle: 'com.apple.calculator' },
  { name: '访达', bundle: 'com.apple.finder' },
  { name: '系统设置', bundle: 'com.apple.systempreferences' },
  { name: 'Clash Verge', bundle: 'com.nicenormalboy.clash-verge' },
  { name: 'Telegram', bundle: 'com.tdesktop.Telegram' },
];

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

    const launch = await ensureAppRunning({ bundleId: app.bundle, appName: app.name });
    steps.launch = await frontName();
    row.launch = launch.error ? 'error' : (launch.launched ? 'launched' : 'running');
    row.launchFrontUnchanged = launch.frontUnchanged !== false;
    await sleep(1200);

    let tree = '';
    try { tree = await state(app.name); } catch (e) { tree = ''; }
    steps.read = await frontName();
    row.readable = Boolean(tree && tree.length > 40);
    row.nodes = (tree.match(/^\s*\d+ /gm) || []).length;

    try {
      row.buttons = (await find(app.name, { role: 'AXButton', limit: 60 })).length;
      row.textAreas = (await find(app.name, { role: 'AXTextArea', limit: 10 })).length;
      row.textFields = (await find(app.name, { role: 'AXTextField', limit: 10 })).length;
    } catch (e) {
      row.buttons = -1; row.textAreas = -1; row.textFields = -1;
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
    '| 应用 | 启动 | 读界面 | 节点 | 按钮 | 文本区 | 画面 | 前台未变 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const r of rows) {
    lines.push('| ' + r.app + ' | ' + r.launch + ' | ' + (r.readable ? 'yes' : 'no') + ' | ' + r.nodes +
      ' | ' + r.buttons + ' | ' + r.textAreas + ' | ' + r.capture + ' | ' + (r.frontUnchanged ? 'yes' : 'NO') + ' |');
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
