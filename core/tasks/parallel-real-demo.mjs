#!/usr/bin/env node
import { isScreenLocked, lockedSkipNotice } from '../platform.mjs';
import { overlayBase } from '../ports.mjs';
/**
 * 双应用并行回显：同时操作两个真实软件，并把它们各自的窗口实时回显到两个小窗。
 *
 *   node core/tasks/parallel-real-demo.mjs
 *
 * 全程只用后台通路（AX 语义 / sky_key），不切前台；小窗画面来自 screencapture -l。
 */
import { ocu, withAppLock } from '../agentd.mjs';
import { frontName as sharedFrontName, isAppRunning } from '../background.mjs';
import { tokenHeadersFor } from '../local-token.mjs';
import { isDirectRun } from '../direct-run.mjs';

const OVERLAY = overlayBase();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const S_A = 'real-calc';
const S_B = 'real-text';

// 演示目标：没在运行的绝不为了测试去启动/激活（ocu 的 get_app_state 会把没运行的应用拉起并带出窗口）。
const DEMO_TARGETS = [
  { key: 'calc', app: '计算器', appName: 'Calculator', processName: 'Calculator' },
  { key: 'text', app: '文本编辑', appName: 'TextEdit', processName: 'TextEdit' },
];

/**
 * 纯函数：按「是否在运行」把目标分成要跑的和要跳过的（保持原顺序，方便日志与单测）。
 * @param {Array<{app:string}>} targets
 * @param {Iterable<string>} runningApps 正在运行的应用名集合（Set / 数组均可）
 * @returns {{run: Array, skipped: Array}}
 */
function pickRunningTargets(targets, runningApps) {
  const running = runningApps instanceof Set ? runningApps : new Set(runningApps || []);
  const run = [];
  const skipped = [];
  for (const target of targets || []) {
    if (running.has(target.app)) run.push(target);
    else skipped.push(target);
  }
  return { run, skipped };
}

export { DEMO_TARGETS, pickRunningTargets };

const getJson = async (url) => {
  try { return await (await fetch(url, { headers: tokenHeadersFor(url), signal: AbortSignal.timeout(3000) })).json(); } catch { return null; }
};
const post = (pathname, body) => fetch(OVERLAY + pathname, {
  method: 'POST',
  headers: tokenHeadersFor(OVERLAY + pathname, { 'Content-Type': 'application/json' }),
  body: JSON.stringify(body || {}),
  signal: AbortSignal.timeout(5000),
}).then((r) => r.json()).catch(() => null);

/**
 * 读当前前台应用名（H2 缺口 A：不再对 System Events 发 AppleEvent）。
 * 复用 core/background.mjs 的 frontName()（ObjC/NSWorkspace），薄包装保持旧语义：
 * 拿不到返回 ''（共享实现失败时返回 '(unknown)'）。
 * @param {() => Promise<string>} [reader] 单测注入用
 */
export async function frontName(reader = sharedFrontName) {
  try {
    const value = String((await reader()) || '').trim();
    return value === '(unknown)' ? '' : value;
  } catch {
    return '';
  }
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
  // 锁屏下 AX/抓图不可用：这是环境限制，不是任务失败（手动跑也不该红）
  if (await isScreenLocked()) {
    console.log(lockedSkipNotice('parallel-real-demo.mjs'));
    return;
  }
  // P0 批次D #11：ocu 的 get_app_state 会把没运行的应用启动起来并带出窗口。
  // 所以任何 raw ocu 调用之前，先确认目标本来就在运行；没运行就跳过，绝不为了测试去启动/激活。
  const running = new Set();
  for (const target of DEMO_TARGETS) {
    if (await isAppRunning({ appName: target.appName, processName: target.processName })) running.add(target.app);
  }
  const picked = pickRunningTargets(DEMO_TARGETS, running);
  for (const target of picked.skipped) {
    console.log('环境跳过：' + target.app + ' 没在运行，不为了测试去启动/激活它');
  }
  if (!picked.run.length) {
    console.log('环境跳过：计算器和文本编辑都没在运行，不启动任何应用，退出');
    return;
  }

  const dshTitle = (await getJson(OVERLAY + '/health?session=__none__'))?.dshTitle || '';
  const list = await getJson(OVERLAY + '/windows');
  const windows = (list && list.windows) || [];
  const winOf = (re) => windows.find((w) => re.test(w.owner || w.title || ''));
  const windowByKey = { calc: winOf(/计算器/), text: winOf(/文本编辑/) };
  const plan = [];
  for (const target of picked.run) {
    const win = windowByKey[target.key];
    if (!win) {
      console.log('环境跳过：' + target.app + ' 窗口不可见（可能最小化/不在当前 Space），不为了找窗口去激活它');
      continue;
    }
    plan.push({ target, session: target.key === 'calc' ? S_A : S_B, win });
  }
  if (!plan.length) {
    console.log('环境跳过：没有可回显的窗口，退出');
    return;
  }

  const before = await frontName();
  console.log('开始前前台:', before);
  console.log('回显目标:', plan.map((p) => p.target.app + '#' + p.win.windowId).join(' | '));
  if (picked.skipped.length) console.log('本次跳过:', picked.skipped.map((s) => s.app).join('、'));

  // 每路小窗各自绑定一个真实应用窗口（只绑确认在运行且有窗口的目标）
  for (const item of plan) await post('/status', { session: item.session, text: item.target.app + '：准备后台操作', titleHint: dshTitle });
  for (const item of plan) await post('/window', { session: item.session, windowId: item.win.windowId });
  for (const item of plan) await post('/visible', { session: item.session, visible: true });
  await sleep(1500);

  // 同时操作（只操作确认在运行的应用）
  const t0 = Date.now();
  for (const item of plan) await post('/status', { session: item.session, text: item.target.app + '：后台操作中…', titleHint: dshTitle });
  const results = await Promise.allSettled(plan.map((item) => (item.target.key === 'calc' ? runCalc() : runText())));
  const elapsed = Date.now() - t0;

  const detail = results.map((r) => (r.status === 'fulfilled' ? r.value : { ok: false, error: String(r.reason).slice(0, 120) }));
  const after = await frontName();

  for (let i = 0; i < plan.length; i += 1) {
    const d = detail[i] || {};
    const text = d.ok
      ? (plan[i].target.key === 'calc' ? '计算器：完成 ' + d.got : '文本编辑：完成')
      : plan[i].target.app + '：未通过';
    await post('/status', { session: plan[i].session, text, titleHint: dshTitle });
  }

  const overlap = Math.max(0, Math.min(...detail.map((d) => d.ms || 0)));
  const out = {
    ok: detail.every((d) => d.ok) && before === after,
    apps: detail,
    ranApps: plan.map((p) => p.target.app),
    skippedApps: picked.skipped.map((s) => s.app),
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

  for (const item of plan) await post('/window', { session: item.session, windowId: null });
  await post('/clear', {}).catch(() => {});
  for (const item of plan) await post('/status', { session: item.session, clear: true });
  for (const item of plan) await post('/visible', { session: item.session, visible: false });
  console.log('完成（小窗已收起）');
}

// 只有直接执行本文件才跑 main：被单测 import 时不能有副作用（不能去碰应用/小窗）。
const invokedDirectly = isDirectRun(import.meta.url);
if (invokedDirectly) main().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
