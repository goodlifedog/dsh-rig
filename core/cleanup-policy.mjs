'use strict';
/**
 * 清理时「该不该关掉这个应用」的判定（纯函数）。
 *
 * 原则：不打扰用户。
 *   - 本次清理自己拉起来的应用 → 关掉（自己开的自己收）；
 *   - 不是本次启动的、用户最近还在动键鼠 → 不关（人家正在用备忘录/计算器）；
 *   - 不是本次启动的、用户已经离开 → 可以当测试残留清掉。
 *
 * 之前清理脚本无条件 quit Notes/Calculator，用户开着备忘录跑一次清理就被关掉，
 * 数据虽然不丢，但这是实打实的打扰（评审实测）。
 */

/**
 * @param {{launchedByUs?: boolean, userActive?: boolean}} input
 * @returns {{quit: boolean, reason: string}}
 */
function shouldQuitApp(input = {}) {
  const launchedByUs = Boolean(input && input.launchedByUs);
  const userActive = Boolean(input && input.userActive);
  if (launchedByUs) return { quit: true, reason: '本次启动的应用，清完就关' };
  if (userActive) return { quit: false, reason: '不是本次启动的，且用户正在使用，别打扰' };
  return { quit: true, reason: '不是本次启动的，但用户已离开，清理残留' };
}

/**
 * 笔记清理要不要跑：用户正在用电脑时，连启动备忘录都不该做。
 * @param {{userActive?: boolean, force?: boolean}} input
 */
function shouldRunNoteCleanup(input = {}) {
  if (input && input.force) return { run: true, reason: '已显式 --force' };
  if (input && input.userActive) return { run: false, reason: '用户正在用电脑，跳过笔记清理（不打扰）' };
  return { run: true, reason: '' };
}

export { shouldQuitApp, shouldRunNoteCleanup };
