'use strict';
/**
 * 任务被中途杀掉时的应急清理。
 *
 * 场景：verify:live / 验收被中止（用户回来、Ctrl-C、超时）时，任务进程收到 SIGTERM 就直接死了，
 * 它 finally 里的「关掉自己拉起的应用」来不及跑——实测留下一只计算器。
 * 这里在任务侧注册信号处理：先把自己拉起的应用关掉，再退出。
 *
 * 原则：只关"本次任务自己拉起来的"（调用方通过 list() 提供），用户原本就开着的绝不动。
 */

/**
 * @param {{list:()=>Array<object|string>, quit:(app:any)=>Promise<any>, onExit?:(code:number)=>void, log?:(app:any, result:any)=>void}} deps
 * @returns {(signal?:string)=>Promise<void>}
 */
export function createEmergencyAppCleanup(deps = {}) {
  const list = typeof deps.list === 'function' ? deps.list : () => [];
  const quit = typeof deps.quit === 'function' ? deps.quit : async () => null;
  const quitSync = typeof deps.quitSync === 'function' ? deps.quitSync : null;
  const onExit = typeof deps.onExit === 'function' ? deps.onExit : (code) => process.exit(code);
  const log = typeof deps.log === 'function' ? deps.log : () => {};
  let done = false;
  const appsNow = () => { try { return list() || []; } catch { return []; } };

  /** 异步清理：没有 quitSync 时用（可能被同进程其它退出钩子抢先退出） */
  const cleanupAsync = async (signal = 'SIGTERM') => {
    if (done) return;
    done = true;
    for (const app of appsNow()) {
      try { log(app, await quit(app)); } catch (error) { log(app, { error: String((error && error.message) || error) }); }
    }
    onExit(signal === 'SIGINT' ? 130 : 143);
  };

  /**
   * 同步清理：信号处理里首选。阻塞到应用真的退出（或超时）再退出进程，
   * 这样不会被 ocu-mcp 等模块的立即 process.exit 抢先。
   */
  const cleanupSync = (signal = 'SIGTERM') => {
    if (done) return;
    done = true;
    for (const app of appsNow()) {
      try { log(app, quitSync(app)); } catch (error) { log(app, { error: String((error && error.message) || error) }); }
    }
    onExit(signal === 'SIGINT' ? 130 : 143);
  };

  const cleanup = typeof deps.quitSync === 'function' ? (signal) => { cleanupSync(signal); return Promise.resolve(); } : cleanupAsync;
  cleanup.cleanupSync = cleanupSync;
  return cleanup;
}

/**
 * 给任务装信号处理（SIGTERM / SIGINT）：先清自己拉起的应用再退出。
 * @param {{list:Function, quit:Function, onExit?:Function}} deps
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
