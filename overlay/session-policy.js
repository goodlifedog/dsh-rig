'use strict';

/**
 * 会话窗口回收策略（纯函数，便于单测）。
 *
 * 每个 DSH 会话第一次推状态时会按需建一个窗口。会话多了窗口就会堆着——
 * 窗口即使隐藏也占内存。所以「长时间没活动、没被固定、没在放大、没在悬停」的会话
 * 应当自动关掉，下次有活动再按需重建。
 */

function shouldEvictSession(session, now, ttlMs) {
  const ttl = Number(ttlMs);
  if (!Number.isFinite(ttl) || ttl <= 0) return false;   // 0 = 关闭自动回收
  if (!session) return false;
  if (session.pinned) return false;      // 手动固定显示，用户明确要留着
  if (session.expanded) return false;    // 正在放大看画面
  if (session.visible) return false;     // 正显示着
  if (session.hovering) return false;    // 鼠标在上面
  const last = Number(session.lastActivityAt || session.createdAt || 0);
  if (!Number.isFinite(last) || last <= 0) return false;
  const at = Number(now) || Date.now();
  return at - last >= ttl;
}

/**
 * 会话数到上限时挑一个可以回收的会话（纯函数，便于单测）。
 *
 * 背景：调用方忘了 /close 时，上限会让后续任务整块 409 失败；但「不可见」并不等于「没在用」——
 * DSH 不在前台时所有会话都是 visible=false，盲挑最久没活动的有可能把正在被任务用的会话关掉。
 * 所以最近 protectMs 内有活动的一律跳过；一个都不能动时返回 null，让调用方如实报 409。
 *
 * @param {{id: string, lastActivityAt?: number, createdAt?: number, visible?: boolean, pinned?: boolean, flags?: {pinned?: boolean}}[]} list
 * @param {{now?: number, protectMs?: number, defaultSession?: string}} [options]
 * @returns {string|null}
 */
function pickEvictionVictim(list, options = {}) {
  const now = Number(options.now) || Date.now();
  const protectMs = Math.max(0, Number(options.protectMs) || 0);
  const defaultSession = options.defaultSession == null ? 'default' : String(options.defaultSession);
  let victim = null;
  for (const sess of Array.isArray(list) ? list : []) {
    if (!sess || !sess.id) continue;
    if (String(sess.id) === defaultSession) continue;
    if (sess.visible) continue;
    if (sess.pinned || (sess.flags && sess.flags.pinned)) continue;
    const last = Number(sess.lastActivityAt || sess.createdAt || 0);
    if (!Number.isFinite(last) || last <= 0) continue;
    if (now - last < protectMs) continue;
    if (!victim || last < victim.last) victim = { id: String(sess.id), last };
  }
  return victim ? victim.id : null;
}

/**
 * 会话是否真的显示在用户眼前。
 *
 * state.visible 只是「按状态它应该显示」，窗口实例可能已经销毁/隐藏（宿主切走、Space 不同）。
 * 回收与会话上限判断要用这个「真可见」，否则一批刚建好、状态标记还是 true 的会话会把上限顶死。
 */
function isSessionReallyVisible(stateVisible, windowVisible) {
  return Boolean(stateVisible) && Boolean(windowVisible);
}

module.exports = { shouldEvictSession, pickEvictionVictim, isSessionReallyVisible };
