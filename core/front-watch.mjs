/**
 * 前台看门狗：后台任务跑的时候，如果前台被别的应用抢走，立刻还回去。
 *
 * 目的：即使某个应用（例如 Chrome、某些 Electron 应用）启动或操作时会自己 activate，
 * 用户实际感受到的也只是"闪一下"，而不是焦点被夺走、打字打断。
 *
 * 轮询用 lsappinfo（约 20ms/次），比 osascript（120ms）便宜得多。
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/**
 * 当前前台应用的显示名。
 *
 * 注意：曾尝试用 lsappinfo（约 10ms）做快路径，但在 launchd 起的后台进程里它会把前台
 * 报成 loginwindow，与真实前台不一致，导致看门狗形同虚设。这里改用 System Events
 * （约 120ms/次），代价是轮询期间多占一点 CPU，但结果可靠。
 */
export async function frontAppFast() {
  try {
    const { stdout } = await exec('/usr/bin/osascript', ['-e', 'tell application "System Events" to get name of first process whose frontmost is true'], { timeout: 3000 });
    return String(stdout || '').trim();
  } catch {
    return '';
  }
}

/** 把前台还给指定应用 */
export async function restoreFront(name) {
  if (!name) return false;
  try {
    await exec('/usr/bin/osascript', ['-e', 'tell application "System Events" to set frontmost of process ' + JSON.stringify(name) + ' to true'], { timeout: 4000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * 启动看门狗：期望前台是 expect，一旦变了就还原并回调。
 * @returns {{stop:Function, stats:Function}}
 */
export function startFrontWatch({
  expect,
  intervalMs = 300,
  onSteal,
  maxRestores = 20,
  userIntentMs = 1500,
  // 便于测试时注入假实现；生产环境用真实实现
  getFront = frontAppFast,
  restore = restoreFront,
} = {}) {
  let stopped = false;
  let timer = null;
  let steals = 0;
  let restores = 0;
  let lastSteal = null;
  let current = expect;
  const recentSteals = [];   // 记录最近的抢占，用于识别"用户自己在切"

  const poll = async () => {
    if (stopped) return;
    let seen = '';
    try { seen = await getFront(); } catch { seen = ''; }
    if (seen && current && seen !== current) {
      // 判定"用户自己在切"：同一个应用在 userIntentMs 窗口内反复把它抢回来 3 次以上，
      // 说明不是应用自己跳，而是用户想用它——这时候别跟用户打架，直接认账。
      const now = Date.now();
      recentSteals.push({ app: seen, at: now });
      while (recentSteals.length && now - recentSteals[0].at > userIntentMs) recentSteals.shift();
      const sameAppRepeated = recentSteals.filter((s) => s.app === seen).length >= 3;
      if (sameAppRepeated) {
        if (onSteal) {
          try { onSteal({ from: current, to: seen, restored: restores, userSwitched: true, at: now }); } catch {}
        }
        current = seen;
        recentSteals.length = 0;
      } else {
        steals += 1;
        lastSteal = { from: current, to: seen, at: Date.now() };
        if (restores < maxRestores) {
          // 还原失败不能让轮询挂掉：吞掉异常，计入"未成功"，下一轮继续尝试
          try {
            const ok = await restore(current);
            if (ok) restores += 1;
          } catch {}
        }
        if (onSteal) {
          try { onSteal({ from: current, to: seen, restored: restores, userSwitched: false, at: Date.now() }); } catch {}
        }
      }
    }
    if (!stopped) timer = setTimeout(poll, intervalMs);
  };
  timer = setTimeout(poll, intervalMs);

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
    /** 任务中途如果用户主动换了应用，调用这个把"期望前台"更新掉，避免看门狗跟用户打架 */
    retarget(name) {
      if (name) current = name;
    },
    stats() {
      return { expect: current, steals, restores, lastSteal };
    },
    /** 任务主动换了目标应用时同步（例如任务自己把某个应用带到前台） */
    accept(name) { if (name) { current = name; recentSteals.length = 0; } },
  };
}
