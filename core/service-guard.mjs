'use strict';
/**
 * 服务部署守卫：解决"改了代码但跑的还是旧进程 / 服务根本起不来"这类问题。
 *
 * 真实踩过的坑（外部评审查出来的）：有一个手工启动的游离 daemon 占着 7789，
 * launchd 每次拉起受管实例都 EADDRINUSE 崩溃重试；于是"重启服务"完全无效，
 * 代码改了、提交了，实际跑的还是几小时前的版本。
 *
 * 这里把判断抽成纯函数：端口监听者是谁、是不是我们的进程、launchd 实际在跑哪个 pid、
 * 两者是否漂移。restart 只在"监听者确认是我们自己的 daemon"时才杀。
 */

/**
 * 从 lsof -t 输出里取第一个 pid（纯函数）。
 * @param {string} output
 * @returns {number}
 */
export function parseListenerPid(output) {
  for (const line of String(output || '').split('\n')) {
    const pid = Number.parseInt(line.trim(), 10);
    if (Number.isFinite(pid) && pid > 0) return pid;
  }
  return 0;
}

/**
 * 监听端口的进程是不是本项目的 daemon（纯函数）。
 * 只认命令行里同时出现 daemon.mjs 和仓库路径/目录名，防止误杀别的程序。
 * @param {string} psCommand ps -o command= 的输出
 * @param {{rootDir?:string}} [options]
 * @returns {boolean}
 */
export function isOurDaemonCommand(psCommand, options = {}) {
  const cmd = String(psCommand || '');
  if (!/daemon\.mjs/.test(cmd)) return false;
  const root = String((options && options.rootDir) || '');
  if (root && cmd.includes(root)) return true;
  // 兼容改名前的仓库目录名（desktop-agent）与改名后的 dsh-rig：本机升级/别处克隆都要能认出来
  return /desktop-agent|dsh-rig/i.test(cmd);
}

/**
 * 监听端口的进程是不是本项目的 overlay（纯函数）。
 * overlay 是 Electron 进程，命令行里是本仓库 overlay 目录下的 Electron 可执行文件。
 * @param {string} psCommand
 * @param {{rootDir?:string}} [options]
 * @returns {boolean}
 */
export function isOurOverlayCommand(psCommand, options = {}) {
  const cmd = String(psCommand || '');
  if (!/Electron/i.test(cmd)) return false;
  const root = String((options && options.rootDir) || '');
  if (root && cmd.includes(root + '/overlay')) return true;
  return /desktop-agent|dsh-rig/i.test(cmd) && /overlay/i.test(cmd);
}

/**
 * 判定端口监听者身份（纯函数）。
 * @param {{listenerPid:number, listenerCommand?:string, rootDir?:string}} input
 * @returns {'ok'|'no-listener'|'foreign-process'}
 */
export function diagnoseListener(input = {}) {
  const pid = Number(input.listenerPid) || 0;
  if (!pid) return 'no-listener';
  if (!input.listenerCommand) return 'ok'; // 拿不到命令行时按"可能是我们的"处理，由调用方再确认
  return isOurDaemonCommand(input.listenerCommand, { rootDir: input.rootDir }) ? 'ok' : 'foreign-process';
}

/**
 * 从 launchctl print 输出里取受管进程 pid（纯函数）。
 * @param {string} output
 * @returns {number}
 */
export function parseLaunchdPid(output) {
  const text = String(output || '');
  const m = text.match(/^\s*pid\s*=\s*(\d+)/m);
  return m ? Number.parseInt(m[1], 10) : 0;
}

/**
 * 监听者与 launchd 受管进程是否漂移（纯函数）。
 * @param {{listenerPid:number, managedPid:number}} input
 * @returns {'ok'|'stray'|'no-listener'|'no-managed'}
 */
export function deploymentDrift(input = {}) {
  const listener = Number(input.listenerPid) || 0;
  const managed = Number(input.managedPid) || 0;
  if (!listener) return 'no-listener';
  if (!managed) return 'no-managed';
  return listener === managed ? 'ok' : 'stray';
}
