'use strict';
/**
 * 前台还原策略：只有"当前前台是我们动过的应用"时才还原回宿主。
 *
 * 为什么：以前无条件 set frontmost 宿主，用户中途切到别的应用时会被硬拽回来，
 * 看起来就是"屏幕反复切"。正确做法是——用户已经主动切走了，就别再抢。
 *
 * 匹配规则（M-2 实证：矩阵 touchedAll 里只有本地化名「计算器」和 bundle 末段「calculator」，
 * 而系统前台是进程名「Calculator」，大小写不一致导致 includes 对不上，误判 leave-user，
 * 前台没还回去）：
 *   - 大小写不敏感（统一小写再比较）；
 *   - 常见分隔符不敏感（空格/连字符/下划线/点）：系统名「Clash Verge」和进程名「clash-verge」、
 *     「WPS Office」和「wpsoffice」都能对上；
 *   - 支持候选别名：touched 里任一项与 current 归一化后相等，或互相包含，都算"我们动过的应用"。
 */

/** 归一化用于大小写/分隔符不敏感比较：小写、去首尾空白、去掉常见分隔符。 */
export function normalizeFrontName(value) {
  return String(value || '').trim().toLowerCase().replace(/[\s\-_.·]+/g, '');
}

/**
 * @param {{current?:string, before?:string, touched?:string[]}} input
 * @returns {'noop'|'restore'|'leave-user'}
 */
export function decideRestore({ current = '', before = '', touched = [] } = {}) {
  const curRaw = String(current || '').trim();
  const targetRaw = String(before || '').trim();
  if (!targetRaw) return 'noop';
  // 前台读不到时不要瞎还原（旧逻辑会被 name.includes('') 误判成 restore）
  if (!curRaw) return 'noop';

  const cur = normalizeFrontName(curRaw);
  const target = normalizeFrontName(targetRaw);
  if (cur === target) return 'noop';

  const list = (touched || [])
    .map((name) => normalizeFrontName(name))
    .filter(Boolean);
  if (list.some((name) => cur === name || cur.includes(name) || name.includes(cur))) return 'restore';
  return 'leave-user';
}
