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

module.exports = { shouldEvictSession };
