'use strict';
/**
 * 清理策略的纯逻辑：给定文件列表与保留规则，算出该删哪些、该留哪些。
 *
 * 入口在 `scripts/prune.mjs`（读环境变量、遍历目录、执行删除）；
 * 这里只负责判定，便于单测（test/prune.test.mjs 直接测它）。
 */

const DAY = 24 * 60 * 60 * 1000;

/**
 * 验收证据报告：这些文件是「某个应用测过什么」的唯一来源，被数量上限删掉，
 * 清点就会把「限制」退回「未测」（实测 OpenCode 就这样丢过证据）。
 * 所以它们只按时间老化（默认 90 天），不受 KEEP_REPORTS 数量上限影响。
 */
export const EVIDENCE_REPORT_RE = /^(app-matrix|cdp-driver|applescript-channel)-/;

/**
 * @param {{
 *   files?: Array<{path:string, name?:string, mtimeMs:number, size?:number}>,
 *   now?: number, keepDays?: number, keepReports?: number,
 *   evidencePattern?: RegExp|null, keepEvidenceDays?: number,
 * }} [input]
 * @returns {{remove: Array<object>, keep: Array<object>, bytes: number}}
 */
export function planPrune({
  files,
  now = Date.now(),
  keepDays = 7,
  keepReports = 200,
  evidencePattern = EVIDENCE_REPORT_RE,
  keepEvidenceDays = 90,
} = {}) {
  const list = Array.isArray(files) ? files.slice() : [];
  const nameOf = (f) => String(f.name || f.path || '').split('/').pop();
  const isEvidence = (f) => Boolean(evidencePattern) && evidencePattern.test(nameOf(f));
  const sorted = list.sort((a, b) => b.mtimeMs - a.mtimeMs);

  // 普通报告：最新 keepReports 个 + 不超过 keepDays
  const cutoff = now - keepDays * DAY;
  const normal = sorted.filter((f) => !isEvidence(f));
  const keepSet = new Set();
  normal.slice(0, keepReports).forEach((f) => keepSet.add(f.path));
  const normalKeep = normal.filter((f) => keepSet.has(f.path) && f.mtimeMs >= cutoff);

  // 验收证据：只按证据保留天数老化，不被数量上限挤掉
  const evidenceCutoff = now - keepEvidenceDays * DAY;
  const evidenceKeep = sorted.filter((f) => isEvidence(f) && f.mtimeMs >= evidenceCutoff);

  const keep = [...normalKeep, ...evidenceKeep].sort((a, b) => b.mtimeMs - a.mtimeMs);
  const keepPaths = new Set(keep.map((f) => f.path));
  const remove = sorted.filter((f) => !keepPaths.has(f.path));
  return { remove, keep, bytes: remove.reduce((n, f) => n + (f.size || 0), 0) };
}
