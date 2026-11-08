'use strict';
/**
 * 安全边界静态自查：把"会出人命的几类写法"变成可执行规则，防止以后改代码时悄悄退化。
 *
 * 这里只查**结构性问题**（启动不收尾、强杀、前台抢占没人兜、读取绕过风险名单），
 * 不做语义分析，也不替代实机验收。纯函数，便于单测和 CI 直接跑。
 */

/** 内层脚本：由外层任务在 guard/锁屏检查之后调用，自身不需要重复检查 */
export const UI_GUARD_ALLOWLIST = ['greet-inner.mjs'];

/** 只看任务目录（这些是真正会动用户应用和屏幕的代码） */
export const UI_ACTION_RE = /ocu\.|getAXState|readSafe|findSafe|snapshot\(|state\(|click\(|find\(|typeText|pressKey|setValue/;
export const UI_GUARD_RE = /isScreenLocked|lockedSkipNotice|foreignAcceptanceOwner|acceptanceLock|ACCEPT_|withAppLock|frontRiskGate|risk\.shouldSkip/;

/**
 * 检查一份源码。
 * @param {{file:string, source:string}} input
 * @param {{base?:string}} [options] file 用相对路径（如 core/tasks/x.mjs）便于展示
 * @returns {Array<{rule:string, file:string, detail:string}>}
 */
export function auditSource(input, options = {}) {
  const file = String(input && input.file || '');
  const source = String(input && input.source || '');
  const base = String(options.base || '');
  const name = base && file.startsWith(base) ? file.slice(base.length) : file;
  const short = name.split('/').pop();
  const out = [];
  const add = (rule, detail) => out.push({ rule, file: name, detail });

  // 1) 自己拉起的应用必须自己收掉，否则用户桌面上会多出测试窗口
  if (/ensureAppRunning\s*\(/.test(source) && !/quitApp\s*\(|cleanupApps\s*\(/.test(source)) {
    add('launch-no-cleanup', '调用了 ensureAppRunning 但没有 quitApp/cleanupApps 收尾');
  }

  // 2) 强杀是丢数据的直接来源（用户没保存的内容会被丢掉）
  const forceKill = source.match(/\bpkill\b[^\n]*(?:-9|-KILL)\b|\bkillall\b|\bkill\s+(?:-9|-KILL)\b/);
  if (forceKill) add('force-kill', '出现强制结束进程的写法：' + forceKill[0].trim());

  // 3) 启动应用必须用后台标志（open -g），否则会把前台抢走
  if (/\/usr\/bin\/open|['"]open['"]/.test(source) && !/'-g'|"-g"|launchFlags/.test(source)) {
    add('open-without-background', '调用 open 时没带 -g/launchFlags，会激活应用');
  }

  // 4) 会动屏幕的任务必须有环境/互斥护栏，否则锁屏或被用户打断时会产出假失败。
  //    只对 core/tasks 生效：脚本目录的辅助工具不一定直接操作界面（由调用方传 uiGuard:false 跳过）
  const checkUiGuard = options.uiGuard !== false;
  if (checkUiGuard && UI_ACTION_RE.test(source) && !UI_GUARD_RE.test(source) && !UI_GUARD_ALLOWLIST.includes(short)) {
    add('ui-without-guard', '有界面操作但没有锁屏/前台/互斥护栏（也没在允许名单里）');
  }

  return out;
}

/**
 * 批量检查。
 * @param {Array<{file:string, source:string}>} entries
 * @param {{base?:string}} [options]
 */
export function auditTree(entries, options = {}) {
  const violations = [];
  for (const entry of entries || []) violations.push(...auditSource(entry, options));
  return violations;
}

/** 汇总成一行结论（CLI/报告用） */
export function summarizeViolations(violations) {
  const list = Array.isArray(violations) ? violations : [];
  if (!list.length) return '安全边界自查通过：没有发现启动不收尾/强杀/前台抢占/绕过风险名单的写法。';
  const byRule = new Map();
  for (const v of list) byRule.set(v.rule, (byRule.get(v.rule) || 0) + 1);
  return '安全边界自查发现 ' + list.length + ' 处问题（' +
    [...byRule].map(([rule, n]) => rule + ' × ' + n).join('，') + '）：\n' +
    list.map((v) => '  - ' + v.file + '：' + v.detail).join('\n');
}
