'use strict';
/**
 * 前台应用读取（H2 核心）。
 *
 * 老实现：osascript 对 System Events 发 AppleEvent 问「谁是前台」。
 *   - 新机器/未授权时第一次会弹「自动化」授权框；
 *   - 每次约 120ms，而 frontName() 是几乎所有后台操作的第一步（读写前后各一次）。
 *
 * 新实现：osascript -l JavaScript + ObjC 桥，在进程内问 NSWorkspace.frontmostApplication。
 *   ObjC 桥不需要自动化授权，也不发 AppleEvent。
 *
 * 安全红线（front 保护全靠这个名字，错一次比慢一百倍更糟）：
 *   1. 新实现任何不确定（失败/超时/输出解析不了/名字不合法）→ 回退老实现；
 *   2. 新实现只在 auto 模式下作为快路径，失败一律回退；
 *   3. 名字必须和旧实现同语义 —— 见下面「为什么用 executableName」。
 *
 * 为什么用 executableName 而不是 localizedName（实测踩过的坑）：
 *   旧实现（System Events）返回的是**进程名**（Finder / Calculator / Google Chrome）。
 *   而 NSRunningApplication.localizedName 是**本地化显示名**（访达 / 计算器 / 通知中心）。
 *   本机实测 108 个在跑的应用里有 63 个两者不一致；如果新实现返回 localizedName，
 *   frontName() 的返回值会从 "Finder" 变成 "访达"，所有下游比较
 *   （front-watch / restoreFront / TEST_APPS 匹配 / M-2 的 touched 判定）都会悄悄失效。
 *   所以：name 取 executableURL.lastPathComponent；localizedName 只作诊断字段返回。
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** 老实现失败时的历史返回值（background.mjs 的 frontName 语义） */
export const UNKNOWN_FRONT = '(unknown)';

/** 新实现硬上限：不能拖慢每次读写（老实现正常约 120ms） */
export const OBJC_TIMEOUT_MS = 400;
/** 旧实现的超时，保持历史值不变 */
export const APPLESCRIPT_TIMEOUT_MS = 4000;

export const FRONT_READ_MODES = ['objc', 'applescript', 'auto'];

/** 老实现的 AppleScript：向 System Events 发 AppleEvent */
export const APPLESCRIPT_SOURCE = 'tell application "System Events" to get name of first process whose frontmost is true';

/**
 * JXA 脚本（纯函数返回字符串，便于单测）：
 * 读 NSWorkspace 前台应用，返回 JSON。取 executableURL.lastPathComponent（进程名）。
 */
export function buildObjcScript() {
  return [
    "ObjC.import('AppKit');",
    'function run() {',
    '  try {',
    '    var app = $.NSWorkspace.sharedWorkspace.frontmostApplication;',
    '    if (!app) return "";',
    '    var url = app.executableURL;',
    '    var execName = ObjC.unwrap(url && url.lastPathComponent);',
    '    var localized = ObjC.unwrap(app.localizedName);',
    '    var bundleId = ObjC.unwrap(app.bundleIdentifier);',
    '    return JSON.stringify({',
    '      name: execName ? String(execName) : "",',
    '      localizedName: localized ? String(localized) : "",',
    '      bundleId: bundleId ? String(bundleId) : ""',
    '    });',
    '  } catch (e) { return ""; }',
    '}',
    'run();',
  ].join(String.fromCharCode(10));
}

/** objc 实现的命令行参数（纯函数） */
export function objcArgs() {
  return ['-l', 'JavaScript', '-e', buildObjcScript()];
}

/** 老实现的命令行参数（纯函数） */
export function applescriptArgs() {
  return ['-e', APPLESCRIPT_SOURCE];
}

/**
 * 名字清洗（纯函数）：去掉换行/制表符、去首尾空白；空名字、超长、含控制字符一律判为不合法。
 * 宁可返回空（走回退），也不能把一个可疑字符串当前台应用名。
 */
export function sanitizeFrontName(value) {
  const name = String(value == null ? '' : value).replace(/[\r\n\t]+/g, ' ').trim();
  if (!name) return '';
  if (name.length > 200) return '';
  if (/[\u0000-\u001f\u007f]/.test(name)) return '';
  return name;
}

/**
 * 解析 JXA 输出（纯函数）。
 * @returns {{name:string, bundleId:string, localizedName:string}|null} null = 不可用
 */
export function parseObjcOutput(stdout) {
  const text = String(stdout == null ? '' : stdout).trim();
  if (!text) return null;
  let data = null;
  try { data = JSON.parse(text); } catch { return null; }
  if (!data || typeof data !== 'object') return null;
  const name = sanitizeFrontName(data.name);
  // name 必须是「进程名」且合法；拿不到就判失败 → 调用方回退老实现
  if (!name) return null;
  return {
    name,
    bundleId: String(data.bundleId == null ? '' : data.bundleId).trim(),
    localizedName: String(data.localizedName == null ? '' : data.localizedName).trim(),
  };
}

/** 解析老实现输出（纯函数）；空/非法返回空串 */
export function parseAppleScriptOutput(stdout) {
  return sanitizeFrontName(stdout);
}

/** 读环境变量决定实现：objc | applescript | auto（默认 auto；认不出的取值也回退 auto） */
export function resolveFrontReadMode(env = process.env) {
  const raw = String((env && env.AGENT_FRONT_READ) || '').trim().toLowerCase();
  if (!raw) return 'auto';
  return FRONT_READ_MODES.indexOf(raw) >= 0 ? raw : 'auto';
}

function errorReason(error) {
  if (!error) return 'unknown';
  if (error.killed || error.signal === 'SIGTERM') return 'timeout';
  if (error.code === 'ETIMEDOUT') return 'timeout';
  return String(error.code || error.name || 'error');
}

function pickExec(options) {
  return (options && typeof options.exec === 'function') ? options.exec : execFileAsync;
}

/** 锁屏时 NSWorkspace 报的不是用户前台应用，而是登录窗口的占位名 */
export const LOCKED_FRONT_NAMES = Object.freeze(['loginwindow']);

/**
 * 锁屏占位名判定（纯函数）。
 *
 * 实测（2026-11-08 锁屏期间）：ObjC 的 NSWorkspace.frontmostApplication 返回 "loginwindow"，
 * 而老实现（System Events）返回的是「登录后仍然是前台的那个应用」（DeepSeek Harness）。
 * 对前台保护来说后者才对：不然任务跑到一半锁屏，会把 front 从真实应用翻成 loginwindow，
 * guard/还原/验收基线都会误判成「前台被换了」。
 * 所以 auto 模式下遇到占位名要回退老实现；显式 mode=objc 时保留原值（排障用）。
 */
export function isLockedFrontName(name) {
  const value = String(name == null ? '' : name).trim().toLowerCase();
  return LOCKED_FRONT_NAMES.includes(value);
}

/**
 * 新实现：JXA + ObjC 读前台（不发 AppleEvent）。
 * 永不抛异常，失败返回 { ok:false, error }。
 * @returns {Promise<{ok:boolean, name:string, bundleId:string, localizedName:string, error:string}>}
 */
export async function readViaObjc(options = {}) {
  const opts = options || {};
  const timeout = Number.isFinite(opts.objcTimeoutMs) ? opts.objcTimeoutMs : OBJC_TIMEOUT_MS;
  const exec = pickExec(opts);
  try {
    const result = await exec('/usr/bin/osascript', objcArgs(), { timeout });
    const parsed = parseObjcOutput(result && result.stdout);
    if (!parsed) return { ok: false, name: '', bundleId: '', localizedName: '', error: 'unparsable-output' };
    return { ok: true, name: parsed.name, bundleId: parsed.bundleId, localizedName: parsed.localizedName, error: '' };
  } catch (error) {
    return { ok: false, name: '', bundleId: '', localizedName: '', error: errorReason(error) };
  }
}

/**
 * 旧实现：osascript + System Events（AppleEvent）。永不抛异常。
 * @returns {Promise<{ok:boolean, name:string, error:string}>}
 */
export async function readViaAppleScript(options = {}) {
  const opts = options || {};
  const timeout = Number.isFinite(opts.appleTimeoutMs) ? opts.appleTimeoutMs : APPLESCRIPT_TIMEOUT_MS;
  const exec = pickExec(opts);
  try {
    const result = await exec('/usr/bin/osascript', applescriptArgs(), { timeout });
    const name = parseAppleScriptOutput(result && result.stdout);
    if (!name) return { ok: false, name: '', error: 'empty-output' };
    return { ok: true, name, error: '' };
  } catch (error) {
    return { ok: false, name: '', error: errorReason(error) };
  }
}

/**
 * 带来源信息的读取（新实现的正式入口）。
 *
 * auto（默认）：先 objc（400ms 上限）→ 成功就用；失败/超时/输出不可解析 → 回退 applescript。
 * objc：只用新实现（排障用），失败返回空名字，让调用方走 '(unknown)'。
 * applescript：只用旧实现（回滚开关）。
 *
 * @returns {Promise<{name:string, source:'objc'|'applescript'|'', mode:string, fallbackReason:string}>}
 */
export async function readFrontNameDetailed(options = {}) {
  const opts = options || {};
  const mode = opts.mode || resolveFrontReadMode(opts.env || process.env);

  if (mode === 'applescript') {
    const apple = await readViaAppleScript(opts);
    return { name: apple.name, source: apple.ok ? 'applescript' : '', mode, fallbackReason: apple.ok ? '' : apple.error };
  }

  const objc = await readViaObjc(opts);
  const lockedFront = objc.ok && isLockedFrontName(objc.name);
  if (objc.ok && !lockedFront) return { name: objc.name, source: 'objc', mode, fallbackReason: '' };
  if (mode === 'objc') {
    return objc.ok
      ? { name: objc.name, source: 'objc', mode, fallbackReason: lockedFront ? 'locked-front-diagnostic' : '' }
      : { name: '', source: '', mode, fallbackReason: objc.error };
  }

  // 不确定就回退：慢一点没关系，返回错名字才是事故。
  // 锁屏时的 "loginwindow" 也算「不可用」——它不代表用户真实前台，必须回退老实现取真实值。
  const apple = await readViaAppleScript(opts);
  return {
    name: apple.name,
    source: apple.ok ? 'applescript' : '',
    mode,
    fallbackReason: lockedFront ? 'locked-front' : (objc.error || 'objc-unavailable'),
  };
}

/** 只要名字（失败返回空串，由调用方决定 '(unknown)'） */
export async function readFrontName(options = {}) {
  const detail = await readFrontNameDetailed(options);
  return detail.name;
}

/**
 * 自检用：两种实现各跑一次，比较结果与耗时（只读，不发 AppleEvent 的 objc 侧除外——
 * applescript 侧会发 AppleEvent，只在确认已授权时跑）。
 */
export async function compareReaders(options = {}) {
  const t0 = Date.now();
  const objc = await readViaObjc(options);
  const objcMs = Date.now() - t0;
  const t1 = Date.now();
  const apple = await readViaAppleScript(options);
  const appleMs = Date.now() - t1;
  return {
    objcName: objc.name,
    objcError: objc.error,
    objcMs,
    appleName: apple.name,
    appleError: apple.error,
    appleMs,
    same: Boolean(objc.ok && apple.ok && objc.name === apple.name),
  };
}
