#!/usr/bin/env node
/**
 * adapter-demo —— 适配实测工具（给 7 个候选应用产出可复制的实测命令与真实证据）
 *
 *   node core/tasks/adapter-demo.mjs --app <显示名> [--file <样例路径>] \
 *        [--click-text <按钮文字>] [--type-text <文字>] [--allow-launch]
 *
 * 步骤（每一步都写进 JSON 的 steps）：
 *   1) 守卫：锁屏 / 用户键鼠活跃 / front-risk 名单 → 环境跳过（exit 0 + envSkip，不碰应用）
 *   2) 运行状态：isAppRunning；没运行默认环境跳过，显式 --allow-launch 才 ensureAppRunning
 *      （登记 launchedByUs，结束时只 quitApp 自己拉起的那个）
 *   3) --file：样例先复制到系统临时目录（mkdtemp 0700），再 open -g -a <app> <临时副本>
 *      （后台打开，不抢前台；用完删除临时目录，绝不写仓库里的 examples/adapters/*）
 *   4) 读界面树：记录 nodes 数 / 窗口标题 / 按钮与输入区
 *   5) --click-text：按可见文字找按钮 → accessibility 点击 → 读回状态证明变化
 *   6) --type-text：找可写输入区 set_value → 读回 value 校验
 *   7) 回显探测：小窗窗口列表找到该应用则 screencapture -l 截图到临时文件；拿不到如实记 skip
 *
 * 退出码：环境问题 0 + envSkip=true；能力失败 1；全部通过 0。
 */
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isDirectRun } from '../direct-run.mjs';

import { ensureAppRunning, frontName, isAppRunning, quitApp } from '../background.mjs';
import { lockedSkipNotice, isScreenLocked } from '../platform.mjs';
import { shouldDeferForActiveUser } from '../user-activity.mjs';
import { createRiskGate } from '../front-risk.mjs';
import { ocu, overlay } from '../agentd.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(HERE, '..', '..');

/** 候选应用的进程名提示（isAppRunning 用 pgrep -x；拿不准就用显示名兜底） */
export const APP_HINTS = {
  Preview: { processName: 'Preview' },
  Safari: { processName: 'Safari' },
  Chrome: { processName: 'Google Chrome' },
  'Google Chrome': { processName: 'Google Chrome' },
  TextEdit: { processName: 'TextEdit' },
  文本编辑: { processName: 'TextEdit' },
  QQ: { processName: 'QQ' },
  Ghostty: { processName: 'Ghostty' },
  WPS: { processName: 'wpsoffice' },
  'WPS Office': { processName: 'wpsoffice' },
};

/** 默认等待/超时（都可被 options 覆盖，便于单测不真等） */
export const DEFAULT_WAIT_MS = 1200;

// ------------------------- 纯函数（可单测，不碰系统） -------------------------

/**
 * 解析 CLI 参数。
 * @param {string[]} argv process.argv.slice(2)
 * @returns {{app:string, file:string, clickText:string, typeText:string, allowLaunch:boolean, help:boolean, errors:string[]}}
 */
export function parseArgs(argv) {
  const args = Array.isArray(argv) ? argv.slice() : [];
  const out = { app: '', file: '', clickText: '', typeText: '', allowLaunch: false, help: false, errors: [] };
  const valueOf = (flag, index) => {
    const value = args[index + 1];
    if (value === undefined || value.startsWith('--')) {
      out.errors.push(flag + ' 缺少参数值');
      return '';
    }
    return value;
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') out.help = true;
    else if (arg === '--allow-launch') out.allowLaunch = true;
    else if (arg === '--app') { out.app = valueOf(arg, i); i += 1; }
    else if (arg === '--file') { out.file = valueOf(arg, i); i += 1; }
    else if (arg === '--click-text') { out.clickText = valueOf(arg, i); i += 1; }
    else if (arg === '--type-text') { out.typeText = valueOf(arg, i); i += 1; }
    else if (arg.startsWith('--')) out.errors.push('未知参数：' + arg);
  }
  if (!out.help && !out.app) out.errors.push('缺少 --app <显示名>');
  return out;
}

/** 显示名别名（front-risk 名单里可能记的是本地化名/另一套写法，查名单时都试一遍） */
export const APP_ALIASES = {
  TextEdit: ['文本编辑', 'TextEdit'],
  文本编辑: ['TextEdit'],
  Preview: ['预览'],
  预览: ['Preview'],
  Chrome: ['Google Chrome'],
  'Google Chrome': ['Chrome'],
  WPS: ['WPS Office', 'wpsoffice'],
  'WPS Office': ['WPS', 'wpsoffice'],
};

/** 查 front-risk 名单时要用到的所有名字（显示名 + 进程名 + 别名，纯函数） */
export function riskNamesFor(app) {
  const name = String(app || '').trim();
  const names = [name, processNameFor(name)].concat(APP_ALIASES[name] || []);
  return Array.from(new Set(names.filter(Boolean)));
}

/** 应用的进程名提示（纯函数） */
export function processNameFor(app) {
  const name = String(app || '').trim();
  const hint = APP_HINTS[name];
  return (hint && hint.processName) || name;
}

/** 应用是否在 front-risk 名单里（显示名/进程名/本地化别名都查一遍；纯函数 + 注入 gate） */
export function findRiskHit(riskGateLike, app) {
  if (!riskGateLike || typeof riskGateLike.shouldSkip !== 'function') return '';
  for (const name of riskNamesFor(app)) {
    if (riskGateLike.shouldSkip(name)) return name;
  }
  return '';
}

/**
 * 决定「这次要不要跑 / 要不要启动」——守卫顺序固定，front-risk 名单不允许被 --allow-launch 绕过。
 * @param {{locked:boolean, userActive:boolean, userActiveReason?:string, risky:boolean, running:boolean, allowLaunch:boolean, app:string}} input
 * @returns {{mode:'skip'|'run'|'launch', envSkip:boolean, launch:boolean, reason:string}}
 */
export function decideRunGate(input = {}) {
  const app = String(input.app || '');
  if (input.locked) {
    return { mode: 'skip', envSkip: true, launch: false, reason: lockedSkipNotice('adapter-demo') };
  }
  if (input.userActive) {
    return {
      mode: 'skip',
      envSkip: true,
      launch: false,
      reason: input.userActiveReason || '你正在操作电脑，这次跳过以免打断你',
    };
  }
  if (input.risky) {
    const hit = input.riskyAs && input.riskyAs !== app ? '（名单命中：' + input.riskyAs + '）' : '';
    return {
      mode: 'skip',
      envSkip: true,
      launch: false,
      reason: '环境跳过：' + app + hit + ' 在 front-risk 名单里（读它可能把前台抢走）；该名单不允许 --allow-launch 绕过，确需实测请先手动清名单：'
        + 'node scripts/front-risk.mjs clear ' + app,
    };
  }
  if (input.running) {
    return { mode: 'run', envSkip: false, launch: false, reason: app + ' 已在运行，直接读' };
  }
  if (input.allowLaunch) {
    return { mode: 'launch', envSkip: false, launch: true, reason: app + ' 没在运行；已显式 --allow-launch，本次启动并在结束时关闭' };
  }
  return {
    mode: 'skip',
    envSkip: true,
    launch: false,
    reason: '环境跳过：' + app + ' 没在运行（不为了测试去启动它；确需启动请加 --allow-launch）',
  };
}

/** 解析界面树：节点数 / 窗口标题 / 按钮 / 输入区 / 文本行（纯函数） */
export function summarizeTree(stateText) {
  const text = String(stateText || '');
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  const nodeLines = lines.filter((line) => /^\d+\s/.test(line));
  const titleMatch = /^Window: "([^"]*)"/m.exec(text);
  const buttons = [];
  const inputs = [];
  const inputsRaw = [];
  for (const line of nodeLines) {
    const m = /^(\d+)\s+(.+)$/.exec(line);
    if (!m) continue;
    const index = m[1];
    const rest = m[2].trim();
    if (/^(?:按钮|button)/.test(rest)) {
      buttons.push({ index, label: rest.replace(/^(?:按钮|button)\s*/, '').trim() });
    } else if (/^(?:文本输入区|文本栏|text area|text field)/.test(rest)) {
      inputsRaw.push({ index, label: rest.trim() });
      inputs.push({
        index,
        label: rest.trim(),
        settable: /settable/.test(rest),
        kind: /文本输入区|text area/.test(rest) ? 'textArea' : 'textField',
      });
    }
  }
  return {
    readable: nodeLines.length > 0 && Boolean(titleMatch),
    nodes: nodeLines.length,
    windowTitle: titleMatch ? titleMatch[1] : '',
    buttons,
    inputs,
    lines,
  };
}

/** 按可见文字挑按钮：先精确、再包含（纯函数） */
export function pickClickTarget(summary, clickText) {
  const wanted = String(clickText || '').trim();
  if (!wanted || !summary) return { found: false, reason: '未提供 --click-text' };
  const buttons = Array.isArray(summary.buttons) ? summary.buttons : [];
  const exact = buttons.find((b) => b.label === wanted);
  if (exact) return { found: true, index: exact.index, label: exact.label, match: 'exact' };
  const partial = buttons.find((b) => b.label.includes(wanted));
  if (partial) return { found: true, index: partial.index, label: partial.label, match: 'contains' };
  return { found: false, reason: '按钮列表里找不到文字「' + wanted + '」', candidates: buttons.slice(0, 10) };
}

/** 挑可写输入区：优先 settable 的文本输入区，其次文本栏（纯函数） */
export function pickTypeTarget(summary) {
  const inputs = (summary && Array.isArray(summary.inputs)) ? summary.inputs : [];
  const preferred = inputs.find((i) => i.settable !== false && i.kind === 'textArea')
    || inputs.find((i) => i.settable !== false);
  if (!preferred) return { found: false, reason: '界面树里找不到可写输入区' };
  return { found: true, index: preferred.index, label: preferred.label, kind: preferred.kind };
}

/** 两次界面树之间是否有变化（纯函数）：标题/节点数/新增行 任一变化即算 */
export function hasStateChanged(before, after) {
  if (!before || !after) return { changed: false, detail: '缺少前后状态' };
  const details = [];
  if (before.windowTitle !== after.windowTitle) details.push('窗口标题：' + JSON.stringify(before.windowTitle) + ' → ' + JSON.stringify(after.windowTitle));
  if (before.nodes !== after.nodes) details.push('节点数：' + before.nodes + ' → ' + after.nodes);
  const beforeSet = new Set(before.lines);
  const added = after.lines.filter((line) => !beforeSet.has(line));
  if (added.length) details.push('新增/变化元素行 ' + added.length + ' 条，例如 ' + JSON.stringify(added.slice(0, 3)));
  return { changed: details.length > 0, detail: details.join('；') };
}

// ------------------------- 前台比对：忽略系统浮层（M5/task-92） -------------------------

/**
 * 系统浮层名单：通知横幅/控制中心/锁屏/Window Server/Dock/Spotlight/输入法候选等。
 * 这些浮层出现在最前面不代表「真实前台被抢」，比对时要忽略；但 front.before/after 仍记录真实值。
 */
export const SYSTEM_OVERLAY_NAMES = Object.freeze([
  'NotificationCenter', 'Notification Center', '通知中心',
  'ControlCenter', 'Control Center', '控制中心',
  'Window Server', 'WindowServer',
  'loginwindow',
  'Dock',
  'Spotlight',
  '输入法候选', '候选窗口', 'Candidate Window', 'Input Method Candidate',
]);

/** 是否系统浮层（英文大小写不敏感；中文按包含匹配；纯函数） */
export function isSystemOverlay(name) {
  const raw = String(name == null ? '' : name).trim();
  if (!raw) return false;
  const lower = raw.toLowerCase();
  for (const token of SYSTEM_OVERLAY_NAMES) {
    const t = token.toLowerCase();
    if (raw === token || lower === t) return true;
    // 英文：整词或 "Dock " 前缀（避免 Docker Desktop 之类误伤）；中文：包含即可
    if (/[\u4e00-\u9fa5]/.test(token) ? raw.includes(token) : (lower === t || lower.startsWith(t + ' ') || lower.endsWith(' ' + t))) return true;
  }
  return false;
}

/** 用于比对的前台名：浮层按空串处理，其余 trim（纯函数） */
export function frontForCompare(name) {
  const raw = String(name == null ? '' : name).trim();
  return isSystemOverlay(raw) ? '' : raw;
}

/**
 * 前后台比对（纯函数）：忽略系统浮层，返回是否未变 + 被忽略的浮层名。
 * baseline 传「基线名」（可能是 raw before，也可能是稳定采样里挑出的真实前台）。
 */
export function compareFront(beforeName, afterName) {
  const base = frontForCompare(beforeName);
  const after = frontForCompare(afterName);
  const ignoredOverlays = [];
  for (const name of [beforeName, afterName]) {
    if (isSystemOverlay(name)) {
      const raw = String(name).trim();
      if (raw && !ignoredOverlays.includes(raw)) ignoredOverlays.push(raw);
    }
  }
  // 基线或结束值是浮层/读不到时，不做「被抢」判定（没有可信的真实前台可比）
  const unchanged = !(base && after) || base === after;
  return { unchanged, baseline: base, after, ignoredOverlays };
}

function uniq(list) {
  return Array.from(new Set((list || []).filter(Boolean)));
}

/**
 * 动作前采样前台基线：连续读 2 次；只有浮层差异视为稳定（浮层是瞬态的）。
 * 不稳 → 重试，最多 attempts 次；仍不稳由调用方按环境跳过处理（不当 FAIL）。
 *
 * @param {{frontName:Function, sleep:Function}} deps
 * @param {{attempts?:number, gapMs?:number}} [options]
 */
export async function sampleFrontBaseline(deps, options = {}) {
  const opts = options || {};
  const attempts = Number.isFinite(opts.attempts) && opts.attempts > 0 ? Math.floor(opts.attempts) : 3;
  const gapMs = Number.isFinite(opts.gapMs) && opts.gapMs >= 0 ? opts.gapMs : 120;
  const read = () => Promise.resolve().then(() => deps.frontName()).catch(() => '');
  const samples = [];
  const overlays = [];
  let raw = '';
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const first = String((await read()) || '').trim();
    await deps.sleep(gapMs);
    const second = String((await read()) || '').trim();
    raw = first;
    samples.push(first, second);
    for (const name of [first, second]) if (isSystemOverlay(name)) overlays.push(name);
    const a = frontForCompare(first);
    const b = frontForCompare(second);
    // 稳定：真实前台一致；或只有一边是浮层（横幅划过，不算前台变化）
    if (a === b || (a && !b) || (!a && b)) {
      return {
        stable: true,
        baseline: a || b,
        raw,
        samples,
        ignoredOverlays: uniq(overlays),
        attempts: attempt,
      };
    }
  }
  return {
    stable: false,
    baseline: '',
    raw,
    samples,
    ignoredOverlays: uniq(overlays),
    attempts,
    reason: '环境跳过：前台基线不稳定（连续采样结果不一致：' + samples.join(' → ') + '），无法可靠判断前台是否被抢',
  };
}

/** 读回文本里某个 value（纯函数，用于校验 type-text） */
export function extractValue(stateText, index) {
  const text = String(stateText || '');
  const lines = text.split('\n');
  for (const line of lines) {
    const m = /^\s*(\d+)\s+.*?Value: (.*)$/.exec(line);
    if (m && (!index || m[1] === String(index))) return m[2];
  }
  return '';
}

// ------------------------- 真实依赖（单测全部注入假实现） -------------------------

/** 读键鼠空闲毫秒（ioreg HIDIdleTime 是纳秒）；失败返回 -1 */
function readIdleMs() {
  try {
    const out = execFileSync('/usr/sbin/ioreg', ['-c', 'IOHIDSystem', '-d', '4'], { encoding: 'utf8', timeout: 3000 });
    const m = /"HIDIdleTime" = (\d+)/.exec(out);
    return m ? Math.round(Number(m[1]) / 1e6) : -1;
  } catch { return -1; }
}

const defaultDeps = {
  isScreenLocked,
  idleMs: readIdleMs,
  shouldDeferForActiveUser,
  riskGate: () => createRiskGate(),
  isAppRunning,
  ensureAppRunning,
  quitApp,
  frontName,
  readState: (app) => ocu.snapshot(app, { nodes: 5000 }),
  click: (app, index) => ocu.call('click', { app, element_index: String(index), click_method: 'accessibility' }),
  setValue: (app, index, value) => ocu.call('set_value', { app, element_index: String(index), value }),
  openBackground: (app, file) => new Promise((resolve) => {
    execFile('/usr/bin/open', ['-g', '-a', app, file], { timeout: 15000 }, (error) => resolve({ ok: !error, error: error ? String(error.message) : '' }));
  }),
  echoScreenshot: async (app, dir) => {
    const win = await overlay.findWindow(app).catch(() => null);
    if (!win || !win.windowId) return { ok: false, skipped: true, reason: '小窗 /windows 里没有该应用窗口（可能不在当前 Space 或未运行）' };
    const shot = path.join(dir, 'echo.jpg');
    const result = await new Promise((resolve) => {
      execFile('/usr/sbin/screencapture', ['-x', '-o', '-l', String(win.windowId), '-t', 'jpg', shot], { timeout: 8000 }, (error) => resolve({ ok: !error, error: error ? String(error.message) : '' }));
    });
    if (!result.ok) return { ok: false, skipped: true, reason: 'screencapture 抓不到该窗口（缺屏幕录制权限/窗口不可见）：' + result.error };
    const size = fs.existsSync(shot) ? fs.statSync(shot).size : 0;
    if (!size) return { ok: false, skipped: true, reason: '截图为空文件' };
    return { ok: true, windowId: win.windowId, title: win.title || '', bytes: size };
  },
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  mkdtemp: (prefix) => {
    const dir = fs.mkdtempSync(prefix);
    try { fs.chmodSync(dir, 0o700); } catch {}
    return dir;
  },
  copyFile: (src, dst) => fs.copyFileSync(src, dst),
  rmDir: (dir) => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} },
};

// ------------------------- 主流程（deps 可注入，单测不碰真系统） -------------------------

export async function runAdapterDemo(options = {}, depsInput = {}) {
  const deps = Object.assign({}, defaultDeps, depsInput || {});
  const options_ = options || {};
  const app = String(options_.app || '').trim();
  const steps = [];
  const report = {
    app,
    launched: false,
    readable: false,
    nodes: 0,
    steps,
    front: { before: '', after: '', unchanged: true, baseline: '' },
    ignoredOverlays: [],
    envSkip: false,
    reason: '',
    file: options_.file ? String(options_.file) : '',
    tempDir: '',
  };
  const addStep = (step, ok, detail, extra) => {
    steps.push(Object.assign({ step, ok, detail: detail || '' }, extra || {}));
  };
  const finish = (exitCode) => ({ exitCode, report });

  if (!app) {
    report.reason = '缺少 --app <显示名>';
    addStep('args', false, report.reason);
    return finish(1);
  }

  // 先记一次真实前台（仅用于环境跳过时的上下文；动作前的正式基线在 open/launch 之后采）
  report.front.before = await deps.frontName().catch(() => '');
  const idleMs = await Promise.resolve().then(() => deps.idleMs()).catch(() => -1);
  const userActive = deps.shouldDeferForActiveUser(idleMs);
  let risky = false;
  let riskyAs = '';
  try {
    riskyAs = findRiskHit(deps.riskGate(), app);
    risky = Boolean(riskyAs);
  } catch { risky = false; }
  const running = await deps.isAppRunning({ appName: app, processName: processNameFor(app) }).catch(() => false);

  const gate = decideRunGate({
    locked: Boolean(deps.isScreenLocked()),
    userActive: Boolean(userActive.defer),
    userActiveReason: userActive.reason,
    risky,
    riskyAs,
    running,
    allowLaunch: Boolean(options_.allowLaunch),
    app,
  });
  if (gate.mode === 'skip') {
    report.envSkip = true;
    report.reason = gate.reason;
    report.front.after = report.front.before;
    addStep('gate', true, gate.reason, { skipped: true });
    return finish(0);
  }
  addStep('gate', true, gate.reason);

  if (gate.launch) {
    let launch = null;
    try {
      launch = await deps.ensureAppRunning({ appName: app, processName: processNameFor(app) }, { waitMs: 8000 });
    } catch (error) {
      launch = { launched: false, running: false, error: String((error && error.message) || error) };
    }
    const launched = Boolean(launch && (launch.launched || launch.running));
    if (!launched) {
      report.envSkip = true;
      report.reason = '环境跳过：无法启动 ' + app + '（' + ((launch && (launch.error || launch.detail)) || '启动失败') + '）';
      report.front.after = report.front.before;
      addStep('launch', true, report.reason, { skipped: true });
      return finish(0);
    }
    report.launched = Boolean(launch.launched);
    addStep('launch', true, '已启动 ' + app + '（launchedByUs=' + report.launched + '）', { launchedByUs: report.launched });
    await deps.sleep(Number(options_.launchWaitMs || 1500));
  }

  let tempDir = '';
  try {
    if (report.file) {
      // 关键：样例先复制到 0700 临时目录再打开，绝不把 --type-text 写进仓库里的样例文件
      tempDir = deps.mkdtemp(path.join(os.tmpdir(), 'adapter-demo-'));
      report.tempDir = tempDir;
      const src = path.isAbsolute(report.file) ? report.file : path.join(REPO_ROOT, report.file);
      if (!fs.existsSync(src)) {
        addStep('open-file', false, '样例文件不存在：' + src);
        return finish(1);
      }
      const copy = path.join(tempDir, path.basename(src));
      deps.copyFile(src, copy);
      const opened = await deps.openBackground(app, copy);
      addStep('open-file', Boolean(opened && opened.ok), opened && opened.ok
        ? '已后台打开临时副本：' + copy
        : 'open -g -a 失败：' + ((opened && opened.error) || '未知错误'), { tempFile: copy });
      await deps.sleep(Number(options_.openWaitMs || 1500));
    }

    // 动作前基线：连续采 2 次；不稳重试（默认最多 3 次）；仍不稳按环境跳过，不判 FAIL。
    // 系统浮层（通知横幅/控制中心/Dock/输入法候选等）不算真实前台，比对时忽略但真实值仍记录。
    const baseline = await sampleFrontBaseline(deps, {
      attempts: options_.baselineAttempts,
      gapMs: options_.baselineGapMs,
    });
    report.front.before = baseline.raw || baseline.baseline;
    report.front.baseline = baseline.baseline;
    report.ignoredOverlays = uniq(report.ignoredOverlays.concat(baseline.ignoredOverlays || []));
    addStep('front-baseline', baseline.stable,
      baseline.stable
        ? '基线=' + (baseline.baseline || '(unknown)')
          + (baseline.ignoredOverlays.length ? '（忽略系统浮层：' + baseline.ignoredOverlays.join(', ') + '）' : '')
          + '，采样 ' + baseline.attempts + ' 次'
        : baseline.reason,
      { baseline: baseline.baseline, ignoredOverlays: baseline.ignoredOverlays, samples: baseline.samples });
    if (!baseline.stable) {
      report.envSkip = true;
      report.reason = baseline.reason;
      report.front.after = baseline.raw;
      report.front.unchanged = true;
      return finish(0);
    }

    // 读界面树
    const beforeState = await deps.readState(app).catch((error) => '__ERR__ ' + String((error && error.message) || error));
    const before = summarizeTree(beforeState);
    report.readable = before.readable;
    report.nodes = before.nodes;
    addStep('read-tree', before.readable,
      before.readable
        ? '窗口=' + JSON.stringify(before.windowTitle) + '，nodes=' + before.nodes + '，按钮 ' + before.buttons.length + '，输入区 ' + before.inputs.length
        : '读不到有效界面树（nodes=' + before.nodes + '）',
      { readable: before.readable, nodes: before.nodes, windowTitle: before.windowTitle });

    if (!before.readable) return finish(1);

    if (options_.clickText) {
      const target = pickClickTarget(before, options_.clickText);
      if (!target.found) {
        addStep('click-by-text', false, target.reason || ('找不到按钮：' + options_.clickText), { candidates: target.candidates || [] });
        return finish(1);
      }
      const clicked = await deps.click(app, target.index);
      await deps.sleep(Number(options_.clickWaitMs || 800));
      const afterState = await deps.readState(app).catch(() => '');
      const after = summarizeTree(afterState);
      const changed = hasStateChanged(before, after);
      addStep('click-by-text', Boolean(changed.changed) && (!clicked || clicked.ok !== false),
        '点中「' + target.label + '」index=' + target.index + '（' + target.match + '）；' + (changed.changed ? changed.detail : '点击后界面树没有可观测变化'),
        { index: target.index, label: target.label, changed: changed.changed, clickOk: clicked ? clicked.ok : null });
      if (!changed.changed) return finish(1);
    }

    if (options_.typeText) {
      const latestState = await deps.readState(app).catch(() => '');
      const latest = summarizeTree(latestState);
      const target = pickTypeTarget(latest);
      if (!target.found) {
        addStep('type-text', false, target.reason || '找不到可写输入区');
        return finish(1);
      }
      const written = await deps.setValue(app, target.index, String(options_.typeText));
      await deps.sleep(Number(options_.typeWaitMs || 600));
      const readBackState = await deps.readState(app).catch(() => '');
      const value = extractValue(readBackState, target.index);
      const ok = Boolean(written && written.ok !== false) && value === String(options_.typeText);
      addStep('type-text', ok, ok
        ? '写入并读回成功：index=' + target.index + ' value=' + JSON.stringify(value)
        : '读回 value 不符合预期：' + JSON.stringify(value) + '（期望 ' + JSON.stringify(options_.typeText) + '）',
        { index: target.index, value });
      if (!ok) return finish(1);
    }

    // 回显能力（小窗画面）：拿不到就如实 skip，不判失败
    const echo = await deps.echoScreenshot(app, tempDir || os.tmpdir()).catch((error) => ({ ok: false, skipped: true, reason: String((error && error.message) || error) }));
    addStep('echo', true, echo && echo.ok
      ? '小窗可回显：windowId=' + echo.windowId + '，截图 ' + echo.bytes + ' 字节'
      : '回显跳过：' + ((echo && echo.reason) || '拿不到窗口画面'), { skipped: Boolean(!echo || !echo.ok), windowId: echo && echo.windowId });
  } finally {
    // 收尾：只关自己拉起的应用；删临时目录（仓库样例不动）
    if (report.launched) {
      const quit = await deps.quitApp({ appName: app, processName: processNameFor(app) }).catch((error) => ({ quit: false, mode: 'error', detail: String((error && error.message) || error) }));
      addStep('quit-launched', Boolean(quit && quit.quit !== false), '关闭本次拉起的 ' + app + '：' + JSON.stringify(quit && (quit.mode || quit)).slice(0, 200));
    }
    if (tempDir) {
      deps.rmDir(tempDir);
      addStep('cleanup-temp', true, '已删除临时目录：' + tempDir, { tempDir });
      report.tempDir = '';
    }
    // 结束前台：忽略系统浮层后与基线比对（通知横幅划过不算被抢）
    report.front.after = await deps.frontName().catch(() => '');
    const cmp = compareFront(report.front.baseline || report.front.before, report.front.after);
    report.front.unchanged = report.envSkip ? true : cmp.unchanged;
    report.front.baseline = cmp.baseline || report.front.baseline;
    report.ignoredOverlays = uniq(report.ignoredOverlays.concat(cmp.ignoredOverlays || []));
  }

  const capable = steps.every((s) => s.ok !== false || s.skipped);
  if (!report.front.unchanged) {
    report.reason = '前台应用被改变：' + (report.front.baseline || report.front.before) + ' → ' + report.front.after
      + (report.ignoredOverlays.length ? '（已忽略系统浮层：' + report.ignoredOverlays.join(', ') + '）' : '');
    addStep('front-unchanged', false, report.reason);
    return finish(1);
  }
  addStep('front-unchanged', true, '前台未变：' + (report.front.baseline || report.front.before || '(unknown)')
    + (report.ignoredOverlays.length ? '（忽略系统浮层：' + report.ignoredOverlays.join(', ') + '）' : ''));
  report.reason = capable ? '' : '存在能力失败步骤';
  return finish(capable ? 0 : 1);
}

// ------------------------- CLI -------------------------

const HELP = [
  '用法: node core/tasks/adapter-demo.mjs --app <显示名> [--file <样例>] [--click-text <文字>] [--type-text <文字>] [--allow-launch]',
  '',
  '示例:',
  '  node core/tasks/adapter-demo.mjs --app TextEdit --file examples/adapters/sample.txt --type-text "[AGENT-TEST] typed"',
  '  node core/tasks/adapter-demo.mjs --app Preview --file examples/adapters/sample.png',
  '  node core/tasks/adapter-demo.mjs --app Chrome --file examples/adapters/sample.html --click-text "[AGENT-TEST] 提交" --allow-launch',
].join('\n');

// runner/daemon 用绝对路径 spawn 本文件；isDirectRun 会 realpath 归一后比较（统一入口约定）
const invokedDirectly = isDirectRun(import.meta.url);

if (invokedDirectly) {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(HELP);
    process.exit(0);
  }
  if (options.errors.length) {
    for (const error of options.errors) console.error('[adapter-demo] ' + error);
    console.error(HELP);
    process.exit(2);
  }
  runAdapterDemo(options)
    .then(({ exitCode, report }) => {
      console.log(JSON.stringify(report, null, 2));
      process.exit(exitCode);
    })
    .catch((error) => {
      console.error('FAIL:', (error && error.message) || error);
      process.exit(1);
    });
}

export { HELP as ADAPTER_DEMO_HELP, defaultDeps };
