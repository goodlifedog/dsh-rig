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

module.exports = { createCrashLog };
