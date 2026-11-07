'use strict';

/**
 * 小窗崩溃记录：只保留最近一条，字段截断，供 /health 暴露。
 *
 * 单独成模块是为了能单测：主进程的 render-process-gone / child-process-gone 在测试里
 * 很难稳定触发，但「记录了什么、怎么截断」是纯逻辑，值得钉住。
 */
function createCrashLog(options = {}) {
  const now = (options && options.now) || (() => new Date().toISOString());
  const maxDetail = Number.isFinite(options && options.maxDetail) ? options.maxDetail : 120;
  let last = null;
  return {
    /**
     * @param {string} kind render-process-gone / child-process-gone / uncaughtException ...
     * @param {*} detail 原因或堆栈
     * @returns {{kind:string, detail:string, at:string}}
     */
    note(kind, detail) {
      last = {
        kind: String(kind || 'unknown').slice(0, 40),
        detail: String(detail == null ? '' : detail).slice(0, maxDetail),
        at: now(),
      };
      return last;
    },
    /** @returns {{kind:string, detail:string, at:string}|null} */
    get() {
      return last;
    },
  };
}

/**
 * 渲染进程崩溃后要不要自动重载（纯函数）。
 *
 * 不能无脑重载：如果渲染进程一启动就崩（坏页面、显卡驱动问题），800ms 一次的重载
 * 会变成无限崩溃循环，白烧 CPU 还刷日志。策略：限定时间窗内最多重载 N 次，
 * 超了就停手并把原因写进 /health，交给人处理。
 *
 * @param {number[]} crashTimes 本会话最近崩溃时间戳（毫秒）
 * @param {number} now
 * @param {{windowMs?:number, maxReloads?:number}} [options]
 * @returns {{reload:boolean, crashesInWindow:number, reason:string}}
 */
function shouldReloadAfterCrash(crashTimes, now, options = {}) {
  const windowMs = Number(options.windowMs) || 60000;
  const maxReloads = Number(options.maxReloads) || 3;
  const at = Number(now) || Date.now();
  const recent = (Array.isArray(crashTimes) ? crashTimes : [])
    .map(Number)
    .filter((t) => Number.isFinite(t) && at - t <= windowMs);
  if (recent.length < maxReloads) {
    return { reload: true, crashesInWindow: recent.length, reason: '第 ' + recent.length + ' 次崩溃，重载窗口' };
  }
  return {
    reload: false,
    crashesInWindow: recent.length,
    reason: windowMs + 'ms 内崩了 ' + recent.length + ' 次，停止自动重载（避免崩溃循环）',
  };
}

module.exports = { createCrashLog, shouldReloadAfterCrash };
