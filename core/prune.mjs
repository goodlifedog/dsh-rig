'use strict';
/**
 * 清理：日志按时间、报告按数量轮转，避免长期跑堆到几千个文件。
 *
 * 原则：
 *   - 只动 logs/ 和 reports/ 里的文件，别的一概不碰
 *   - 日志默认留 7 天；报告默认留最近 200 个（按文件名里的时间戳排序，取不到再用 mtime）
 *   - 默认 dry-run，真正删除要显式 --apply
 */
import { reportTimestamp } from './report-index.mjs';

const DAY = 24 * 60 * 60 * 1000;

/**
 * 从日志文件名取时间（纯函数）：2026-11-07T16-25-26-514Z-background-control.jsonl
 * @returns {number} 毫秒时间戳，取不到 0
 */
export function logTimestamp(name) {
  return reportTimestamp(name);
}

/**
 * 挑出过期日志（纯函数）。
 * @param {Array<{name:string, mtimeMs:number}>} files
 * @param {{now?:number, days?:number}} [options]
 * @returns {string[]} 要删的文件名
 */
export function selectStaleLogs(files, options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const days = Number.isFinite(options.days) ? options.days : 7;
  const cutoff = now - days * DAY;
  const out = [];
  for (const f of files || []) {
    const ts = logTimestamp(f.name) || Number(f.mtimeMs) || 0;
    if (ts && ts < cutoff) out.push(f.name);
  }
  return out;
}

/**
 * 挑出超出数量上限的旧报告（纯函数），保留最新 keep 个。
 * @param {Array<{name:string, mtimeMs:number}>} files
 * @param {{keep?:number}} [options]
 * @returns {string[]}
 */
export function selectExcessReports(files, options = {}) {
  const keep = Number.isFinite(options.keep) ? options.keep : 200;
  const rows = (files || []).map((f) => ({ name: f.name, ts: reportTimestamp(f.name) || Number(f.mtimeMs) || 0 }));
  rows.sort((a, b) => a.ts - b.ts);
  if (rows.length <= keep) return [];
  return rows.slice(0, rows.length - keep).map((r) => r.name);
}

/** 只允许删这两个目录里的文件（纯函数，防写错路径） */
export function isPrunablePath(filePath, roots) {
  const target = String(filePath || '');
  return (roots || []).some((root) => root && target.startsWith(String(root) + '/'));
}
