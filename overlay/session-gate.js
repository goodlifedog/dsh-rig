'use strict';

/**
 * 会话标题门控（纯函数，便于单测）。
 * 宿主应用可以是任意程序：标题后缀可由调用方传入（默认 DeepSeek Harness）。
 */

const DEFAULT_SUFFIX = 'DeepSeek Harness';

function normalizeHostTitle(raw, suffix) {
  const s = String(raw || '').trim();
  const tail = String(suffix || DEFAULT_SUFFIX).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return s.replace(new RegExp('\\s*[—–-]\\s*' + tail + '\\s*$', 'i'), '').trim();
}

// 兼容旧名
const normalizeDshTitle = normalizeHostTitle;

function matchesTitle(titleHint, hostTitle, suffix) {
  if (!titleHint) return true;
  if (!hostTitle) return true;
  return normalizeHostTitle(hostTitle, suffix).indexOf(titleHint) !== -1;
}

module.exports = { normalizeHostTitle, normalizeDshTitle, matchesTitle, DEFAULT_SUFFIX };
