'use strict';
/**
 * 清理时「该不该关掉这个应用」的判定（纯函数）。
 *
 * 原则：不打扰用户。
 *   - 本次清理自己拉起来的应用 → 关掉（自己开的自己收）；
 *   - 不是本次启动的 → 一律保留（哪怕用户已经离开：用户回来发现应用被关是实打实的打扰）；
 *   - 只有显式开关 CLEANUP_QUIT_RESIDUAL=1（排障用）才恢复旧行为：
 *     非本次启动 + 用户已离开 → 当测试残留清掉。
 *
 * 历史：清理脚本曾经无条件 quit Notes/Calculator；后来收窄成「非本次启动但用户离开就关」，
 * 仍然会关掉用户自己开着的应用（评审 L4b），现在默认改成只关 launchedByUs。
 */

/**
 * @param {{launchedByUs?: boolean, userActive?: boolean, quitResidual?: boolean}} input
 *   quitResidual 由调用点从 CLEANUP_QUIT_RESIDUAL（只认 '1'）显式传入，纯函数不读 env
 * @returns {{quit: boolean, reason: string}}
 */
function shouldQuitApp(input = {}) {
  const launchedByUs = Boolean(input && input.launchedByUs);
  const userActive = Boolean(input && input.userActive);
  // 只认严格布尔 true：避免万一传进来字符串 '1'/'true' 就误开旧行为
  const quitResidual = (input && input.quitResidual) === true;
  if (launchedByUs) return { quit: true, reason: '本次启动的应用，清完就关' };
  if (userActive) return { quit: false, reason: '不是本次启动的，且用户正在使用，别打扰' };
  if (quitResidual) return { quit: true, reason: '不是本次启动的，用户已离开；CLEANUP_QUIT_RESIDUAL=1 按旧策略清理残留' };
  return { quit: false, reason: '不是本次启动，保留；如需按旧策略清理设置 CLEANUP_QUIT_RESIDUAL=1' };
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
