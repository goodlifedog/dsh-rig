'use strict';
/**
 * 前台还原策略：只有"当前前台是我们动过的应用"时才还原回宿主。
 *
 * 为什么：以前无条件 set frontmost 宿主，用户中途切到别的应用时会被硬拽回来，
 * 看起来就是"屏幕反复切"。正确做法是——用户已经主动切走了，就别再抢。
 */

/**
 * @param {{current?:string, before?:string, touched?:string[]}} input
 * @returns {'noop'|'restore'|'leave-user'}
 */
export function decideRestore({ current = '', before = '', touched = [] } = {}) {
  const cur = String(current || '');
  const target = String(before || '');
  if (!target) return 'noop';
  if (cur === target) return 'noop';
  const list = (touched || []).map((x) => String(x)).filter(Boolean);
  if (list.some((name) => cur === name || cur.includes(name) || name.includes(cur))) return 'restore';
  return 'leave-user';
}
