'use strict';
/**
 * 进程收尾工具箱：任务进程组终止 + 孤儿进程清理。
 *
 * 为什么这两件事放在一个文件里：daemon.mjs 有模块级副作用（读票据、监听端口），
 * 测试不能 import 它；而「怎么杀、杀谁」是需要单测的关键逻辑。所以抽成这个无副作用模块，
 * 纯函数 + 可注入 kill/schedule，daemon 和 runner 共用同一份实现。
 *
 * 孤儿清理要保守：
 *   - 只清 ppid=1 的孤儿（父进程还活着的，是有人在用，不动）
 *   - 只清命令里明确是本项目依赖/本项目 Chrome profile 的进程
 *   - 只清当前用户自己的进程
 *   - 清 Chrome 前再看一眼 SingletonLock：profile 正被活着的进程占用就跳过
 *     （open -g 拉起的 Chrome ppid 天然是 1，光看 ppid 分不清「残留」和「别的会话在用」）
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 默认认的进程命令行特征（ocu / Open Computer Use） */
export const DEFAULT_AGENT_PATTERN = /Open Computer Use|OpenComputerUse|\bocu\b/i;

/** 本项目的 Chrome profile 根目录（browser.mjs 的 DEFAULT_PROFILE 就在它下面） */
export const DEFAULT_PROFILE_ROOT = path.join(os.homedir(), '.desktop-agent');

/**
 * 只认 Chrome 本体。
 *
 * 坑：可执行路径本身带空格（"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"），
 * 不能简单 split(' ')[0] 取第一个 token，那样只会得到 "/Applications/Google"。
 * 这里用「以 Google Chrome / Chromium 结尾的路径 + 紧跟参数（--xxx）或行尾」来定位。
 *
 * helper/renderer 子进程的 argv 同样会带 --user-data-dir / --remote-debugging-port，
 * 但它们的路径后面跟的是 " Helper (Renderer) …"，不会命中，正好排除掉。
 */
export const DEFAULT_CHROME_BIN_PATTERN = /^(.*?\/(?:Google Chrome|Chromium))(?=\s+--|\s+-[A-Za-z]|$)/i;

/** 取命令行里的 Chrome 可执行文件路径；不是 Chrome 本体就返回空串（纯函数） */
export function chromeExecutableOf(command, pattern = DEFAULT_CHROME_BIN_PATTERN) {
  const cmd = String(command || '').trim();
  if (!cmd) return '';
  const m = pattern.exec(cmd);
  if (!m) return '';
  return m[1] || m[0];
}

/** 命令行是不是 Chrome/Chromium 本体（纯函数） */
export function isChromeBinary(command, pattern = DEFAULT_CHROME_BIN_PATTERN) {
  return chromeExecutableOf(command, pattern) !== '';
}

/** 默认宽限：TERM 之后等多久再 KILL（给任务留出 finally/同步清理的时间） */
export const DEFAULT_KILL_GRACE_MS = 3000;

/**
 * 解析 ps 输出（纯函数）。要求每行：pid ppid user command...
 * @param {string} text
 * @returns {Array<{pid:number, ppid:number, user:string, command:string}>}
 */
export function parseProcessTable(text) {
  const rows = [];
  for (const line of String(text || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const m = trimmed.match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
    if (!m) continue;
    rows.push({ pid: Number(m[1]), ppid: Number(m[2]), user: m[3], command: m[4] });
  }
  return rows;
}

/** 从命令行里取 --user-data-dir 的值（纯函数） */
export function userDataDirOf(command) {
  const m = /--user-data-dir=(?:"([^"]*)"|(\S+))/.exec(String(command || ''));
  if (!m) return '';
  return (m[1] || m[2] || '').replace(/\/+$/, '');
}

/**
 * 是不是「本项目的自动 Chrome」（纯函数）。
 *
 * 这类 Chrome 由 core/browser.mjs 用 open -g 拉起：Chrome 是 LaunchServices 的子进程，
 * 不在任务的进程组里，所以任务被 /stop 或超时杀掉时它不会跟着死，会一直带着
 * --remote-debugging-port 跑着（CDP 本身无鉴权 = 同机任意进程可接管这个已登录的 profile）。
 *
 * 判定条件：Chrome 本体 + 带 --remote-debugging-port + user-data-dir 在本项目 profile 根目录下。
 *
 * @param {string} command
 * @param {{profileRoot?:string, binPattern?:RegExp}} [options]
 */
export function isProjectChrome(command, options = {}) {
  const opts = options || {};
  const cmd = String(command || '');
  if (!cmd) return false;
  if (!/--remote-debugging-port(?:=|\s|$)/.test(cmd)) return false;
  const binPattern = opts.binPattern || DEFAULT_CHROME_BIN_PATTERN;
  if (!isChromeBinary(cmd, binPattern)) return false;
  const profileRoot = String(opts.profileRoot || DEFAULT_PROFILE_ROOT).replace(/\/+$/, '');
  if (!profileRoot) return false;
  const dir = userDataDirOf(cmd);
  if (!dir) return false;
  return dir === profileRoot || dir.startsWith(profileRoot + path.sep);
}

/** 公共的孤儿筛选：只 ppid=1、当前用户、不是自己、命中 match 的 */
function collectOrphans(rows, options, match) {
  const opts = options || {};
  const user = String(opts.user || '');
  const selfPid = Number(opts.selfPid) || 0;
  const out = [];
  const seen = new Set();
  for (const row of rows || []) {
    if (!row || !row.pid) continue;
    if (row.pid === selfPid) continue;
    if (seen.has(row.pid)) continue;
    if (row.ppid !== 1) continue;                       // 父进程还活着 → 有人在用，不动
    if (user && row.user !== user) continue;            // 别人的进程不动
    if (!match(row)) continue;
    seen.add(row.pid);
    out.push(row.pid);
  }
  return out;
}

/**
 * 找出需要清理的孤儿 app-agent（纯函数）。
 * @param {Array<object>} rows parseProcessTable 的输出
 * @param {{user?:string, pattern?:RegExp, selfPid?:number}} [options]
 * @returns {number[]}
 */
export function findOrphanedAgents(rows, options = {}) {
  const opts = options || {};
  const pattern = opts.pattern || DEFAULT_AGENT_PATTERN;
  return collectOrphans(rows, opts, (row) => pattern.test(String(row.command || '')));
}

/**
 * 读 Chrome 的 SingletonLock，解析出「当前占用这个 profile 的 pid」（可注入 readlink）。
 *
 * 为什么要这一步：open -g 拉起的 Chrome ppid 天然是 1，光看 ppid 分不清「残留」和
 * 「另一个会话正在用的离屏 Chrome」。Chrome 自己会在 user-data-dir 下写 SingletonLock
 * （符号链接，目标形如 "<hostname>-<pid>"），用它判断 profile 是否真的有人在用。
 *
 * 读不到 / 解析不出 pid（Windows 上不是符号链接、文件被删、内容异常）→ 返回 0，
 * 调用方按「没有活跃实例」处理。保留清理能力很重要：否则未鉴权的 CDP 端口会一直开着。
 *
 * @param {string} userDataDir
 * @param {{readlink?:Function}} [options]
 * @returns {number} 锁里记的 pid；没有/解析失败返回 0
 */
export function readSingletonLockPid(userDataDir, options = {}) {
  const dir = String(userDataDir || '');
  if (!dir) return 0;
  const opts = options || {};
  const readlink = opts.readlink || ((p) => fs.readlinkSync(p));
  let target = '';
  try { target = String(readlink(path.join(dir, 'SingletonLock')) || ''); } catch { return 0; }
  // 目标形如 "<hostname>-<pid>"，主机名自己可能带 "-"，所以只认末尾那段数字
  const m = /-(\d+)$/.exec(target.trim());
  if (!m) return 0;
  const pid = Number(m[1]);
  return Number.isInteger(pid) && pid > 0 ? pid : 0;
}

/**
 * 这个 Chrome profile 是否正被一个**活着的**进程占用（可注入 readlink / isAlive）。
 * @returns {number} 占用者的 pid；没人用返回 0
 */
export function chromeProfileInUse(userDataDir, options = {}) {
  const opts = options || {};
  const pid = readSingletonLockPid(userDataDir, opts);
  if (!pid) return 0;
  const isAlive = opts.isAlive || ((p) => isProcessAlive(p));
  return isAlive(pid) ? pid : 0;
}

/**
 * 找出需要清理的孤儿 Chrome：本项目 profile + 带调试端口（纯函数）。
 * CDP 无鉴权，残留一天就多一天「同机任意进程可接管已登录 profile」的面。
 *
 * 并发守卫：默认会看 SingletonLock，profile 正被活着的进程占用就跳过，
 * 避免 daemon 重启时把另一个会话正在用的离屏 Chrome 清掉。
 * options.guardActive === false 可强制全清（排障用）。
 */
export function findOrphanedChromes(rows, options = {}) {
  const opts = options || {};
  const guardActive = opts.guardActive !== false;
  return collectOrphans(rows, opts, (row) => {
    if (!isProjectChrome(row.command, opts)) return false;
    if (!guardActive) return true;
    const inUse = chromeProfileInUse(userDataDirOf(row.command), opts);
    return inUse === 0;                 // 有人在用 → 不算孤儿，绝不杀
  });
}

/** 两类孤儿合并去重（daemon 启动时清理就调这个） */
export function findOrphans(rows, options = {}) {
  const out = [];
  const seen = new Set();
  for (const pid of findOrphanedAgents(rows, options).concat(findOrphanedChromes(rows, options))) {
    if (seen.has(pid)) continue;
    seen.add(pid);
    out.push(pid);
  }
  return out;
}

/** 进程还活着吗（纯判定的可注入版本） */
export function isProcessAlive(pid, kill = process.kill) {
  const id = Number(pid) || 0;
  if (!(id > 0)) return false;
  try { kill(id, 0); return true; } catch { return false; }
}

/**
 * 给「任务进程树」发一个信号：优先负 pid（整个进程组），失败再退回单 pid。
 *
 * 为什么优先负 pid：daemon/runner 都用 detached 起任务，任务自成一个进程组，
 * 它拉起的子进程（ocu、node 脚本、非 detached 的 Electron）都默认落在同一个组里。
 * 只 kill(pid) 只能杀掉组长，组员会活下来变成孤儿。
 *
 * @param {number} pid 任务进程（组）id
 * @param {string} signal
 * @param {Function} [kill] 便于测试注入
 * @returns {{ok:boolean, pid:number, signal:string, group:boolean, error?:string}}
 */
export function signalProcessTree(pid, signal, kill = process.kill) {
  const id = Number(pid) || 0;
  // pid<=0 必须挡住：kill(-0) / kill(0) 会命中调用者自己所在的进程组，等于自杀
  if (!(id > 0)) return { ok: false, pid: id, signal: signal, group: false, error: 'pid 无效' };
  try {
    kill(-id, signal);
    return { ok: true, pid: id, signal: signal, group: true };
  } catch { /* 没有独立进程组（非 detached 起的旧进程 / 测试桩）→ 退回单杀 */ }
  try {
    kill(id, signal);
    return { ok: true, pid: id, signal: signal, group: false };
  } catch (error) {
    return { ok: false, pid: id, signal: signal, group: false, error: String((error && error.code) || error) };
  }
}

/**
 * 结束一个任务进程树：先 SIGTERM 整组，宽限期后还活着就 SIGKILL。
 *
 * 返回是同步的（调用方不必等），宽限定时器已 unref，不会拖住进程退出。
 *
 * @param {number} pid
 * @param {{kill?:Function, isAlive?:Function, schedule?:Function, graceMs?:number}} [options]
 * @returns {{pid:number, term:object|null, hardKill:object|null, hardKillScheduled:boolean, cancel:Function}}
 */
export function killTaskTree(pid, options = {}) {
  const opts = options || {};
  const kill = opts.kill || process.kill;
  const graceMs = Number.isFinite(opts.graceMs) ? Math.max(0, Number(opts.graceMs)) : DEFAULT_KILL_GRACE_MS;
  const schedule = opts.schedule || ((fn, ms) => {
    const timer = setTimeout(fn, ms);
    if (timer && typeof timer.unref === 'function') timer.unref();
    return timer;
  });
  const alive = opts.isAlive || ((p) => isProcessAlive(p, kill));

  const result = {
    pid: Number(pid) || 0,
    term: null,
    hardKill: null,
    hardKillScheduled: false,
    cancelled: false,
    timer: null,
    cancel: () => {},
  };
  if (!(result.pid > 0)) {
    result.term = { ok: false, pid: result.pid, signal: 'SIGTERM', group: false, error: 'pid 无效' };
    return result;
  }

  result.term = signalProcessTree(result.pid, 'SIGTERM', kill);

  const hardKill = () => {
    if (result.cancelled) return;
    if (!alive(result.pid)) { result.hardKill = { ok: false, skipped: true, reason: '进程已退出' }; return; }
    result.hardKill = signalProcessTree(result.pid, 'SIGKILL', kill);
  };

  if (graceMs === 0) {
    hardKill();
  } else {
    result.hardKillScheduled = true;
    result.timer = schedule(hardKill, graceMs);
  }

  result.cancel = () => {
    result.cancelled = true;
    try { clearTimeout(result.timer); } catch {}
  };
  return result;
}
