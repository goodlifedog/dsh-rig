'use strict';
/**
 * 任务被中途杀掉时的应急清理。
 *
 * 场景：verify:live / 验收被中止（用户回来、Ctrl-C、超时）时，任务进程收到 SIGTERM 就直接死了，
 * 它 finally 里的「关掉自己拉起的应用」来不及跑——实测留下一只计算器。
 * 这里在任务侧注册信号处理：先把自己拉起的应用关掉，再退出。
 *
 * 原则：只关"本次任务自己拉起来的"（调用方通过 list() 提供），用户原本就开着的绝不动。
 *
 * 清理预算（M-2）：外层 SIGKILL 宽限有限（6 秒），应用多时不能每个都按单应用上限等。
 * createEmergencyAppCleanup 支持总预算 budgetMs（默认 2500ms）：把同一个 deadline 传给
 * quit/quitSync，每个应用只拿剩余预算；预算耗尽后不再尝试后续应用，直接记一条
 * { quit:false, mode:'budget-exhausted' } 然后退出，保证进程在宽限内完成收尾。
 */

const DEFAULT_BUDGET_MS = 2500;

function pickNow(deps) {
  return typeof deps.now === 'function' ? deps.now : () => Date.now();
}

function pickBudget(deps) {
  if (deps.budgetMs === Infinity) return Infinity;
  if (Number.isFinite(deps.budgetMs) && deps.budgetMs >= 0) return deps.budgetMs;
  return DEFAULT_BUDGET_MS;
}

/**
 * @param {{list:()=>Array<object|string>, quit?:(app:any, opts?:object)=>Promise<any>, quitSync?:(app:any, opts?:object)=>any, onExit?:(code:number)=>void, log?:(app:any, result:any)=>void, budgetMs?:number, now?:()=>number}} deps
 *   budgetMs: 本次应急清理的总预算（默认 2500ms；Infinity 表示不限制，仅测试/兼容用）
 *   now:      可注入的时钟（测试用），默认 Date.now
 * @returns {(signal?:string)=>Promise<void>} 清理函数；带 cleanupSync(signal) 同步版本
 */
export function createEmergencyAppCleanup(deps = {}) {
  const list = typeof deps.list === 'function' ? deps.list : () => [];
  const quit = typeof deps.quit === 'function' ? deps.quit : async () => null;
  const quitSync = typeof deps.quitSync === 'function' ? deps.quitSync : null;
  const onExit = typeof deps.onExit === 'function' ? deps.onExit : (code) => process.exit(code);
  const log = typeof deps.log === 'function' ? deps.log : () => {};
  const now = pickNow(deps);
  const budgetMs = pickBudget(deps);
  let done = false;
  const appsNow = () => { try { return list() || []; } catch { return []; } };

  // 一次清理共用一个 deadline：所有应用共享同一份总预算
  const makeDeadline = () => (Number.isFinite(budgetMs) ? now() + budgetMs : Infinity);
  const remainingMs = (deadlineAt) => (Number.isFinite(deadlineAt) ? Math.max(0, deadlineAt - now()) : Infinity);

  /** 异步清理：没有 quitSync 时用（可能被同进程其它退出钩子抢先退出） */
  const cleanupAsync = async (signal = 'SIGTERM') => {
    if (done) return;
    done = true;
    const deadlineAt = makeDeadline();
    for (const app of appsNow()) {
      const left = remainingMs(deadlineAt);
      if (left <= 0) {
        log(app, { quit: false, mode: 'budget-exhausted', remainingMs: 0 });
        continue;
      }
      try { log(app, await quit(app, { deadlineAt, budgetMs: left })); }
      catch (error) { log(app, { error: String((error && error.message) || error) }); }
    }
    onExit(signal === 'SIGINT' ? 130 : 143);
  };

  /**
   * 同步清理：信号处理里首选。阻塞到应用真的退出（或预算用完）再退出进程，
   * 这样不会被 ocu-mcp 等模块的立即 process.exit 抢先。
   */
  const cleanupSync = (signal = 'SIGTERM') => {
    if (done) return;
    done = true;
    const deadlineAt = makeDeadline();
    for (const app of appsNow()) {
      const left = remainingMs(deadlineAt);
      if (left <= 0) {
        log(app, { quit: false, mode: 'budget-exhausted', remainingMs: 0 });
        continue;
      }
      try { log(app, quitSync(app, { deadlineAt, budgetMs: left })); }
      catch (error) { log(app, { error: String((error && error.message) || error) }); }
    }
    onExit(signal === 'SIGINT' ? 130 : 143);
  };

  const cleanup = typeof deps.quitSync === 'function' ? (signal) => { cleanupSync(signal); return Promise.resolve(); } : cleanupAsync;
  cleanup.cleanupSync = cleanupSync;
  cleanup.budgetMs = budgetMs;
  return cleanup;
}

/**
 * 给任务装信号处理（SIGTERM / SIGINT）：先清自己拉起的应用再退出。
 * @param {{list:Function, quit:Function, quitSync?:Function, onExit?:Function, budgetMs?:number}} deps
 * @returns {Function} 清理函数（测试可直接调）
 */
export function installEmergencyAppCleanup(deps = {}) {
  const cleanup = createEmergencyAppCleanup(deps);
  const sync = typeof deps.quitSync === 'function';
  const onSignal = (signal) => () => {
    // quitSync 路径是同步的：保证在其它模块的退出钩子之前把应用关掉
    if (sync) cleanup.cleanupSync(signal);
    else void cleanup(signal);
  };
  process.on('SIGTERM', onSignal('SIGTERM'));
  process.on('SIGINT', onSignal('SIGINT'));
  return cleanup;
}
