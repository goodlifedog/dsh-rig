// 验收互斥锁
//
// 为什么单独成模块：这把锁决定「会不会有两个验收同时在跑」。两个验收同时跑会一起切窗口、
// 一起动测试数据，是最难排查也最伤用户的一类事故，所以这里的每条分支都必须能被测试覆盖。
//
// 设计要点：
// 1. 锁文件内容用「临时文件 + link」原子落地，读的人不会读到空内容/半截 pid；
// 2. 只有「确认pid已死」或「没有可解析 pid 且锁已过期」才回收，绝不去 unlink 别人刚抢到的锁；
// 3. 抢不到时返回 busy 而不是静默继续，调用方据此退出；
// 4. 写锁失败（权限/磁盘满/父路径异常等非 EEXIST 错误）默认 fail-closed：返回 ok:false，
//    宁可这一次验收不跑，也不能在没加锁的状态下和另一个验收一起切窗口。
//    只有显式 AGENT_ALLOW_UNLOCKED=1 才降级为「未加锁继续 + 警告」（给排障/应急用）。
import fs from 'node:fs';
import path from 'node:path';

/** 内容不可解析的锁，超过这个时间才认为是被中断的残留（防止误删正在写的锁） */
export const CORRUPT_LOCK_GRACE_MS = 60_000;

export function pidAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (error) {
    // EPERM：进程存在但不是我们的，依然算活着，不能抢
    return Boolean(error && error.code === 'EPERM');
  }
}

export function readLockPid(file, fss = fs) {
  try {
    const info = String(fss.readFileSync(file, 'utf8')).trim().split(' ');
    const pid = Number(info[0]);
    return Number.isInteger(pid) && pid > 0 ? pid : 0;
  } catch {
    return 0;
  }
}

/** 原子写锁：先写临时文件，再 link 到目标名（目标已存在时 link 会 EEXIST，天然互斥） */
function writeLockAtomic(file, pid, fss = fs) {
  const tmp = file + '.' + pid + '.tmp';
  fss.mkdirSync(path.dirname(file), { recursive: true });
  fss.writeFileSync(tmp, pid + ' ' + new Date().toISOString());
  try {
    fss.linkSync(tmp, file);
  } finally {
    try { fss.unlinkSync(tmp); } catch {}
  }
}

function lockAgeMs(file, fss = fs) {
  try { return Date.now() - fss.statSync(file).mtimeMs; } catch { return 0; }
}

/** 是否显式允许「拿不到锁也照跑」。只认 "1"，其余（0/true/空）一律当不允许 */
export function unlockedAllowed(env = process.env) {
  return String((env || {}).AGENT_ALLOW_UNLOCKED || '') === '1';
}

/**
 * 拿锁。抢不到返回 busy；写锁失败默认 fail-closed（ok:false + reason:'lock-unwritable'）。
 * 调用方拿到 ok:false 就必须退出，不能自己「当作没锁」继续跑。
 * @param {string} file 锁文件路径
 * @param {{pid?: number, alive?: (pid: number) => boolean, fs?: object, env?: object}} [options]
 *   fs/env 仅用于测试注入（模拟 EACCES/ENOSPC，或在不污染真实环境的情况下验证 AGENT_ALLOW_UNLOCKED）
 * @returns {{ok: true, unlocked?: boolean, warning?: string}
 *          | {ok: false, reason: 'busy', pid: number}
 *          | {ok: false, reason: 'lock-unwritable', error: string}}
 */
export function acquireLock(file, options = {}) {
  const pid = options.pid || process.pid;
  const alive = options.alive || pidAlive;
  const fss = options.fs || fs;
  const env = options.env || process.env;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (fss.existsSync(file)) {
      const owner = readLockPid(file, fss);
      if (owner && alive(owner)) return { ok: false, reason: 'busy', pid: owner };
      if (owner) {
        // 有明确 pid 且已死：残留锁，回收
        try { fss.unlinkSync(file); } catch {}
      } else if (lockAgeMs(file, fss) > CORRUPT_LOCK_GRACE_MS) {
        // 没有可解析 pid：可能是写一半崩掉的残留，过期才回收，避免误删刚创建的锁
        try { fss.unlinkSync(file); } catch {}
      } else {
        return { ok: false, reason: 'busy', pid: 0 };
      }
    }
    try {
      writeLockAtomic(file, pid, fss);
      return { ok: true };
    } catch (error) {
      // 只有「锁文件本身已存在」才是并发抢锁，回去看持有者是谁；
      // 其它 EEXIST（比如父路径是个普通文件，建目录失败）以及一切非 EEXIST 的写失败，
      // 都说明这把锁压根没锁上——这时按未加锁继续就可能两个验收一起切窗口，所以默认 fail-closed。
      if (error && error.code === 'EEXIST' && fss.existsSync(file)) continue;
      const detail = '拿不到验收锁（' + ((error && (error.message || error.code)) || String(error)) + '）';
      if (unlockedAllowed(env)) {
        return { ok: true, unlocked: true, warning: detail + '；AGENT_ALLOW_UNLOCKED=1，按未加锁继续（有并发验收风险）' };
      }
      return {
        ok: false,
        reason: 'lock-unwritable',
        error: detail + '。已按 fail-closed 中止，避免两个验收同时跑；先修好权限/磁盘/路径，'
          + '确需在无锁状态跑再显式设 AGENT_ALLOW_UNLOCKED=1',
      };
    }
  }
  return { ok: false, reason: 'busy', pid: readLockPid(file, fss) };
}

/**
 * 解析 ps 的 pid/ppid 表（ps -axo pid=,ppid= 的输出）→ Map<pid, ppid>
 * @param {string} text
 * @returns {Map<number, number>}
 */
function parsePpidTable(text) {
  const table = new Map();
  for (const raw of String(text || '').split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(raw);
    if (!m) continue;
    const pid = Number(m[1]);
    const ppid = Number(m[2]);
    if (Number.isInteger(pid) && pid > 0) table.set(pid, ppid);
  }
  return table;
}

/**
 * childPid 是否在 ancestorPid 的进程树里（沿 ppid 往上走，最多 20 层防环）。
 * 用途：验收会拉起 runner→任务子进程，任务检查锁时要知道「这个锁是不是我爸的」。
 */
function isDescendantOf(ancestorPid, childPid, table) {
  const ancestor = Number(ancestorPid) || 0;
  let cur = Number(childPid) || 0;
  if (!ancestor || !cur || !(table instanceof Map)) return false;
  for (let depth = 0; depth < 20 && cur > 0; depth += 1) {
    if (cur === ancestor) return true;
    cur = table.get(cur) || 0;
  }
  return cur === ancestor;
}

/**
 * 当前是否有「别的验收」持锁。自己（或自己的祖先）持锁时返回 null——那是正常的父子关系。
 * @param {string} lockFile
 * @param {{pid?:number, table?:Map<number,number>, reader?:Function}} [options]
 * @returns {Promise<{pid:number}|null>}
 */
async function foreignAcceptanceOwner(lockFile, options = {}) {
  const opts = options || {};
  const owner = readLockPid(lockFile);
  if (!owner || !pidAlive(owner)) return null;
  const self = Number(opts.pid) || process.pid;
  if (owner === self) return null;
  const table = opts.table instanceof Map ? opts.table : parsePpidTable(await (opts.reader ? opts.reader() : defaultPpidTable()));
  return isDescendantOf(owner, self, table) ? null : { pid: owner };
}

async function defaultPpidTable() {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  try {
    const { stdout } = await promisify(execFile)('/bin/ps', ['-axo', 'pid=,ppid='], { timeout: 3000, maxBuffer: 4 * 1024 * 1024 });
    return String(stdout || '');
  } catch {
    return '';
  }
}

/** 释放锁：只删自己的，避免把别人的锁删掉 */
export { parsePpidTable, isDescendantOf, foreignAcceptanceOwner };

export function releaseLock(file, pid = process.pid) {
  const owner = readLockPid(file);
  if (owner && owner !== Number(pid)) return false;
  try { fs.unlinkSync(file); return true; } catch { return false; }
}
