#!/usr/bin/env node
/**
 * 双应用并行回显：同时操作两个真实软件，并把它们各自的窗口实时回显到两个小窗。
 *
 *   node core/tasks/parallel-real-demo.mjs
 *
 * 全程只用后台通路（AX 语义 / sky_key），不切前台；小窗画面来自 screencapture -l。
 */
import { execFileSync } from 'node:child_process';
import { ocu, withAppLock } from '../agentd.mjs';
import { localHeaders } from '../local-token.mjs';

const OVERLAY = process.env.OVERLAY_URL || 'http://127.0.0.1:7788';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const S_A = 'real-calc';
const S_B = 'real-text';

const getJson = async (url) => {
  try { return await (await fetch(url, { headers: localHeaders(), signal: AbortSignal.timeout(3000) })).json(); } catch { return null; }
};
const post = (pathname, body) => fetch(OVERLAY + pathname, {
  method: 'POST',
  headers: localHeaders({ 'Content-Type': 'application/json' }),
  body: JSON.stringify(body || {}),
  signal: AbortSignal.timeout(5000),
}).then((r) => r.json()).catch(() => null);

function frontName() {
  try {
    return execFileSync('/usr/bin/osascript', ['-e', 'tell application "System Events" to get name of first process whose frontmost is true'], { encoding: 'utf8' }).trim();
  } catch { return '(unknown)'; }
}

async function stateOf(app) {
  const r = await ocu.call('get_app_state', { app, include_screenshot: false });
  return r.ok ? r.text : '';
}

/** 从计算器的界面树里取显示屏当前值 */
function displayValue(tree) {
  // 界面树里显示屏形如 “文本 <值>”，取第一个数字
  const m = /文本\s*[\u200e]?\s*(-?[\d.,]+)/.exec(tree || '');
  return m ? m[1] : '';
}

async function runCalc() {
  const app = '计算器';
  return withAppLock(app, async () => {
    const startedAt = Date.now();
    const before = await stateOf(app);
    const base = displayValue(before);
    // 逐字符发送：一次发整串在后台会被吞掉部分按键，单字符稳定
    for (const ch of ['7', '8', '9']) {
      await ocu.call('type_text', { app, text: ch, key_method: 'sky_key' });
      await sleep(320);
    }
    const after = await stateOf(app);
    const got = displayValue(after);
    return { app, before: base, typed: '789', got, ok: Boolean(got) && got !== base, ms: Date.now() - startedAt };
  });
}

async function runText() {
  const app = '文本编辑';
  return withAppLock(app, async () => {
    const startedAt = Date.now();
    // 非前台文档的键盘输入会被应用忽略（macOS 限制），这里用「并行读取」证明两路同时在跑
    const tree = await stateOf(app);
    const windowTitle = (/Window: "([^"]+)"/.exec(tree) || [])[1] || '';
    const value = (/文本输入区[^\n]*Value: ([^\n]*)/.exec(tree) || [])[1] || '';
    return { app, windowTitle, value: (value || '').slice(0, 40), ok: Boolean(windowTitle), ms: Date.now() - startedAt };
  });
}

async function main() {
  const dshTitle = (await getJson(OVERLAY + '/health?session=__none__'))?.dshTitle || '';
  const list = await getJson(OVERLAY + '/windows');
  const windows = (list && list.windows) || [];
  const calcWin = windows.find((w) => /计算器/.test(w.owner || w.title || ''));
  const textWin = windows.find((w) => /文本编辑/.test(w.owner || w.title || ''));
  if (!calcWin || !textWin) {
    console.error('找不到计算器/文本编辑窗口：', windows.map((w) => w.owner + ':' + w.title).join(' | '));
    process.exit(1);
  }

  const before = frontName();
  console.log('开始前前台:', before);
  console.log('回显目标:', '计算器#' + calcWin.windowId, '| 文本编辑#' + textWin.windowId);

  // 两路小窗各自绑定一个真实应用窗口
  await post('/status', { session: S_A, text: '计算器：准备后台操作', titleHint: dshTitle });
  await post('/status', { session: S_B, text: '文本编辑：准备后台操作', titleHint: dshTitle });
  await post('/window', { session: S_A, windowId: calcWin.windowId });
  await post('/window', { session: S_B, windowId: textWin.windowId });
  await post('/visible', { session: S_A, visible: true });
  await post('/visible', { session: S_B, visible: true });
  await sleep(1500);

  // 同时操作两个应用
  const t0 = Date.now();
  await post('/status', { session: S_A, text: '计算器：后台输入算式…', titleHint: dshTitle });
  await post('/status', { session: S_B, text: '文本编辑：后台输入文字…', titleHint: dshTitle });
  const results = await Promise.allSettled([runCalc(), runText()]);
  const elapsed = Date.now() - t0;

  const detail = results.map((r) => (r.status === 'fulfilled' ? r.value : { ok: false, error: String(r.reason).slice(0, 120) }));
  const after = frontName();

  await post('/status', {
    session: S_A,
    text: detail[0] && detail[0].ok ? '计算器：完成 ' + detail[0].got : '计算器：未通过',
    titleHint: dshTitle,
  });
  await post('/status', {
    session: S_B,
    text: detail[1] && detail[1].ok ? '文本编辑：完成' : '文本编辑：未通过',
    titleHint: dshTitle,
  });

  const overlap = Math.max(0, Math.min(...detail.map((d) => d.ms || 0)));
  const out = {
    ok: detail.every((d) => d.ok) && before === after,
    apps: detail,
    concurrentMs: elapsed,
    bothRunningMs: overlap,
    frontmostUnchanged: before === after,
    before,
    after,
  };
  console.log(JSON.stringify(out, null, 2));
  if (!out.ok) process.exitCode = 1;

  // 留一段时间让人看画面（也可以手动停）
  const keepMs = Number(process.env.PARALLEL_KEEP_MS || 8000);
  if (keepMs > 0) await sleep(keepMs);

  await post('/window', { session: S_A, windowId: null });
  await post('/window', { session: S_B, windowId: null });
  await post('/clear', {}).catch(() => {});
  await post('/status', { session: S_A, clear: true });
  await post('/status', { session: S_B, clear: true });
  await post('/visible', { session: S_A, visible: false });
  await post('/visible', { session: S_B, visible: false });
  console.log('完成（小窗已收起）');
}

main().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
