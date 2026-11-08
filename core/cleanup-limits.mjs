'use strict';
/**
 * 「按条数删顶部 N 条」的硬上限判定（纯函数，评审 L4）。
 *
 * 背景：scripts/cleanup-test-data.mjs 在 --force-all 下，Notes 列表标题读不到时
 * 会退回 deleteTopNotes(count)，而 count 是「当前笔记总数」——一次就能删光整个文件夹。
 * 误删面随 N 线性放大，所以必须有硬上限：默认最多 5 条，超过就拒绝执行，
 * 只有显式设置 CLEANUP_ALLOW_LARGE=1 才允许，并且调用方要把条数与原因写进报告。
 *
 * 本模块不接触系统（不跑 osascript / 不删任何东西），只做纯判定，便于单测。
 */

const DEFAULT_CLEANUP_MAX_TOP = 5;

/**
 * 解析上限配置：CLEANUP_MAX_TOP。非法值（NaN / 负数）回退到默认 5。
 * @param {string|number|undefined} raw
 * @param {number} [fallback]
 * @returns {number}
 */
function resolveMaxTop(raw, fallback = DEFAULT_CLEANUP_MAX_TOP) {
  const n = Number(raw);
  const base = Number.isFinite(Number(fallback)) && Number(fallback) >= 0
    ? Math.floor(Number(fallback))
    : DEFAULT_CLEANUP_MAX_TOP;
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : base;
}

/**
 * 判定「按条数删顶部 N 条」这次能不能执行、实际删几条。
 *
 * @param {{requested?:number, noteTotal?:number, maxTop?:number, allowLarge?:boolean}} input
 *   requested   调用方想删的条数（清理脚本里是「当前笔记总数」）
 *   noteTotal   当前笔记总数（只用于报告）
 *   maxTop      硬上限，默认 5
 *   allowLarge  显式 CLEANUP_ALLOW_LARGE=1 时为 true
 * @returns {{allowed:boolean, count:number, requested:number, noteTotal:number, limit:number, reason:string}}
 */
function resolveTopDelete(input = {}) {
  const requestedRaw = Number(input && input.requested);
  const requested = Number.isFinite(requestedRaw) && requestedRaw > 0 ? Math.floor(requestedRaw) : 0;
  const noteTotalRaw = Number(input && input.noteTotal);
  const noteTotal = Number.isFinite(noteTotalRaw) && noteTotalRaw > 0 ? Math.floor(noteTotalRaw) : 0;
  const limit = resolveMaxTop(input && input.maxTop);
  const allowLarge = Boolean(input && input.allowLarge) === true && (input && input.allowLarge) === true;

  if (!requested) {
    return { allowed: false, count: 0, requested: requested, noteTotal: noteTotal, limit: limit, reason: '没有需要按条数删除的笔记（N=0）' };
  }
  if (requested <= limit) {
    return {
      allowed: true,
      count: requested,
      requested: requested,
      noteTotal: noteTotal,
      limit: limit,
      reason: '按条数删顶部 ' + requested + ' 条，未超过上限 ' + limit,
    };
  }
  if (allowLarge) {
    return {
      allowed: true,
      count: requested,
      requested: requested,
      noteTotal: noteTotal,
      limit: limit,
      reason: '显式 CLEANUP_ALLOW_LARGE=1，允许超过上限删除 ' + requested + ' 条（上限 ' + limit + '，当前笔记总数 ' + noteTotal + '）',
    };
  }
  return {
    allowed: false,
    count: 0,
    requested: requested,
    noteTotal: noteTotal,
    limit: limit,
    reason: '按条数删 ' + requested + ' 条超过硬上限 ' + limit + '，已拒绝执行（确需执行请显式设置 CLEANUP_ALLOW_LARGE=1）',
  };
}

export { DEFAULT_CLEANUP_MAX_TOP, resolveMaxTop, resolveTopDelete };
