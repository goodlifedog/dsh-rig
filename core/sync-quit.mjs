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

const DEFAULT_APP_TIMEOUT_MS = 6000; // 单应用 AppleScript exec 超时上限（内部 with timeout 4 秒）
const DEFAULT_WAIT_MS = 2000;        // 发完 quit 后最多再等 2 秒看它有没有退出
const MIN_ATTEMPT_MS = 500;          // 剩余预算低于这个值就不再启动一次 AppleScript

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

function stillRunning(app, deadlineAt) {
  const processName = String((app && (app.processName || app.process)) || '').trim();
  if (!processName) return false;
  const remainingMs = remainingBudgetMs(deadlineAt);
  const timeout = Number.isFinite(remainingMs) ? Math.max(200, Math.min(1500, remainingMs)) : 1500;
  try {
    execFileSync('/usr/bin/pgrep', ['-x', processName], { timeout, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** 在 deadline 内 sleep，避免用完预算还多睡一轮。 */
function sleepWithin(ms, deadlineAt) {
  const remainingMs = remainingBudgetMs(deadlineAt);
  const sleepMs = Number.isFinite(remainingMs) ? Math.min(ms, remainingMs) : ms;
  if (sleepMs <= 0) return;
  try { execFileSync('/bin/sleep', [(sleepMs / 1000).toFixed(2)]); } catch {}
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

  const startedAt = Date.now();
  const deadlineAt = resolveDeadline(opts, startedAt);
  const gate = canAttemptQuit(deadlineAt, startedAt);
  // 预算已经不够启动一次清理：不要浪费一次 AppleScript，直接如实返回
  if (!gate.attempt) {
    return { quit: false, mode: 'budget-exhausted', remainingMs: gate.remainingMs };
  }

  const requestedTimeout = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : DEFAULT_APP_TIMEOUT_MS;
  const execTimeoutMs = Math.max(500, Math.min(requestedTimeout, gate.remainingMs));
  // AppleScript 内部超时同样压进剩余预算（整数秒，最多 4 秒，至少 1 秒）
  const scriptSeconds = Math.max(1, Math.min(4, Math.floor(execTimeoutMs / 1000)));
  const target = app.bundleId ? 'id ' + JSON.stringify(app.bundleId) : JSON.stringify(String(app.appName || ''));
  try {
    execFileSync('/usr/bin/osascript', ['-e',
      'with timeout of ' + scriptSeconds + ' seconds\ntell application ' + target + ' to quit\nend timeout'],
      { timeout: execTimeoutMs, stdio: 'ignore' });
  } catch {}

  const requestedWait = Number.isFinite(opts.waitMs) ? opts.waitMs : DEFAULT_WAIT_MS;
  const waitBudget = Math.max(0, Math.min(requestedWait, remainingBudgetMs(deadlineAt)));
  const waitDeadline = Date.now() + waitBudget;
  while (Date.now() < waitDeadline) {
    if (!stillRunning(app, deadlineAt)) return { quit: true, mode: 'quit' };
    sleepWithin(200, deadlineAt);
  }
  if (!stillRunning(app, deadlineAt)) return { quit: true, mode: 'quit' };

  const remainingMs = remainingBudgetMs(deadlineAt);
  if (Number.isFinite(deadlineAt) && remainingMs <= 0) {
    return { quit: false, mode: 'budget-exhausted', remainingMs: 0 };
  }
  return { quit: !stillRunning(app, deadlineAt), mode: 'quit-timeout', remainingMs };
}
