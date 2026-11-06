'use strict';

/**
 * 会话标题门控（纯函数，便于单测）。
 * 规则：没有 titleHint 的会话不受门控；读不到 DSH 标题时也不门控（避免误藏）。
 */

// DSH 窗口标题形如「规划布局探讨 — DeepSeek Harness」，匹配前先去掉后缀
function normalizeDshTitle(raw) {
  return String(raw || '').trim().replace(/\s*[—–-]\s*DeepSeek Harness\s*$/i, '').trim();
}

function matchesTitle(titleHint, dshTitle) {
  if (!titleHint) return true;
  if (!dshTitle) return true;
  return normalizeDshTitle(dshTitle).indexOf(titleHint) !== -1;
}

module.exports = { normalizeDshTitle, matchesTitle };
