'use strict';
/**
 * 任务执行前的权限闸门（flow/PERMISSIONS-AUDIT.md H1）。
 *
 * 为什么需要：缺辅助功能/屏幕录制时，任务照跑，每条通道各自报错，最后被当成「真实失败」，
 * 用户看到的是「一堆任务挂了」而不是「请先授权」。这里在真正 spawn 任务之前做一次判断：
 *   - 任务不需要 AX/录屏 → 直接放行，连探测都不做（不浪费 ocu doctor 的启动开销）；
 *   - 需要但系统没授权 → 环境跳过（调用方按 exit 0 处理，绝不能记 FAIL），提示去对应的设置页；
 *   - 探测不出来（ocu doctor 失败/没装/超时）→ 放行 + warning，不能因为「查不到权限」把任务全卡死；
 *   - 显式 AGENT_ALLOW_MISSING_PERMISSION=1 → 放行并标注 forced（排障用）。
 *
 * 本模块是纯逻辑：不做任何 I/O、不跑 ocu、不读环境变量（env 由调用方转成 allowOverride）。
 * 权限探测通过注入的 probe / core/permissions.mjs 的 checkPermissions 适配，单测绝不真的探测。
 */
import { UI_ACTION_RE, OCU_APP_CALL_RE } from './safety-audit.mjs';
import { checkPermissions } from './permissions.mjs';

/** 两类会挡任务的权限 */
export const PERMISSION_KEYS = Object.freeze(['accessibility', 'screenCapture']);

/** 权限名 + 设置页路径 + 深链（提示指对设置页；深链只打印命令，不在这里执行） */
export const PERMISSION_SETTINGS = Object.freeze({
  accessibility: Object.freeze({
    name: '辅助功能',
    path: '系统设置 → 隐私与安全性 → 辅助功能',
    url: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
  }),
  screenCapture: Object.freeze({
    name: '屏幕录制',
    path: '系统设置 → 隐私与安全性 → 屏幕录制',
    url: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
  }),
});

/** 强制继续的开关（调用方读 env 后传 allowOverride；本模块不直接读 env） */
export const OVERRIDE_ENV = 'AGENT_ALLOW_MISSING_PERMISSION';

/** 任务源码里哪些写法算「需要屏幕录制」（ocu 截图 / 系统 screencapture；CDP 截图不算） */
const SCREEN_CAPTURE_NEED_RE = /include_screenshot\s*:\s*true|includeScreenshot\s*:\s*true|(?:^|[^A-Za-z])screencapture\b/;

/**
 * 剥掉 JS 注释（// 行注释与 /* 块注释），但**保留字符串/模板字符串里的内容**。
 *
 * 为什么需要：SCREEN_CAPTURE_NEED_RE 直接跑原始源码时，注释里一句「小窗画面来自 screencapture -l」
 * 就会让任务被误判「需要屏幕录制」（task-68 M3 实测 core/tasks/parallel-real-demo.mjs:9），
 * 仅缺录屏时该任务被 false skip。剥离时必须躲开引号，否则 URL 里的 //（https://…）会被当成注释截断。
 * 单引号/双引号/模板字符串按相同规则跳过（含反斜杠转义）；模板字符串里的注释不剥（内嵌 JXA 内容要保留）。
 *
 * @param {string} source
 * @returns {string} 去掉注释后的源码（块注释换成空，保留换行以便按行匹配）
 */
export function stripSourceComments(source) {
  const text = String(source || '');
  let out = '';
  let i = 0;
  let state = 'code'; // code | line | block | single | double | template
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (state === 'code') {
      if (ch === '/' && next === '/') { state = 'line'; i += 2; continue; }
      if (ch === '/' && next === '*') { state = 'block'; i += 2; continue; }
      out += ch;
      if (ch === "'") state = 'single';
      else if (ch === '"') state = 'double';
      else if (ch === String.fromCharCode(96)) state = 'template';
      i += 1;
      continue;
    }
    if (state === 'line') {
      if (ch === '\n') { out += ch; state = 'code'; }
      i += 1;
      continue;
    }
    if (state === 'block') {
      if (ch === '*' && next === '/') { state = 'code'; i += 2; continue; }
      if (ch === '\n') out += ch;
      i += 1;
      continue;
    }
    // 字符串内部：原样保留（含转义），直到闭合引号
    out += ch;
    if (ch === '\\') {
      if (next !== undefined) out += next;
      i += 2;
      continue;
    }
    if ((state === 'single' && ch === "'") ||
        (state === 'double' && ch === '"') ||
        (state === 'template' && ch === String.fromCharCode(96))) {
      state = 'code';
    }
    i += 1;
  }
  return out;
}

/**
 * 「把 ocu 的 js 子命令当子进程跑」的写法：execFile(OCU, ['js', ...]) / execFileSync / spawn / spawnSync。
 *
 * 为什么复用 OCU_APP_CALL_RE 还不够：那条正则匹配的是**内层脚本里的** cua.getApp/callTool，
 * 而有些任务把内层代码放在单独文件（*-inner.mjs），外层任务源码里只剩
 * execFile(OCU, ['js', '--timeout', …, '--file', innerPath])，不命中任何 OCU_APP_CALL_RE 模式。
 * 所以这里补一条窄正则，只匹配「子进程命令里出现独立参数 'js'」的写法，
 * 不匹配 'script.js' / '--js-flags=…' 这类普通参数（引号后必须紧跟 js 再紧跟引号）。
 */
const OCU_JS_CLI_RE = /(?:execFile|execFileSync|spawn|spawnSync)\s*\((?:[^\n]*\n){0,6}[^\n]*['"]js['"]/;

/**
 * 从任务源码静态推断它需要什么权限（纯函数）。
 *
 * 复用了 core/safety-audit.mjs 的两套模式，不维护第二份正则：
 *   - UI_ACTION_RE：ocu/AX/点击/输入/读界面；
 *   - OCU_APP_CALL_RE：补上 MCP 的 callTool 读界面工具、以及内层 cua.getApp 这类写法
 *     （mcp-demo 和「内层脚本放在单独文件」的任务就是这种，旧判定会漏掉）。
 * 另外补一条窄正则 OCU_JS_CLI_RE 识别「execFile(OCU, ['js', …])」外层调用（内层代码在单独文件时
 * 外层源码看不到 cua.getApp）；理由见该常量注释。
 * 屏幕录制单独判：只有 ocu 截图（include_screenshot）或系统 screencapture 才需要，
 * CDP 的 Page.captureScreenshot 不需要系统录屏权限。
 *
 * @param {string} source 任务源码
 * @returns {{accessibility:boolean, screenCapture:boolean}} 需要哪些权限
 */
export function inferTaskPermissionNeed(source) {
  const text = String(source || '');
  // AX 判定保持看原始源码（内嵌 JXA 脚本里的 cua.getApp/callTool 也算）；
  // 录屏判定先剥注释：注释里提一句 screencapture 不代表真的截图（M3）。
  const uncommented = stripSourceComments(text);
  return {
    accessibility: UI_ACTION_RE.test(text) || OCU_APP_CALL_RE.test(text) || OCU_JS_CLI_RE.test(text),
    screenCapture: SCREEN_CAPTURE_NEED_RE.test(uncommented),
  };
}

/**
 * core/permissions.mjs 的 checkPermissions() 结果 → 本模块的 perms 形状。
 * undefined = 探测不出来（不能让「查不到」变成「没授权」）。
 *
 * @param {{ok?:boolean, missing?:string[], platform?:string}|null} result
 * @returns {{accessibility:boolean|undefined, screenCapture:boolean|undefined}}
 */
export function permissionParamsFromCheckPermissions(result) {
  const unknown = { accessibility: undefined, screenCapture: undefined };
  const r = result && typeof result === 'object' ? result : null;
  if (!r) return unknown;
  if (r.platform === 'windows' || r.platform === 'win32') return { accessibility: true, screenCapture: true };
  const missing = Array.isArray(r.missing) ? r.missing : null;
  // 'unknown' 是 checkPermissions 对「读不到权限状态」的标记；结构不对也按探测不出来
  if (!missing || missing.includes('unknown')) return unknown;
  return {
    accessibility: !missing.includes('accessibility'),
    screenCapture: !missing.includes('screenCapture'),
  };
}

/**
 * 真探测一次权限（异步适配器；默认走 ocu doctor --json，不启动 onboarding、不弹框）。
 * 探测抛错/超时一律返回 undefined，交给 decidePermissionGate 走「不阻塞」分支。
 *
 * @param {Function} [checkFn] 注入 checkPermissions（测试用）
 * @returns {Promise<{accessibility:boolean|undefined, screenCapture:boolean|undefined}>}
 */
export async function probePermissions(checkFn) {
  const check = typeof checkFn === 'function' ? checkFn : checkPermissions;
  try {
    return permissionParamsFromCheckPermissions(await check());
  } catch {
    return { accessibility: undefined, screenCapture: undefined };
  }
}

function permissionList(keys) {
  return (Array.isArray(keys) ? keys : [])
    .filter((key) => PERMISSION_SETTINGS[key])
    .map((key) => PERMISSION_SETTINGS[key]);
}

/**
 * 权限闸门的核心判定（纯函数）。
 *
 * @param {{
 *   need?: {accessibility?:boolean, screenCapture?:boolean},
 *   perms?: {accessibility?:boolean|undefined, screenCapture?:boolean|undefined},
 *   allowOverride?: boolean,
 * }} [input]
 * @returns {{
 *   proceed: boolean, skipped: boolean, forced: boolean,
 *   need: object, missing: string[], unknown: string[],
 *   warning: string, skipReason: string,
 *   settings: Array<{name:string, path:string, url:string}>,
 * }}
 */
export function decidePermissionGate(input = {}) {
  const opts = input || {};
  const need = opts.need || {};
  const perms = opts.perms || {};
  const required = PERMISSION_KEYS.filter((key) => need[key] === true);

  const base = {
    proceed: true, skipped: false, forced: false,
    need: { accessibility: need.accessibility === true, screenCapture: need.screenCapture === true },
    missing: [], unknown: [], warning: '', skipReason: '', settings: [],
  };

  // 任务不需要任何敏感权限：直接放行，连探测结果都不看
  if (!required.length) return base;

  const missing = required.filter((key) => perms[key] === false);
  const unknown = required.filter((key) => perms[key] !== true && perms[key] !== false);

  if (missing.length) {
    const names = permissionList(missing);
    const detail = names.map((s) => s.name + '（' + s.path + '）').join('、');
    if (opts.allowOverride === true) {
      return Object.assign({}, base, {
        proceed: true, forced: true, missing, unknown,
        settings: names,
        warning: '注意：缺少' + detail + '，但已按 ' + OVERRIDE_ENV + '=1 强制继续（相关步骤可能失败）。',
      });
    }
    return Object.assign({}, base, {
      proceed: false, skipped: true, missing, unknown,
      settings: names,
      skipReason: '环境跳过：缺少' + detail + '。授权后重跑即可；临时忽略可设 ' + OVERRIDE_ENV + '=1。',
    });
  }

  if (unknown.length) {
    const names = permissionList(unknown);
    return Object.assign({}, base, {
      proceed: true, forced: false, missing: [], unknown,
      settings: names,
      warning: '注意：' + names.map((s) => s.name).join('、')
        + '权限状态探测不出来（ocu doctor 失败/未安装/超时），按不阻塞继续；'
        + '若任务报权限错误，请到 ' + names.map((s) => s.path).join('、') + ' 授权。',
    });
  }

  return base;
}

/**
 * 跳过时给调用方打印的行：第一行是跳过原因，后面每行指到对应设置页（附可直接执行的 open 命令）。
 * @param {object} decision decidePermissionGate 的返回值
 * @returns {string[]}
 */
export function permissionSkipLines(decision) {
  const d = decision || {};
  const lines = [];
  if (d.skipReason) lines.push(d.skipReason);
  for (const settings of d.settings || []) {
    lines.push('授权入口：' + settings.path + '（可执行：open "' + settings.url + '"）');
  }
  return lines;
}

/**
 * 读强制继续开关（保持 decidePermissionGate 本身不读 env，便于单测）。
 * 注入 env 时按注入值；生产路径用 process.env 字面量读取，这样 `npm run env:doc` 能把它收进
 * flow/TASK-ENV.md（用户排障时找得到），也避免文档与环境变量清单失配。
 */
export function overrideFromEnv(env) {
  if (env) return String(env[OVERRIDE_ENV] || '') === '1';
  return process.env.AGENT_ALLOW_MISSING_PERMISSION === '1';
}

/**
 * 任务级编排：静态推断 need → 按需探测 → 判定。纯编排，探测可注入。
 * 任务不需要敏感权限时返回 null（调用方直接放行，连探测都不做）。
 *
 * @param {{source?:string, perms?:object, probe?:Function, allowOverride?:boolean}} [options]
 * @returns {Promise<null|object>} null 或 decidePermissionGate 结果 + need
 */
export async function evaluateTaskPermissionGate(options = {}) {
  const opts = options || {};
  const need = inferTaskPermissionNeed(opts.source || '');
  if (!need.accessibility && !need.screenCapture) return null;

  let perms = opts.perms;
  if (perms === undefined) {
    if (typeof opts.probe === 'function') {
      try { perms = await opts.probe(); } catch { perms = { accessibility: undefined, screenCapture: undefined }; }
    } else {
      perms = await probePermissions();
    }
  }
  return Object.assign({ need }, decidePermissionGate({ need, perms, allowOverride: opts.allowOverride === true }));
}
