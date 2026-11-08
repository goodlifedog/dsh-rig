'use strict';
/**
 * 任务开跑前的「目标应用在不在跑」闸门（P0 批次B：#5/#6/#7/#8/#9 + bench-ocu）。
 *
 * 根因：ocu 对**没运行**的应用调用 snapshot / get_app_state / cua.getApp 时会把它启动起来
 * （默认对象是用户的 Google Chrome，还会带上登录 profile）并顶到前台。
 * 所以「只读演示 / 扫描 / 填充」类任务在碰目标应用之前必须先确认它在跑；
 * 没在跑就环境跳过：打印原因、不启动、退出 0，绝不为了测试去动用户的浏览器。
 *
 * 设计：纯判定（decideAppPresence）和探测（requireAppRunning）分开——
 * 本模块自己**不发任何系统命令**，探测函数由调用方注入（core/background.mjs 的 isAppRunning），
 * 这样单测可以在不碰真实应用的前提下覆盖所有分支。
 */

/** 跳过文案的后半句：说清「为什么不能顺手启动它」 */
export const NOT_RUNNING_HINT = '不为了测试去启动/激活它（ocu 会拉起应用并顶到前台）';

/** 环境跳过文案（纯函数） */
export function notRunningSkipMessage(app) {
  const name = String(app == null ? '' : app).trim() || '目标应用';
  return '环境跳过：' + name + ' 没在运行，' + NOT_RUNNING_HINT;
}

/**
 * 应用不在跑时是否允许继续（纯函数）。
 *
 * 只有两种情况放行：
 *   1. running === true（确定在跑）；
 *   2. allowLaunch === true（调用方显式接受"会被 ocu 拉起来"的后果，例如 bench 脚本的 --allow-launch）。
 * 拿不到运行状态（running 不是 true）一律按不在跑处理：宁可跳过，也不误启动。
 *
 * @param {{app?:string, running?:boolean, allowLaunch?:boolean}} [input]
 * @returns {{proceed:boolean, skipped:boolean, forced:boolean, message:string}}
 */
export function decideAppPresence(input = {}) {
  const opts = input || {};
  const app = String(opts.app == null ? '' : opts.app).trim();
  if (opts.running === true) return { proceed: true, skipped: false, forced: false, message: '' };
  const skipMessage = notRunningSkipMessage(app);
  if (opts.allowLaunch === true) {
    return {
      proceed: true,
      skipped: false,
      forced: true,
      message: skipMessage.replace(/^环境跳过：/, '注意：') + '，但已按 allowLaunch 显式放行（ocu 可能会把它拉起来）',
    };
  }
  return { proceed: false, skipped: true, forced: false, message: skipMessage };
}

/**
 * 给 isAppRunning 用的探测参数：TARGET_APP 可能是显示名（Google Chrome），也可能是 bundle id（com.google.Chrome）。
 * 后者必须走 bundleId 分支，不能拿整串当进程名。
 */
export function probeArgsForApp(app) {
  const name = String(app == null ? '' : app).trim();
  const looksLikeBundle = /^[A-Za-z0-9][A-Za-z0-9-]*(\.[A-Za-z0-9-]+)+$/.test(name);
  return looksLikeBundle ? { bundleId: name, appName: name } : { appName: name, processName: name };
}

/**
 * 探测一次目标应用是否在跑，并给出「继续 / 跳过」结论。
 *
 * @param {string} app 应用名或 bundle id（如 'Google Chrome'，也可来自 TARGET_APP）
 * @param {{isRunning?:Function, isAppRunning?:Function, allowLaunch?:boolean}} [options]
 *   isRunning(name) => boolean | Promise<boolean>     —— 最简注入，单测用
 *   isAppRunning({bundleId?, appName?, processName?}) —— 直接传 core/background.mjs 的 isAppRunning
 * @returns {Promise<{ok:boolean, app:string, running:boolean, skipped:boolean, forced:boolean, message:string}>}
 */
export async function requireAppRunning(app, options = {}) {
  const opts = options || {};
  const name = String(app == null ? '' : app).trim();
  let probe = typeof opts.isRunning === 'function' ? opts.isRunning : null;
  if (!probe && typeof opts.isAppRunning === 'function') {
    probe = (target) => opts.isAppRunning(probeArgsForApp(target));
  }
  if (!probe) throw new Error('requireAppRunning 需要注入 isRunning 或 isAppRunning 探测函数');
  let running = false;
  try {
    running = Boolean(await probe(name));
  } catch {
    // 探测本身失败（权限/超时）：按"没在跑"处理，宁可跳过，也不冒险让 ocu 去拉应用
    running = false;
  }
  const decision = decideAppPresence({ app: name, running, allowLaunch: opts.allowLaunch === true });
  return {
    ok: decision.proceed,
    app: name,
    running,
    skipped: decision.skipped,
    forced: decision.forced,
    message: decision.message,
  };
}

/**
 * 打印结论并返回「是否应当直接结束任务」（纯副作用很小，方便任务里一行调用）。
 * @param {{skipped:boolean, message:string, forced?:boolean}} result
 * @param {(line:string)=>void} [log]
 * @returns {boolean} true = 本次应跳过任务（调用方 return，退出码保持 0）
 */
export function reportAppPresence(result, log = console.log) {
  const r = result || {};
  if (r.message) log(r.message);
  return Boolean(r.skipped);
}

export default {
  NOT_RUNNING_HINT,
  notRunningSkipMessage,
  decideAppPresence,
  requireAppRunning,
  reportAppPresence,
};
