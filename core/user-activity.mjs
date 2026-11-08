'use strict';
/**
 * 「用户正在操作电脑」判定（纯函数）。
 *
 * 用在哪：会动用户应用内容/窗口的后台任务（备忘录写入、冷启动的退出/拉起等）。
 * 如果用户此刻正在打字或点鼠标，这些任务就算操作的是后台应用，也可能打断他的输入
 * （例如在备忘录里点击「新建备忘录」会把他正在写的焦点切走）。
 *
 * 判定原则：宁可这次不跑（标环境跳过），也不要在用户正在操作时去动他的应用。
 */

/** 默认阈值：键鼠 5 秒内动过就算「正在用」 */
export const ACTIVE_USER_MS = 5000;

/**
 * @param {number} idleMs 键鼠空闲毫秒（-1 = 读不到）
 * @param {{thresholdMs?:number}} [options]
 * @returns {{defer:boolean, reason:string}}
 */
export function shouldDeferForActiveUser(idleMs, options = {}) {
  const threshold = Number.isFinite(options && options.thresholdMs) ? options.thresholdMs : ACTIVE_USER_MS;
  const idle = Number(idleMs);
  if (!Number.isFinite(idle) || idle < 0) return { defer: false, reason: '读不到键鼠空闲（不据此拦任务）' };
  if (idle < threshold) {
    return {
      defer: true,
      reason: '你正在操作电脑（键鼠 ' + Math.round(idle / 1000) + ' 秒前动过），这次跳过以免打断你',
    };
  }
  return { defer: false, reason: '' };
}
