#!/usr/bin/env node
'use strict';
/**
 * 用户离开时的一条龙维护（自动跑，不抢用户在场的时间）：
 *
 *   0. 刷新 daemon/overlay 到当前代码（launchd 常驻进程不会自己重启）
 *   1. 完整验收          node scripts/live-verify.mjs
 *   2. 按门类跑矩阵       node core/tasks/app-matrix.mjs（reading / mail / calendar / photos / media）
 *   3. 重新清点          node scripts/app-inventory.mjs
 *
 * 安全边界（这是重点，独立复核后加固过）：
 *   - 环境变量非法值一律回退默认（NaN 不能击穿门槛）；
 *   - 每个步骤开始前重新检查「屏幕未锁 + 键鼠空闲 ≥ AWAY_MIN_IDLE_SEC（默认 900 秒）」；
 *   - 运行期间立即 + 每 5 秒复查：锁屏或用户回来（空闲 < AWAY_ABORT_IDLE_SEC，默认 20 秒）→
 *     立刻按进程组收掉当前子进程（TERM → 4.5s 后 KILL 兜底），并停止后续所有步骤；
 *   - 自己的信号处理（SIGINT/SIGTERM/exit）：父进程被停掉时也要把 detached 子进程组收掉，
 *     否则会出现「用户回来了，矩阵还在后台动屏幕」；
 *   - 自己持有 reports/.away.lock：两个实例不会同时重启服务/跑矩阵；有别的验收在跑则不启动；
 *   - 每步结束做组存活确认，必要时补一次 SIGKILL（组长先退、组员忽略 TERM 的边界）；
 *   - --dry-run 只打印计划与当前环境判断（用户在场也能跑）。
 *
 * 纯逻辑（decideAwayState / buildPlan / summarizeSteps / parseEnvMs）可单测；
 * runStep 的 spawn/kill/时钟都可注入，便于覆盖「用户回来」「超时」「子进程不 close」等路径。
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isScreenLocked } from '../core/platform.mjs';
import { hidIdleMs } from '../core/front-watch.mjs';
import { killTaskTree } from '../core/orphan-cleanup.mjs';
import { acquireLock, releaseLock, foreignAcceptanceOwner } from '../core/acceptance-lock.mjs';
import { isDirectRun } from '../core/direct-run.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const LOG_DIR = path.join(ROOT, 'logs', 'away');
const ACCEPTANCE_LOCK = path.join(ROOT, 'reports', '.acceptance.lock');
const AWAY_LOCK = path.join(ROOT, 'reports', '.away.lock');

/**
 * 环境变量解析成毫秒（秒值 → ms），非法值回退默认并警告。
 * 复核 H1：以前 AWAY_MIN_IDLE_SEC=abc → NaN，NaN 参与比较会让门槛直接失效。
 */
export function parseEnvMs(raw, defaultSec, minSec, warn = () => {}) {
  const fallback = Math.max(minSec, defaultSec) * 1000;
  if (raw == null || String(raw).trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) { warn('环境变量值不是数字，回退默认 ' + defaultSec + 's：' + String(raw)); return fallback; }
  return Math.max(minSec, n) * 1000;
}

export const MIN_IDLE_MS = parseEnvMs(process.env.AWAY_MIN_IDLE_SEC || '900', 900, 60, (m) => console.warn('[away] ' + m));
export const ABORT_IDLE_MS = parseEnvMs(process.env.AWAY_ABORT_IDLE_SEC || '20', 20, 5, (m) => console.warn('[away] ' + m));
export const POLL_MS = parseEnvMs(process.env.AWAY_POLL_MS || '5', 5, 1, (m) => console.warn('[away] ' + m));
/** 兼容旧名字/测试：秒数形式 */
export const MIN_IDLE_SEC = Math.round(MIN_IDLE_MS / 1000);
export const ABORT_IDLE_SEC = Math.round(ABORT_IDLE_MS / 1000);

/** 日志文件名只允许简单名字，避免 AWAY_LOG_FILE 用 ../ 写出 logs/away（复核 L1） */
export function safeLogFileName(raw) {
  const name = String(raw == null ? '' : raw).trim();
  if (!name || !/^[A-Za-z0-9._-]+$/.test(name) || name === '.' || name === '..') return 'latest.log';
  return name;
}

/**
 * 当前环境能不能开始 / 要不要中止（纯函数）。
 * @param {{locked?:boolean, idleMs?:number, minIdleMs:number, abortIdleMs?:number}} input
 */
export function decideAwayState(input = {}) {
  const opts = input || {};
  const minIdleMs = Number.isFinite(Number(opts.minIdleMs)) ? Number(opts.minIdleMs) : 0;
  const abortIdleMs = Number.isFinite(Number(opts.abortIdleMs)) ? Number(opts.abortIdleMs) : minIdleMs;
  const idleMs = Number(opts.idleMs);
  if (opts.locked === true) return { go: false, reason: '屏幕已锁，AX/截图不可用' };
  if (!Number.isFinite(idleMs) || idleMs < 0) return { go: false, reason: '读不到键鼠空闲时间' };
  if (idleMs < abortIdleMs) return { go: false, reason: '用户在场（键鼠空闲 ' + Math.round(idleMs / 1000) + 's < ' + Math.round(abortIdleMs / 1000) + 's）' };
  if (idleMs < minIdleMs) return { go: false, reason: '还没离开够久（空闲 ' + Math.round(idleMs / 1000) + 's < ' + Math.round(minIdleMs / 1000) + 's）' };
  return { go: true, reason: '' };
}

/** 执行计划（纯函数）。 */
export function buildPlan() {
  return [
    { name: '刷新后台服务到当前代码', script: 'core/service.mjs', args: ['restart'], timeoutMs: 90 * 1000 },
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
  const ok = list.length > 0 && list.every((s) => s && s.status === 'ok');
  const failed = list.filter((s) => s && s.status === 'failed');
  const stopped = list.filter((s) => s && s.status === 'stopped');
  const skipped = list.filter((s) => s && s.status === 'skipped');
  const text = '共 ' + list.length + ' 步：成功 ' + list.filter((s) => s && s.status === 'ok').length
    + (skipped.length ? '，跳过 ' + skipped.length : '')
    + (stopped.length ? '，中止 ' + stopped.length : '')
    + (failed.length ? '，失败 ' + failed.length : '');
  return { ok, failed, stopped, skipped, text };
}

function logFile() {
  return path.join(LOG_DIR, safeLogFileName(process.env.AWAY_LOG_FILE || 'latest.log'));
}

function log(line) {
  const text = '[' + new Date().toISOString() + '] ' + line;
  console.log(text);
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(logFile(), text + '\n');
  } catch {}
}

async function readState() {
  // isScreenLocked 是同步函数（内部 execFileSync），hidIdleMs 是异步的；都包一层兜底：
  // 读不到就按「锁屏/用户在场」处理（宁可这次不跑，也不要抢用户的屏幕）。
  let locked = true;
  try { locked = Boolean(await isScreenLocked()); } catch {}
  let idleMs = -1;
  try { idleMs = Number(await hidIdleMs()); } catch {}
  if (!Number.isFinite(idleMs)) idleMs = -1;
  return { locked, idleMs };
}

/** 组是否还活着（负 pid 探测；用于组长先退但组员还在的边界） */
function groupAlive(pid, kill = process.kill) {
  try { kill(-Number(pid), 0); return true; } catch { return false; }
}

/**
 * 跑一步：独立进程组；运行期间立即 + 每 pollMs 检查用户是否回来/锁屏；超时和收不到 close 都有兜底。
 * 依赖全部可注入，便于单测（不产生真实进程）。
 * @param {{name:string, script:string, args?:string[], env?:object, timeoutMs:number}} step
 * @param {{spawn?:Function, readState?:Function, kill?:Function, now?:Function, pollMs?:number,
 *          abortIdleMs?:number, killGraceMs?:number, settleGraceMs?:number}} [deps]
 */
export function runStep(step, deps = {}) {
  const spawnFn = typeof deps.spawn === 'function' ? deps.spawn : spawn;
  const read = typeof deps.readState === 'function' ? deps.readState : readState;
  const kill = typeof deps.kill === 'function' ? deps.kill : killTaskTree;
  const now = typeof deps.now === 'function' ? deps.now : Date.now;
  const pollMs = Number.isFinite(deps.pollMs) ? deps.pollMs : POLL_MS;
  const abortIdleMs = Number.isFinite(deps.abortIdleMs) ? deps.abortIdleMs : ABORT_IDLE_MS;
  const killGraceMs = Number.isFinite(deps.killGraceMs) ? deps.killGraceMs : 4500;
  const settleGraceMs = Number.isFinite(deps.settleGraceMs) ? deps.settleGraceMs : killGraceMs + 1500;
  const schedule = typeof deps.setTimeout === 'function' ? deps.setTimeout : setTimeout;
  const clearScheduled = typeof deps.clearTimeout === 'function' ? deps.clearTimeout : clearTimeout;
  const every = typeof deps.setInterval === 'function' ? deps.setInterval : setInterval;
  const clearEvery = typeof deps.clearInterval === 'function' ? deps.clearInterval : clearInterval;
  const started = now();

  return new Promise((resolve) => {
    const script = path.join(ROOT, step.script);
    const argv = [script].concat(Array.isArray(step.args) ? step.args : []);
    const child = spawnFn(process.execPath, argv, {
      cwd: ROOT,
      detached: true,
      env: Object.assign({}, process.env, step.env || {}),
      stdio: ['ignore', 'inherit', 'inherit'],
    });

    let settled = false;
    let killResult = null;
    let aborted = '';
    let pollInFlight = false;
    activeChild = { child, pid: child.pid };

    const cleanupTimers = () => {
      try { clearEvery(poll); } catch {}
      try { clearScheduled(timeoutTimer); } catch {}
      try { clearScheduled(fallbackTimer); } catch {}
    };
    const finish = (status, code, reason) => {
      if (settled) return;
      settled = true;
      cleanupTimers();
      if (activeChild && activeChild.pid === child.pid) activeChild = null;
      // 组长退出了但组员可能还在：留着的 hardKill 不要取消，另做一次组存活确认
      if (child.pid && groupAlive(child.pid)) {
        log('检测到进程组仍有残留成员，补一次 SIGKILL：' + step.name + '（组 ' + child.pid + '）');
        try { kill(child.pid, { graceMs: 0 }); } catch {}
      }
      resolve({ name: step.name, status, code, reason, ms: now() - started });
    };
    const abortWith = (reason) => {
      if (settled) return;
      if (!aborted) aborted = reason;
      try { clearEvery(poll); } catch {}
      if (!killResult) {
        log('中止当前步骤（' + reason + '）：' + step.name);
        try { killResult = kill(child.pid, { graceMs: killGraceMs }); } catch {}
      }
      // 兜底：子进程不肯 close / 杀不掉时也要结算，避免整个脚本卡死
      if (!fallbackTimer) {
        fallbackTimer = schedule(() => {
          if (settled) return;
          log('步骤收不掉，强制结算：' + step.name);
          finish('stopped', null, (aborted || reason) + '（收不掉子进程）');
        }, settleGraceMs);
      }
    };

    let fallbackTimer = null;
    const tick = async () => {
      if (settled || pollInFlight) return;
      pollInFlight = true;
      try {
        const state = await read().catch(() => ({ locked: true, idleMs: -1 }));
        const decision = decideAwayState({ locked: state.locked, idleMs: state.idleMs, minIdleMs: 0, abortIdleMs });
        if (!decision.go) abortWith(decision.reason);
      } finally {
        pollInFlight = false;
      }
    };
    const poll = every(tick, pollMs);
    void tick(); // 立即查一次：spawn 之后 5 秒内用户回来也能停（复核 L4）
    const timeoutTimer = schedule(() => abortWith('超时（' + Math.round((step.timeoutMs || 0) / 1000) + 's）'), step.timeoutMs || 10 * 60 * 1000);

    child.on('error', (error) => finish('failed', null, String(error && error.message || error)));
    child.on('close', (code) => {
      if (killResult && typeof killResult.cancel === 'function') {
        // 组里没活人了才取消 KILL 兜底；有残留就让它按计划 SIGKILL
        if (!groupAlive(child.pid)) killResult.cancel();
      }
      if (aborted) return finish('stopped', code, aborted);
      if (code === 0) return finish('ok', 0, '');
      finish('failed', code, '退出码 ' + code);
    });
  });
}

// 父进程被 Ctrl-C / SIGTERM 停掉时，把 detached 子进程组一起收掉（复核 H2）
let activeChild = null;

function killActiveChild(sync = false) {
  const active = activeChild;
  if (!active || !active.pid) return;
  try {
    killTaskTree(active.pid, { graceMs: 0 }); // TERM + 立即 KILL，同步发出
    if (sync) {
      // 给组一点时间落地（同步等待很短：50ms × 6），避免一退出就丢信号
      const deadline = Date.now() + 300;
      const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
      while (Date.now() < deadline && groupAlive(active.pid)) sleepSync(50);
      if (groupAlive(active.pid)) { try { process.kill(-active.pid, 'SIGKILL'); } catch {} }
    }
  } catch {}
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    log('收到 ' + signal + '：先收掉当前子进程组再退出');
    killActiveChild(true);
    try { releaseLock(AWAY_LOCK); } catch {}
    process.exit(signal === 'SIGINT' ? 130 : 143);
  });
}
process.on('exit', () => {
  killActiveChild(false);
  try { releaseLock(AWAY_LOCK); } catch {}
});

/** 服务是否都跑到当前代码了（restart 之后确认；复核 M5） */
export function checkServicesFresh(exec = spawnSync) {
  const result = exec(process.execPath, [path.join(ROOT, 'core', 'service.mjs'), 'status'], { cwd: ROOT, encoding: 'utf8', timeout: 60000 });
  const text = String((result && (result.stdout || result.stderr)) || '');
  const stale = /落后/.test(text);
  return { fresh: !stale, detail: stale ? (text.split('\n').filter((l) => /落后/.test(l)).join('；') || '有服务落后') : '' };
}

/** 运行中每一步之前再确认「没有别的验收在跑」，读不到按 busy 处理（fail-closed） */
async function foreignBusy() {
  try {
    const owner = await foreignAcceptanceOwner(ACCEPTANCE_LOCK);
    return owner || null;
  } catch {
    return { pid: 0, reason: '读不到验收锁状态' };
  }
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const plan = buildPlan();
  const state = await readState();
  const decision = decideAwayState({ locked: state.locked, idleMs: state.idleMs, minIdleMs: MIN_IDLE_MS, abortIdleMs: ABORT_IDLE_MS });

  console.log('=== 用户离开时的维护计划 ===');
  console.log('锁屏=' + state.locked + ' 空闲=' + (state.idleMs >= 0 ? Math.round(state.idleMs / 1000) + 's' : '读不到')
    + ' 开始门槛=' + MIN_IDLE_SEC + 's 中止门槛=' + ABORT_IDLE_SEC + 's 轮询=' + Math.round(POLL_MS / 1000) + 's');
  plan.forEach((s, i) => console.log('  ' + (i + 1) + ') ' + s.name + '（' + s.script + (s.args ? ' ' + s.args.join(' ') : '') + (s.env ? '，' + JSON.stringify(s.env) : '') + '）'));
  if (!decision.go) console.log('现在不跑：' + decision.reason);
  const foreign = await foreignBusy();
  if (foreign) console.log('⚠ 另一个验收正在进行（pid ' + (foreign.pid || '?') + '）：本次不跑');
  if (dryRun) { console.log('（--dry-run：只打印，不执行）'); return; }
  if (foreign || !decision.go) {
    log('跳过本次维护：' + (foreign ? '另一个验收正在进行（pid ' + (foreign.pid || '?') + '）' : decision.reason));
    return;
  }

  const lock = acquireLock(AWAY_LOCK);
  if (!lock || lock.ok !== true) {
    log('跳过本次维护：另一个 away:maintain 正在跑（pid ' + ((lock && lock.pid) || '?') + '）');
    return;
  }

  const results = [];
  try {
    for (let i = 0; i < plan.length; i += 1) {
      const step = plan[i];
      const busy = await foreignBusy();
      if (busy) {
        log('停止后续步骤：另一个验收开始了（pid ' + (busy.pid || '?') + '）');
        results.push({ name: step.name, status: 'stopped', reason: '别的验收插入', ms: 0 });
        break;
      }
      const before = await readState();
      const gate = decideAwayState({ locked: before.locked, idleMs: before.idleMs, minIdleMs: MIN_IDLE_MS, abortIdleMs: ABORT_IDLE_MS });
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
      // 第 0 步（服务重启）跑完要确认真的都刷到当前代码了
      if (step.script === 'core/service.mjs') {
        const fresh = checkServicesFresh();
        if (!fresh.fresh) {
          log('服务没有全部刷新到当前代码：' + fresh.detail);
          results[results.length - 1] = Object.assign({}, result, { status: 'failed', reason: '服务仍落后：' + fresh.detail });
          break;
        }
      }
    }
    // 没收到的步骤如实标 skipped（复核 L7：别让日志看起来像全跑完了）
    const done = new Set(results.map((r) => r.name));
    for (const step of plan) if (!done.has(step.name)) results.push({ name: step.name, status: 'skipped', reason: '前面步骤未完成，本轮不跑', ms: 0 });
    const summary = summarizeSteps(results);
    log('汇总：' + summary.text);
    if (!summary.ok) process.exitCode = 1;
  } finally {
    releaseLock(AWAY_LOCK);
  }
}

if (isDirectRun(import.meta.url)) { // 入口守卫统一走 core/direct-run.mjs（符号链接路径也判 true）
  main().catch((error) => {
    console.error('FAIL:', error && error.message || error);
    process.exitCode = 1;
  });
}

export default { decideAwayState, buildPlan, summarizeSteps, runStep, parseEnvMs, safeLogFileName, checkServicesFresh, MIN_IDLE_SEC, ABORT_IDLE_SEC };
