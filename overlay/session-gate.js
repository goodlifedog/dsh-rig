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
  // 两边都要归一：调用方直接把完整窗口标题（带「— DeepSeek Harness」后缀）当 hint 传进来时，
  // 只归一宿主一侧会导致永远匹配不上，小窗就再也不出现。
  const host = normalizeHostTitle(hostTitle, suffix);
  const hint = normalizeHostTitle(titleHint, suffix);
  if (!hint) return true;
  if (host === hint) return true;
  // 不能用裸子串：会话「规划布局探讨」会匹配到「规划布局探讨（二）」，两个会话互相点亮小窗。
  // 但宿主标题可能带装饰（状态点、未读标记），所以允许「去掉 hint 后只剩标点/符号/空白」。
  const at = host.indexOf(hint);
  if (at < 0) return false;
  const rest = host.slice(0, at) + host.slice(at + hint.length);
  return /^[\s\p{P}\p{S}]*$/u.test(rest);
}

/**
 * 窗口刚创建（ready-to-show）时该不该显示（纯函数）。
 *
 * 这是个真实 bug 的修复：以前 ready-to-show 里无条件 showInactive()，
 * 任何请求新建一个会话窗口的瞬间，小窗都会无视「宿主是否在前台/是否在别的 Space/标题是否匹配」
 * 闪出来一下——用户正在别的应用/别的桌面干活时会看到它冒出来。
 *
 * @param {{hostVisible?:boolean, front?:string, hostBundles?:string[], self?:string,
 *          titleMatched?:boolean, hasActivity?:boolean}} [input]
 * @returns {boolean}
 */
function shouldShowOnReady(input = {}) {
  const {
    hostVisible = true,
    front = '',
    hostBundles = [],
    self = 'com.github.Electron',
    titleMatched = true,
    hasActivity = true,
  } = input || {};
  if (!hostVisible) return false;
  if (!hasActivity) return false;
  if (!titleMatched) return false;
  const frontOk = !front || (hostBundles || []).includes(front) || front === self;
  return frontOk;
}

module.exports = { normalizeHostTitle, normalizeDshTitle, matchesTitle, shouldShowOnReady, DEFAULT_SUFFIX };
