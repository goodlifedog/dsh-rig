#!/usr/bin/env node
'use strict';
/**
 * 用户离开时的一条龙维护（自动跑，不抢用户在场的时间）：
 *
 *   1. 完整验收          node scripts/live-verify.mjs      （内部还有自己的空闲门槛与中止逻辑）
 *   2. 按门类跑矩阵       node core/tasks/app-matrix.mjs   （reading / mail / calendar / photos / media）
 *   3. 重新清点          node scripts/app-inventory.mjs    （把新门类从「未测」刷新成实结论）
 *
 * 安全边界（这是重点）：
 *   - 每个步骤开始前重新检查「屏幕未锁 + 键鼠空闲 ≥ AWAY_MIN_IDLE_SEC（默认 900 秒）」；
 *   - 运行期间每 5 秒复查一次：锁屏或用户回来（空闲 < AWAY_ABORT_IDLE_SEC，默认 20 秒）→
 *     立刻按进程组收掉当前子进程（不是只 kill 单个 pid），并停止后续所有步骤；
 *   - 有别的验收在跑（reports/.acceptance.lock 属于其它进程）→ 直接不跑，避免互相踩；
 *   - 全程只记录、不 commit、不改文档；结果落在 logs/away/<时间戳>.log。
 *
 *   --dry-run：只打印计划与当前环境判断，不执行任何步骤（可在用户在场时安全运行）。
 *
 * 纯逻辑（decideAwayState / buildPlan / summarizeSteps）可单测；系统调用都收在 runStep 里。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isScreenLocked } from '../core/platform.mjs';
import { hidIdleMs } from '../core/front-watch.mjs';
import { killTaskTree } from '../core/orphan-cleanup.mjs';
import { foreignAcceptanceOwner } from '../core/acceptance-lock.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const LOG_DIR = path.join(ROOT, 'logs', 'away');
const ACCEPTANCE_LOCK = path.join(ROOT, 'reports', '.acceptance.lock');

/** 开始门槛 / 运行中中止门槛（秒）；都可用环境变量调 */
export const MIN_IDLE_SEC = Math.max(60, Number(process.env.AWAY_MIN_IDLE_SEC || 900));
export const ABORT_IDLE_SEC = Math.max(5, Number(process.env.AWAY_ABORT_IDLE_SEC || 20));
export const POLL_MS = Math.max(1000, Number(process.env.AWAY_POLL_MS || 5000));

/**
 * 当前环境能不能开始 / 要不要中止（纯函数）。
 * @param {{locked?:boolean, idleMs?:number, minIdleMs:number, abortIdleMs?:number}} input
 * @returns {{go:boolean, reason:string}}
 */
export function decideAwayState(input = {}) {
  const opts = input || {};
  const minIdleMs = Number(opts.minIdleMs) || 0;
  const abortIdleMs = Number.isFinite(opts.abortIdleMs) ? Number(opts.abortIdleMs) : minIdleMs;
  const idleMs = Number(opts.idleMs);
  if (opts.locked === true) return { go: false, reason: '屏幕已锁，AX/截图不可用' };
  if (!Number.isFinite(idleMs) || idleMs < 0) return { go: false, reason: '读不到键鼠空闲时间' };
  if (idleMs < abortIdleMs) return { go: false, reason: '用户在场（键鼠空闲 ' + Math.round(idleMs / 1000) + 's < ' + Math.round(abortIdleMs / 1000) + 's）' };
  if (idleMs < minIdleMs) return { go: false, reason: '还没离开够久（空闲 ' + Math.round(idleMs / 1000) + 's < ' + Math.round(minIdleMs / 1000) + 's）' };
  return { go: true, reason: '' };
}

/** 执行计划（纯函数，便于单测顺序/参数）。 */
export function buildPlan() {
  return [
    { name: '完整验收 verify:live', script: 'scripts/live-verify.mjs', timeoutMs: 40 * 60 * 1000 },
    { name: '矩阵 reading（预览）', script: 'core/tasks/app-matrix.mjs', env: { MATRIX_PRESET: 'reading' }, timeoutMs: 10 * 60 * 1000 },
    { name: '矩阵 mail（邮件）', script: 'core/tasks/app-matrix.mjs', env: { MATRIX_PRESET: 'mail' }, timeoutMs: 10 * 60 * 1000 },
    { name: '矩阵 calendar（日历+提醒事项）', script: 'core/tasks/app-matrix.mjs', env: { MATRIX_PRESET: 'calendar' }, timeoutMs: 12 * 60 * 1000 },
    { name: '矩阵 photos（照片）', script: 'core/tasks/app-matrix.mjs', env: { MATRIX_PRESET: 'photos' }, timeoutMs: 10 * 60 * 1000 },
    { name: '矩阵 media（含音乐）', script: 'core/tasks/app-matrix.mjs', env: { MATRIX_PRESET: 'media' }, timeoutMs: 12 * 60 * 1000 },
    { name: '重新清点', script: 'scripts/app-inventory.mjs', timeoutMs: 3 * 60 * 1000 },
  ];
}

/** 汇总（纯函数）：任何步骤失败/被中止都不算跑完。 */
export function summarizeSteps(steps) {
  const list = Array.isArray(steps) ? steps : [];
  const ok = list.every((s) => s && s.status === 'ok');
  const failed = list.filter((s) => s && s.status === 'failed');
  const stopped = list.filter((s) => s && s.status === 'stopped');
  const text = '共 ' + list.length + ' 步：成功 ' + list.filter((s) => s && s.status === 'ok').length
    + (stopped.length ? '，中止 ' + stopped.length : '')
    + (failed.length ? '，失败 ' + failed.length : '');
  return { ok, failed, stopped, text };
}

function log(line) {
  const text = '[' + new Date().toISOString() + '] ' + line;
  console.log(text);
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(path.join(LOG_DIR, process.env.AWAY_LOG_FILE || 'latest.log'), text + '\n');
  } catch {}
}

async function readState() {
  // isScreenLocked 是同步函数（内部 execFileSync），hidIdleMs 是异步的；都包一层兜底，
  // 读不到就按「锁屏/用户在场」处理（宁可这次不跑，也不要抢用户的屏幕）。
  let locked = true;
  try { locked = Boolean(await isScreenLocked()); } catch {}
  let idleMs = -1;
  try { idleMs = Number(await hidIdleMs()); } catch {}
  if (!Number.isFinite(idleMs)) idleMs = -1;
  return { locked, idleMs };
}

/**
 * 跑一步：独立进程组，运行期间持续检查用户是否回来/锁屏。
 * @returns {Promise<{name:string, status:'ok'|'failed'|'stopped'|'skipped', code?:number|null, reason?:string, ms:number}>}
 */
export function runStep(step, deps = {}) {
  const read = typeof deps.readState === 'function' ? deps.readState : readState;
  const kill = typeof deps.kill === 'function' ? deps.kill : killTaskTree;
  const spawnFn = typeof deps.spawn === 'function' ? deps.spawn : spawn;
  const now = typeof deps.now === 'function' ? deps.now : Date.now;
  const pollMs = Number(deps.pollMs) || POLL_MS;
  const abortIdleMs = Number.isFinite(deps.abortIdleMs) ? Number(deps.abortIdleMs) : ABORT_IDLE_SEC * 1000;
  const started = now();

  return new Promise((resolve) => {
    const script = path.join(ROOT, step.script);
    const child = spawnFn(process.execPath, [script], {
      cwd: ROOT,
      detached: true,
      env: Object.assign({}, process.env, step.env || {}),
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    let settled = false;
    let aborted = '';
    const finish = (status, code, reason) => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      clearTimeout(timer);
      resolve({ name: step.name, status, code, reason, ms: now() - started });
    };
    const poll = setInterval(async () => {
      const state = await read().catch(() => ({ locked: true, idleMs: -1 }));
      const decision = decideAwayState({ locked: state.locked, idleMs: state.idleMs, minIdleMs: 0, abortIdleMs });
      if (decision.go) return;
      aborted = decision.reason;
      log('中止当前步骤（' + decision.reason + '）：' + step.name);
      try { kill(child.pid, { graceMs: 3000 }); } catch {}
    }, pollMs);
    const timer = setTimeout(() => {
      aborted = '超时（' + Math.round(step.timeoutMs / 1000) + 's）';
      log('步骤超时，收掉进程组：' + step.name);
      try { kill(child.pid, { graceMs: 3000 }); } catch {}
    }, step.timeoutMs || 10 * 60 * 1000);
    child.on('error', (error) => finish('failed', null, String(error && error.message || error)));
    child.on('close', (code) => {
      if (aborted) return finish('stopped', code, aborted);
      if (code === 0) return finish('ok', 0, '');
      finish('failed', code, '退出码 ' + code);
    });
  });
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const plan = buildPlan();
  const foreign = await foreignAcceptanceOwner(ACCEPTANCE_LOCK, { selfPids: [process.pid, process.ppid] }).catch(() => null);
  const state = await readState();
  const decision = decideAwayState({
    locked: state.locked,
    idleMs: state.idleMs,
    minIdleMs: MIN_IDLE_SEC * 1000,
    abortIdleMs: ABORT_IDLE_SEC * 1000,
  });

  console.log('=== 用户离开时的维护计划 ===');
  console.log('锁屏=' + state.locked + ' 空闲=' + (state.idleMs >= 0 ? Math.round(state.idleMs / 1000) + 's' : '读不到')
    + ' 开始门槛=' + MIN_IDLE_SEC + 's 中止门槛=' + ABORT_IDLE_SEC + 's');
  plan.forEach((s, i) => console.log('  ' + (i + 1) + ') ' + s.name + '（' + s.script + (s.env ? '，' + JSON.stringify(s.env) : '') + '）'));
  if (foreign) console.log('⚠ 另一个验收正在跑（pid ' + foreign.pid + '）：本次不跑');
  if (!decision.go) console.log('现在不跑：' + decision.reason);
  if (dryRun) { console.log('（--dry-run：只打印，不执行）'); return; }
  if (foreign) return;
  if (!decision.go) { process.exitCode = 0; return; }

  const results = [];
  for (const step of plan) {
    const before = await readState();
    const gate = decideAwayState({ locked: before.locked, idleMs: before.idleMs, minIdleMs: MIN_IDLE_SEC * 1000, abortIdleMs: ABORT_IDLE_SEC * 1000 });
    if (!gate.go) {
      log('停止后续步骤：' + gate.reason);
      results.push({ name: step.name, status: 'stopped', reason: '开始前检查不通过：' + gate.reason, ms: 0 });
      break;
    }
    log('开始：' + step.name);
    const result = await runStep(step);
    log('结束：' + step.name + ' → ' + result.status + (result.reason ? '（' + result.reason + '）' : '') + ' ' + Math.round(result.ms / 1000) + 's');
    results.push(result);
    if (result.status !== 'ok') break;
  }
  const summary = summarizeSteps(results);
  log('汇总：' + summary.text);
  if (!summary.ok) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error('FAIL:', error && error.message || error);
    process.exitCode = 1;
  });
}

export default { decideAwayState, buildPlan, summarizeSteps, runStep, MIN_IDLE_SEC, ABORT_IDLE_SEC };
