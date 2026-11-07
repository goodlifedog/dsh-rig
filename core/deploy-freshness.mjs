/**
 * 部署新鲜度：进程跑的是不是最新代码。
 *
 * `npm run service:status` 原来的「部署状态」只回答「端口是不是 launchd 受管进程占着」，
 * 不回答「这个进程加载的是不是当前磁盘上的代码」。改了直接依赖却不重启时，状态照样 ok，
 * 排查起来会误以为「改了没生效」。
 *
 * 这里只做判断，不自动重启：重启是用户/代理的决定。
 */
import fs from 'node:fs';
import path from 'node:path';

/** 活跃进程启动时会加载的模块（不含任务脚本——任务每次 spawn 时重新加载） */
export const WATCH_FILES = Object.freeze({
  daemon: [
    'core/daemon.mjs',
    'core/agentd.mjs',
    'core/retry-policy.mjs',
    'core/front-watch.mjs',
    'core/local-token.mjs',
    'core/orphan-cleanup.mjs',
    'core/platform.mjs',
  ],
  overlay: [
    'overlay/main.js',
    'overlay/server.js',
    'overlay/recover.js',
    'overlay/host-select.js',
    'overlay/session-policy.js',
    'overlay/session-gate.js',
    'overlay/window-id.js',
    'overlay/frame-target.js',
    'overlay/layout.js',
    'overlay/platform.js',
  ],
});

/**
 * @param {{rootDir:string, startedAtMs:number, files:string[]}} input
 * @returns {{stale:boolean, newestFile:string, newestMs:number, deltaMs:number}}
 */
export function checkFreshness(input) {
  const { rootDir, startedAtMs, files } = input || {};
  if (!rootDir || !Number.isFinite(startedAtMs) || startedAtMs <= 0 || !Array.isArray(files)) {
    return { stale: false, newestFile: '', newestMs: 0, deltaMs: 0 };
  }
  let newestFile = '';
  let newestMs = 0;
  for (const rel of files) {
    try {
      const st = fs.statSync(path.join(rootDir, rel));
      if (st.mtimeMs > newestMs) { newestMs = st.mtimeMs; newestFile = rel; }
    } catch {
      // 文件不存在就跳过：可能是可选模块
    }
  }
  const deltaMs = newestMs - startedAtMs;
  return {
    stale: newestMs > startedAtMs + 1000,   // 1 秒容差，避免启动和写文件的时序抖动
    newestFile,
    newestMs,
    deltaMs: deltaMs > 0 ? deltaMs : 0,
  };
}

export function formatFreshness(label, result) {
  if (!result || !result.stale) return label + ' 代码新鲜度：ok';
  const mins = Math.round(result.deltaMs / 60000);
  return label + ' 代码新鲜度：落后 —— ' + result.newestFile + ' 比进程新 ' + mins + ' 分钟，建议 npm run service:restart';
}

