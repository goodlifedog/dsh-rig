'use strict';
/**
 * 同步版「关掉应用」（只用于信号处理里的应急清理）。
 *
 * 为什么必须同步：进程收到 SIGTERM 时，同进程里可能还有别的监听器（ocu-mcp 的退出钩子）
 * 会立刻 process.exit——异步的 quitApp 还没等到 osascript 回来就被退出，应用就留下来了。
 * 信号处理里做阻塞调用（execFileSync）+ 短暂轮询，才能在别人退出前把应用关掉。
 *
 * 安全边界：只发 AppleScript quit（优雅退出），退不掉就如实返回失败，绝不强杀
 * （强杀可能丢用户没保存的内容）。
 */
import { execFileSync } from 'node:child_process';

function stillRunning(app) {
  const processName = String((app && (app.processName || app.process)) || '').trim();
  if (!processName) return false;
  try {
    execFileSync('/usr/bin/pgrep', ['-x', processName], { timeout: 1500, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {{appName?:string, bundleId?:string, processName?:string}} app
 * @param {{timeoutMs?:number, waitMs?:number}} [options]
 * @returns {{quit:boolean, mode:string}}
 */
export function quitAppSync(app, options = {}) {
  const opts = options || {};
  if (!app) return { quit: true, mode: 'no-app' };
  const target = app.bundleId ? 'id ' + JSON.stringify(app.bundleId) : JSON.stringify(String(app.appName || ''));
  try {
    execFileSync('/usr/bin/osascript', ['-e', 'with timeout of 4 seconds\ntell application ' + target + ' to quit\nend timeout'], { timeout: opts.timeoutMs || 6000, stdio: 'ignore' });
  } catch {}
  const waitMs = Number.isFinite(opts.waitMs) ? opts.waitMs : 2000;
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if (!stillRunning(app)) return { quit: true, mode: 'quit' };
    try { execFileSync('/bin/sleep', ['0.2']); } catch {}
  }
  return { quit: !stillRunning(app), mode: 'quit-timeout' };
}
