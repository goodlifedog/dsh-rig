'use strict';

/**
 * 会话标题门控（纯函数，便于单测）。
 * 宿主应用可以是任意程序：标题后缀可由调用方传入（默认 DeepSeek Harness）。
 */

const DEFAULT_SUFFIX = 'DeepSeek Harness';
// 宿主快照超过这个年龄就认为不可信：attach 轮询正常 0.4–1.5s，超过 5s 说明读失败/卡住
const DEFAULT_MAX_HOST_AGE_MS = 5000;

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
 * 宿主快照是否新鲜可信（fail-closed）。
 * 必须同时满足：宿主可见、bounds 不是 stale、快照年龄在 maxHostAgeMs 内。
 *
 * @param {{hostVisible?:boolean, hostStale?:boolean, hostCheckedAt?:number,
 *          now?:number, maxHostAgeMs?:number}} [input]
 * @returns {boolean}
 */
function isHostSnapshotFresh(input = {}) {
  const {
    hostVisible = false,
    hostStale = false,
    hostCheckedAt,
    now = Date.now(),
    maxHostAgeMs = DEFAULT_MAX_HOST_AGE_MS,
  } = input || {};

  if (hostVisible !== true) return false;
  if (hostStale === true) return false;

  // 没传 hostCheckedAt 时按「刚拿到」处理，方便纯函数单测；主进程会显式传真实时间戳。
  const checkedAt = hostCheckedAt === undefined ? Number(now) : Number(hostCheckedAt);
  if (!Number.isFinite(checkedAt) || checkedAt <= 0) return false;

  const current = Number(now);
  if (!Number.isFinite(current)) return false;
  const age = current - checkedAt;
  if (!Number.isFinite(age) || age < 0) return false;

  const maxAge = Number(maxHostAgeMs);
  if (!Number.isFinite(maxAge) || maxAge <= 0) return false;
  return age <= maxAge;
}

/**
 * 前台 bundle 是否可信：未知/空一律不可信（fail-closed）。
 *
 * @param {string} front 前台应用 bundle id
 * @param {string[]} hostBundles 允许的宿主 bundle 列表
 * @param {string} [self] overlay 自身 bundle id
 * @returns {boolean}
 */
function isFrontTrusted(front, hostBundles, self = 'com.github.Electron') {
  if (typeof front !== 'string') return false;
  const value = front.trim();
  if (!value) return false;
  if (value === self) return true;
  return (hostBundles || []).includes(value);
}

/**
 * 现在这一刻能不能把窗口显示出来（活动驱动的统一门控，task-27 R1/R2）。
 *
 * 与 ready-to-show 共用同一套判定；活动/空闲由调用方负责（showOverlay 本身就是活动触发）。
 *
 * @param {{hostVisible?:boolean, hostStale?:boolean, hostCheckedAt?:number, now?:number,
 *          maxHostAgeMs?:number, front?:string, hostBundles?:string[], self?:string,
 *          titleKnown?:boolean, titleMatched?:boolean}} [input]
 * @returns {boolean}
 */
function shouldShowNow(input = {}) {
  const {
    hostVisible = false,
    hostStale = false,
    hostCheckedAt,
    now = Date.now(),
    maxHostAgeMs = DEFAULT_MAX_HOST_AGE_MS,
    front = '',
    hostBundles = [],
    self = 'com.github.Electron',
    titleKnown = true,
    titleMatched = true,
  } = input || {};

  if (!isHostSnapshotFresh({ hostVisible, hostStale, hostCheckedAt, now, maxHostAgeMs })) return false;
  // 标题未知（dshTitle 还没读到）或明确不匹配时不显示；titleHint 为空由调用方决定是否放行
  if (titleKnown !== true) return false;
  if (titleMatched !== true) return false;
  return isFrontTrusted(front, hostBundles, self);
}

/**
 * 窗口刚创建（ready-to-show）时该不该显示（纯函数）。
 *
 * 这是个真实 bug 的修复：以前 ready-to-show 里无条件 showInactive()，
 * 任何请求新建一个会话窗口的瞬间，小窗都会无视「宿主是否在前台/是否在别的 Space/标题是否匹配」
 * 闪出来一下——用户正在别的应用/别的桌面干活时会看到它冒出来。
 *
 * task-27：未知前台/未知标题改为 fail-closed（原来 front 为空放行，会在冷启动前 2 秒冒窗）。
 *
 * @param {{hostVisible?:boolean, hostStale?:boolean, hostCheckedAt?:number, now?:number,
 *          maxHostAgeMs?:number, front?:string, hostBundles?:string[], self?:string,
 *          titleKnown?:boolean, titleMatched?:boolean, hasActivity?:boolean}} [input]
 * @returns {boolean}
 */
function shouldShowOnReady(input = {}) {
  const { hasActivity = true } = input || {};
  if (hasActivity !== true) return false;
  return shouldShowNow(input);
}

/**
 * POST /status 是否应该被当成「活动」（task-27 R4）。
 * server 把 clear:true 转成空 text；clear 是复位/收尾，不应该刷新 lastActivityAt、也不应触发显示。
 *
 * @param {{clear?:boolean}} [input]
 * @returns {boolean}
 */
function shouldCountStatusActivity(input = {}) {
  const { clear = false } = input || {};
  return clear !== true;
}

/**
 * 隐藏态下的 /expand 是否应该忽略（task-27 R6）。
 * 展开会把 bounds 换成大窗；窗口不可见时先落盘会让下次合法显示直接变成大窗。
 * 折叠（expanded=true → false）始终允许，避免窗口卡在放大态。
 *
 * @param {{visible?:boolean, expanded?:boolean}} [input]
 * @returns {boolean} true = 忽略这次 expand
 */
function shouldIgnoreExpand(input = {}) {
  const { visible = false, expanded = false } = input || {};
  if (expanded === true) return false;
  return visible !== true;
}

module.exports = {
  DEFAULT_SUFFIX,
  DEFAULT_MAX_HOST_AGE_MS,
  normalizeHostTitle,
  normalizeDshTitle,
  matchesTitle,
  isHostSnapshotFresh,
  isFrontTrusted,
  shouldShowNow,
  shouldShowOnReady,
  shouldCountStatusActivity,
  shouldIgnoreExpand,
};
