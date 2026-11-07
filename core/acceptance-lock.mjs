// 验收互斥锁
//
// 为什么单独成模块：这把锁决定「会不会有两个验收同时在跑」。两个验收同时跑会一起切窗口、
// 一起动测试数据，是最难排查也最伤用户的一类事故，所以这里的每条分支都必须能被测试覆盖。
//
// 设计要点：
// 1. 锁文件内容用「临时文件 + link」原子落地，读的人不会读到空内容/半截 pid；
// 2. 只有「确认pid已死」或「没有可解析 pid 且锁已过期」才回收，绝不去 unlink 别人刚抢到的锁；
// 3. 抢不到时返回 busy 而不是静默继续，调用方据此退出。
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

export function readLockPid(file) {
  try {
    const info = String(fs.readFileSync(file, 'utf8')).trim().split(' ');
    const pid = Number(info[0]);
    return Number.isInteger(pid) && pid > 0 ? pid : 0;
  } catch {
    return 0;
  }
}

/** 原子写锁：先写临时文件，再 link 到目标名（目标已存在时 link 会 EEXIST，天然互斥） */
function writeLockAtomic(file, pid) {
  const tmp = file + '.' + pid + '.tmp';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, pid + ' ' + new Date().toISOString());
  try {
    fs.linkSync(tmp, file);
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

function lockAgeMs(file) {
  try { return Date.now() - fs.statSync(file).mtimeMs; } catch { return 0; }
}

/**
 * 拿锁。抢不到返回 busy，调用方应直接退出。
 * @param {string} file 锁文件路径
 * @param {{pid?: number, alive?: (pid: number) => boolean, now?: number}} [options]
 * @returns {{ok: true, warning?: string} | {ok: false, reason: 'busy', pid: number}}
 */
export function acquireLock(file, options = {}) {
  const pid = options.pid || process.pid;
  const alive = options.alive || pidAlive;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (fs.existsSync(file)) {
      const owner = readLockPid(file);
      if (owner && alive(owner)) return { ok: false, reason: 'busy', pid: owner };
      if (owner) {
        // 有明确 pid 且已死：残留锁，回收
        try { fs.unlinkSync(file); } catch {}
      } else if (lockAgeMs(file) > CORRUPT_LOCK_GRACE_MS) {
        // 没有可解析 pid：可能是写一半崩掉的残留，过期才回收，避免误删刚创建的锁
        try { fs.unlinkSync(file); } catch {}
      } else {
        return { ok: false, reason: 'busy', pid: 0 };
      }
    }
    try {
      writeLockAtomic(file, pid);
      return { ok: true };
    } catch (error) {
      // 只有「锁文件本身已存在」才是并发抢锁，回去看持有者是谁；
      // 其它 EEXIST（比如父路径是个普通文件，建目录失败）不能当成并发，否则会误报 busy 卡住验收。
      if (error && error.code === 'EEXIST' && fs.existsSync(file)) continue;
      return { ok: true, warning: '拿不到验收锁（' + ((error && error.message) || error) + '），按未加锁继续' };
    }
  }
  return { ok: false, reason: 'busy', pid: readLockPid(file) };
}

/** 释放锁：只删自己的，避免把别人的锁删掉 */
export function releaseLock(file, pid = process.pid) {
  const owner = readLockPid(file);
  if (owner && owner !== Number(pid)) return false;
  try { fs.unlinkSync(file); return true; } catch { return false; }
}
