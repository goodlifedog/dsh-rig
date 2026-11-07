'use strict';
/**
 * 清理策略的纯逻辑：给定文件列表与保留规则，算出该删哪些、该留哪些。
 *
 * 入口在 `scripts/prune.mjs`（读环境变量、遍历目录、执行删除）；
 * 这里只负责判定，便于单测（test/prune.test.mjs 直接测它）。
 */

const DAY = 24 * 60 * 60 * 1000;

/**
 * @param {{files?: Array<{path:string, mtimeMs:number, size?:number}>, now?: number, keepDays?: number, keepReports?: number}} [input]
 * @returns {{remove: Array<object>, keep: Array<object>, bytes: number}}
 */
export function planPrune({ files, now = Date.now(), keepDays = 7, keepReports = 200 } = {}) {
  const list = Array.isArray(files) ? files.slice() : [];
  const cutoff = now - keepDays * DAY;
  const sorted = list.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const keepSet = new Set();
  sorted.slice(0, keepReports).forEach((f) => keepSet.add(f.path));
  const remove = sorted.filter((f) => !keepSet.has(f.path) || f.mtimeMs < cutoff);
  const keep = sorted.filter((f) => !remove.includes(f));
  return { remove, keep, bytes: remove.reduce((n, f) => n + (f.size || 0), 0) };
}
