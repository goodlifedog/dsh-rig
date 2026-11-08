'use strict';
/**
 * 验收期间的「意外应用」兜底：任务把应用拉起来留在后台时，把它收掉。
 *
 * 现场（2026-11-08 16:09 验收）：multi-app 意外拉起了一个原本没在运行的计算器并留在后台；
 * 后面任务退出别的应用时，前台被带到这个计算器上，验收就判「前台被抢占」。
 * 这不是某个任务独有的问题，所以做成验收层的通用兜底：
 *   验收开始采样一次（基线）→ 每跑完一个任务再采样 → 只在基线上「新出现」的才收。
 *
 * 安全边界：
 *   - 只认 TEST_APPS 里的应用，绝不碰用户其它程序；
 *   - 基线里就有的（用户自己开着的）永远不动；
 *   - 真正的「退出应用」由调用方注入（acceptance.mjs 用 quitAppSync，只发 AppleScript quit）。
 *
 * 这个模块只做纯逻辑 + 可注入采样，方便单测；不 import 任何会动应用的东西。
 */
import { execFileSync as defaultExecFileSync } from 'node:child_process';

/** 把「名字集合」的几种写法统一成 Set（Set / 数组 / 单个字符串 / 空值） */
export function toNameSet(input) {
  const out = new Set();
  if (input == null) return out;
  if (typeof input === 'string') {
    const name = input.trim();
    if (name) out.add(name);
    return out;
  }
  const iterable = input instanceof Set || Array.isArray(input) ? input : [];
  for (const value of iterable) {
    const name = String(value == null ? '' : value).trim();
    if (name) out.add(name);
  }
  return out;
}

/**
 * 核心判定（纯函数）：返回「before 时没在跑、after 时在跑」的应用名。
 *
 * @param {Iterable<string>} before 验收开始时的运行集合
 * @param {Iterable<string>} after  现在的运行集合
 * @param {Iterable<string>} [testApps] 只认这批应用；不传则不限制
 * @returns {string[]} 新增的应用名（顺序按 after 的遍历顺序，便于断言）
 */
export function diffNewlyRunning(before, after, testApps) {
  const was = toNameSet(before);
  const now = toNameSet(after);
  const allowed = testApps == null ? null : toNameSet(testApps);
  const out = [];
  for (const name of now) {
    if (was.has(name)) continue;          // 本来就在跑 → 可能是用户自己的，绝不动
    if (allowed && !allowed.has(name)) continue;  // 不在测试应用名单里 → 不归我们管
    out.push(name);
  }
  return out;
}

/**
 * 某个应用现在是否在跑（pgrep -x，精确匹配进程名）。
 * 用 execFileSync 注入便于单测；pgrep 退出码非 0 = 没在跑。
 */
export function isAppRunning(name, options = {}) {
  const appName = String(name == null ? '' : name).trim();
  if (!appName) return false;
  const opts = options || {};
  const exec = opts.execFileSync || defaultExecFileSync;
  try {
    exec('/usr/bin/pgrep', ['-x', appName], { timeout: opts.timeoutMs || 2000, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * 采样一批测试应用的运行集合。
 * @param {Iterable<string>} testApps
 * @param {{isRunning?:Function, execFileSync?:Function, timeoutMs?:number, platform?:string}} [options]
 *   isRunning 优先；否则用 execFileSync 跑 pgrep -x
 * @returns {Set<string>}
 */
export function sampleRunningApps(testApps, options = {}) {
  const opts = options || {};
  const platform = opts.platform || process.platform;
  const apps = [...toNameSet(testApps)];
  const running = new Set();
  // 非 macOS 不跑 pgrep（不猜别的平台的进程名语义），直接当「都没在跑」
  if (platform !== 'darwin') return running;
  const probe = typeof opts.isRunning === 'function'
    ? opts.isRunning
    : (name) => isAppRunning(name, opts);
  for (const name of apps) {
    let hit = false;
    try { hit = Boolean(probe(name)); } catch { hit = false; }
    if (hit) running.add(name);
  }
  return running;
}

/**
 * 收尾写进报告的那句话（纯函数）。
 * @param {string[]} names
 * @param {string} [stage] 哪个阶段发现的（如「任务 multi-app 之后」「验收收尾」）
 */
export function cleanupMessages(names, stage = '') {
  const list = [...toNameSet(names)];
  return list.map((name) => '收掉验收期间被拉起的 ' + name + (stage ? '（' + stage + '）' : ''));
}
