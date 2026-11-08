'use strict';
/**
 * 前台还原策略：只有"当前前台是我们动过的应用"时才还原回宿主。
 *
 * 为什么：以前无条件 set frontmost 宿主，用户中途切到别的应用时会被硬拽回来，
 * 看起来就是"屏幕反复切"。正确做法是——用户已经主动切走了，就别再抢。
 *
 * 匹配规则（P1，task-39）：归一化后「完全相等」才算匹配，不做双向包含。
 *   - 大小写 / 常见分隔符不敏感（空格、连字符、下划线、点）：
 *     「Clash Verge」=「clash-verge」、「WPS Office」=「wpsoffice」、「iTerm 2」=「iTerm2」；
 *   - 别名（本地化名 / 可执行进程名 / bundle 末段）由调用方补全（矩阵的 collectTouchedAliases 已传）；
 *   - 明确不匹配：主应用与 Helper/子进程（Google Chrome ✗ Google Chrome Helper）、
 *     短别名与同前缀应用（note ✗ Notepad / Notes）。这些以前会被 includes 误判成 restore，
 *     把用户正在用的应用硬拽回宿主。
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
  // 只做精确相等：包含匹配太宽（Chrome Helper / note→Notepad），会把用户的应用拽走
  if (list.some((name) => name === cur)) return 'restore';
  return 'leave-user';
}
