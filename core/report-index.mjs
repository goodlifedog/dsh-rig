'use strict';
/**
 * 报告索引小工具：从文件名里取时间戳挑"最近一份"。
 *
 * 为什么单拎出来：status.mjs 原来对 reports/ 里所有 .md 做字典序排序取最后一个，
 * 结果挑中的是 app-matrix 之类别的报告（甚至可能是更早的），把当天那次失败掩盖掉。
 */
const ISO_LIKE = /(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})/;

/**
 * 从报告文件名取时间（纯函数）。取不到返回 0。
 * 支持 2026-11-07T16-20-42-131Z-acceptance.md 和 acceptance-2026-11-07T16-20-42-131Z.md 两种。
 * @param {string} name
 * @returns {number} 毫秒时间戳
 */
export function reportTimestamp(name) {
  const m = String(name || '').match(ISO_LIKE);
  if (!m) return 0;
  const iso = m[1] + 'T' + m[2] + ':' + m[3] + ':' + m[4] + 'Z';
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
}

/**
 * 在报告文件名里找最近的一份验收报告（纯函数）。
 * @param {string[]} files
 * @param {{prefix?:RegExp}} [options]
 * @returns {string} 文件名，没有返回空串
 */
export function latestReport(files, options = {}) {
  const prefix = (options && options.prefix) || /^acceptance-.*\.md$/i;
  const candidates = (files || []).filter((f) => prefix.test(String(f)));
  if (!candidates.length) return '';
  return candidates.sort((a, b) => reportTimestamp(a) - reportTimestamp(b)).pop();
}
