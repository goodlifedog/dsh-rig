'use strict';
/**
 * 同步版「关掉应用」（只用于信号处理里的应急清理）。
 *
 * 为什么必须同步：进程收到 SIGTERM 时，同进程里可能还有别的监听器（ocu-mcp 的退出钩子）
 * 会立刻 process.exit——异步的 quitApp 还没等到 osascript 回来就被退出，应用就留下来了。
 * 信号处理里做阻塞调用（execFileSync）+ 短暂轮询，才能在别人退出前把应用关掉。
 *
 * 安全边界：只发 AppleScript quit（优雅退出），退不掉就如实返回失败，绝不强杀
 * （强杀可能丢用户没保存的内容）。
 *
 * 清理预算（M-2）：外层信号宽限只有几秒（verify:live / runner 都是 6 秒），
 * 多应用串行关闭很容易被外层 SIGKILL 截断。所以 quitAppSync 支持共享 deadline/budget：
 *   - 调用方可传 deadlineAt（绝对时间戳）或 budgetMs（本次可用毫秒）；
 *   - 每个应用按剩余预算扣减，剩余 < MIN_ATTEMPT_MS 时不启动 AppleScript，
 *     直接返回 { quit:false, mode:'budget-exhausted' }，把最后时间留给进程正常退出；
 *   - 单应用最坏耗时（不传 deadline 的旧行为）：AppleScript 最多 4 秒 + 轮询等待最多 2 秒 = 6 秒。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { helperPath as defaultHelperPath, parseAeStatus } from './applescript-driver.mjs';
import { executableTrust } from './safety.mjs';

const DEFAULT_APP_TIMEOUT_MS = 6000; // 单应用 AppleScript exec 超时上限（内部 with timeout 4 秒）
const DEFAULT_WAIT_MS = 2000;        // 发完 quit 后最多再等 2 秒看它有没有退出
const MIN_ATTEMPT_MS = 500;          // 剩余预算低于这个值就不再启动一次 AppleScript
export const PREFLIGHT_TIMEOUT_MS = 300; // 自动化授权预检的硬上限：退出路径上绝不为它多等

/**
 * 自动化授权状态 → 退出前是否允许发 AppleEvent（纯函数）。
 *
 * 和 note-cleanup 的语义不同点只有一处：这里是**退出路径**，超时/未知不能把退出卡住，
 * 所以 denied/needs-consent 明确未授权才拒绝；unknown/timeout 放行但带回 warning。
 * @param {string} status
 * @returns {{allow:boolean, blocked:boolean, uncertain:boolean, status:string, reason:string, warning:string}}
 */
export function decideAutomationGate(status) {
  const s = String(status == null ? '' : status).trim() || 'unknown';
  if (s === 'granted') return { allow: true, blocked: false, uncertain: false, status: s, reason: '', warning: '' };
  if (s === 'denied' || s === 'needs-consent') {
    const reason = '未授权自动化（' + s + '），不发送 Apple Event 以免弹授权框';
    return { allow: false, blocked: true, uncertain: false, status: s, reason, warning: reason };
  }
  const warning = '自动化授权预检拿不到结论（' + s + '，≤' + PREFLIGHT_TIMEOUT_MS + 'ms），按原逻辑继续（不阻塞退出）';
  return { allow: true, blocked: false, uncertain: true, status: s, reason: '', warning };
}

function makeDeps(options) {
  const d = (options && options.deps) || {};
  return {
    execFileSync: typeof d.execFileSync === 'function' ? d.execFileSync : execFileSync,
    statSync: typeof d.statSync === 'function' ? d.statSync : fs.statSync,
    helperPath: typeof d.helperPath === 'function' ? d.helperPath : defaultHelperPath,
    now: typeof d.now === 'function' ? d.now : Date.now,
  };
}

/**
 * 同步版自动化授权预检（不弹框、最多等 timeoutMs）。
 *
 * 为什么不用 checkAutomationPermission：它是 async 的，信号处理里不能 await。
 * 这里直接复用 applescript-driver 已经编译好的权限查询小程序（AEDeterminePermissionToAutomateTarget
 * + askUserIfNeeded=false），只做一次 execFileSync。
 *
 * 安全：不执行「不是本用户所有 / 可被他人写」的文件（与 ensureHelper 同一套 executableTrust 校验）。
 *
 * @param {string} bundleId 目标应用的 bundle id
 * @param {{timeoutMs?:number, deps?:object}} [options]
 * @returns {{status:string, code:number|null, timedOut?:boolean, error?:string}}
 */
export function checkAutomationPermissionSync(bundleId, options = {}) {
  const opts = options || {};
  const deps = makeDeps(opts);
  const bundle = String(bundleId || '').trim();
  if (!bundle) return { status: 'unknown', code: null, error: '缺少 bundle id' };
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? Math.max(0, opts.timeoutMs) : PREFLIGHT_TIMEOUT_MS;

  let helper = '';
  try {
    helper = deps.helperPath();
    const info = deps.statSync(helper);
    const uid = typeof process.getuid === 'function' ? process.getuid() : -1;
    const trust = executableTrust({ fileUid: info.uid, uid, mode: info.mode, exists: true });
    if (trust !== 'ok') return { status: 'unknown', code: null, error: '权限查询程序不可信（' + trust + '）' };
  } catch (error) {
    return { status: 'unknown', code: null, error: '权限查询程序不可用：' + String((error && error.message) || error).slice(0, 80) };
  }

  try {
    const stdout = deps.execFileSync(helper, [bundle], {
      timeout: timeoutMs,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
    });
    const code = Number.parseInt(String(stdout || '').trim(), 10);
    if (!Number.isFinite(code)) return { status: 'unknown', code: null, error: '返回不可解析' };
    return { status: parseAeStatus(code), code };
  } catch (error) {
    const e = error || {};
    const timedOut = e.signal === 'SIGTERM' || e.code === 'ETIMEDOUT' || e.killed === true || /timed? ?out/i.test(String(e.message || ''));
    if (timedOut) return { status: 'timeout', code: null, timedOut: true };
    return { status: 'unknown', code: null, error: String((e.message || e) || 'error').slice(0, 80) };
  }
}

/** 剩余预算（毫秒）；没有 deadline 时返回 Infinity。 */
export function remainingBudgetMs(deadlineAt, now = Date.now()) {
  if (!Number.isFinite(deadlineAt)) return Infinity;
  return Math.max(0, Math.round(deadlineAt - now));
}

/**
 * 纯函数：当前是否还值得启动一次 AppleScript。
 * @param {number} deadlineAt 绝对时间戳；非有限值表示不设预算上限
 * @param {number} [now]
 * @param {number} [minimumMs] 至少要有多少剩余预算才尝试
 * @returns {{attempt:boolean, remainingMs:number}}
 */
export function canAttemptQuit(deadlineAt, now = Date.now(), minimumMs = MIN_ATTEMPT_MS) {
  const remainingMs = remainingBudgetMs(deadlineAt, now);
  return { attempt: remainingMs >= minimumMs, remainingMs };
}

function resolveDeadline(options, now) {
  if (Number.isFinite(options.deadlineAt)) return options.deadlineAt;
  if (Number.isFinite(options.budgetMs)) return now + Math.max(0, options.budgetMs);
  return Infinity;
}

function stillRunning(app, deadlineAt, deps) {
  const processName = String((app && (app.processName || app.process)) || '').trim();
  if (!processName) return false;
  const remainingMs = remainingBudgetMs(deadlineAt, deps.now());
  const timeout = Number.isFinite(remainingMs) ? Math.max(200, Math.min(1500, remainingMs)) : 1500;
  try {
    deps.execFileSync('/usr/bin/pgrep', ['-x', processName], { timeout, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** 在 deadline 内 sleep，避免用完预算还多睡一轮。 */
function sleepWithin(ms, deadlineAt, deps) {
  const remainingMs = remainingBudgetMs(deadlineAt, deps.now());
  const sleepMs = Number.isFinite(remainingMs) ? Math.min(ms, remainingMs) : ms;
  if (sleepMs <= 0) return;
  try { deps.execFileSync('/bin/sleep', [(sleepMs / 1000).toFixed(2)]); } catch {}
}

/**
 * @param {{appName?:string, bundleId?:string, processName?:string}} app
 * @param {{timeoutMs?:number, waitMs?:number, deadlineAt?:number, budgetMs?:number}} [options]
 *   deadlineAt: 共享总 deadline（绝对时间戳），多应用清理时由调用方统一传入
 *   budgetMs:   本次可用预算（没有 deadlineAt 时用它换算 deadline）
 * @returns {{quit:boolean, mode:string, remainingMs?:number}}
 *   mode: quit | quit-timeout | budget-exhausted | no-app
 */
export function quitAppSync(app, options = {}) {
  const opts = options || {};
  if (!app) return { quit: true, mode: 'no-app' };

  const deps = makeDeps(opts);
  const startedAt = deps.now();
  const deadlineAt = resolveDeadline(opts, startedAt);
  const gate = canAttemptQuit(deadlineAt, startedAt);
  // 预算已经不够启动一次清理：不要浪费一次 AppleScript，直接如实返回
  if (!gate.attempt) {
    return { quit: false, mode: 'budget-exhausted', remainingMs: gate.remainingMs };
  }

  // ---------- 自动化授权预检（H2） ----------
  // 发 AppleEvent 之前先静默查授权（askUserIfNeeded=false，不会弹框）。
  // 关键约束：这是退出路径，预检最多等 PREFLIGHT_TIMEOUT_MS(300ms)，拿不到结论就按原逻辑继续（不阻塞退出）。
  let permission = 'granted';
  let warning = '';
  if (opts.skipAutomationPreflight === true) {
    permission = 'skipped';
  } else {
    const preflightBudgetMs = Math.max(0, Math.min(PREFLIGHT_TIMEOUT_MS, gate.remainingMs));
    const probe = preflightBudgetMs <= 0
      ? { status: 'timeout' }
      : checkAutomationPermissionSync(app.bundleId, { timeoutMs: preflightBudgetMs, deps });
    const verdict = decideAutomationGate(probe.status);
    permission = probe.status;
    if (verdict.blocked) {
      // 明确未授权：不发 AppleEvent（发了只会弹框/失败），如实返回，交给上层按环境跳过
      return { quit: false, mode: 'automation-denied', permission, warning: verdict.warning, remainingMs: remainingBudgetMs(deadlineAt, deps.now()) };
    }
    warning = verdict.warning;
    // 预检也吃预算：预检后不够一次 AppleScript 就不再尝试
    const afterPreflight = canAttemptQuit(deadlineAt, deps.now());
    if (!afterPreflight.attempt) {
      return { quit: false, mode: 'budget-exhausted', remainingMs: afterPreflight.remainingMs, permission, warning };
    }
  }

  const requestedTimeout = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : DEFAULT_APP_TIMEOUT_MS;
  const execTimeoutMs = Math.max(500, Math.min(requestedTimeout, remainingBudgetMs(deadlineAt, deps.now())));
  // AppleScript 内部超时同样压进剩余预算（整数秒，最多 4 秒，至少 1 秒）
  const scriptSeconds = Math.max(1, Math.min(4, Math.floor(execTimeoutMs / 1000)));
  const target = app.bundleId ? 'id ' + JSON.stringify(app.bundleId) : JSON.stringify(String(app.appName || ''));
  const meta = warning ? { permission, warning } : { permission };
  try {
    deps.execFileSync('/usr/bin/osascript', ['-e',
      'with timeout of ' + scriptSeconds + ' seconds\ntell application ' + target + ' to quit\nend timeout'],
      { timeout: execTimeoutMs, stdio: 'ignore' });
  } catch {}

  const requestedWait = Number.isFinite(opts.waitMs) ? opts.waitMs : DEFAULT_WAIT_MS;
  const waitBudget = Math.max(0, Math.min(requestedWait, remainingBudgetMs(deadlineAt, deps.now())));
  const waitDeadline = deps.now() + waitBudget;
  while (deps.now() < waitDeadline) {
    if (!stillRunning(app, deadlineAt, deps)) return { quit: true, mode: 'quit', ...meta };
    sleepWithin(200, deadlineAt, deps);
  }
  if (!stillRunning(app, deadlineAt, deps)) return { quit: true, mode: 'quit', ...meta };

  const remainingMs = remainingBudgetMs(deadlineAt, deps.now());
  if (Number.isFinite(deadlineAt) && remainingMs <= 0) {
    return { quit: false, mode: 'budget-exhausted', remainingMs: 0, ...meta };
  }
  return { quit: !stillRunning(app, deadlineAt, deps), mode: 'quit-timeout', remainingMs, ...meta };
}
