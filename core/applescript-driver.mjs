'use strict';
/**
 * AppleScript 通道：给"自带脚本字典"的应用多一条语义操作通道。
 *
 * 最容易踩的坑是授权：控制第三方应用需要「自动化」权限，没授权时 osascript 会弹系统授权框，
 * 而弹框会打断用户。所以这里先用系统 API AEDeterminePermissionToAutomateTarget（askUserIfNeeded=false）
 * 静默查权限，只在已经授权时才真正发 Apple 事件。
 *
 * 权限查询用一个小小的 C 程序（仓库不引入依赖，clang 是系统自带的），首次使用时编译并缓存到
 * ~/.desktop-agent/bin/ae-permission。
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { countSdefCommands } from './app-runtime.mjs';
import { executableTrust } from './safety.mjs';

const exec = promisify(execFile);

const HELPER_SOURCE = [
  '#include <ApplicationServices/ApplicationServices.h>',
  '#include <stdio.h>',
  '#include <string.h>',
  'int main(int argc, char** argv) {',
  '  if (argc < 2) return 2;',
  '  AEDesc target;',
  '  OSStatus create = AECreateDesc(typeApplicationBundleID, argv[1], strlen(argv[1]), &target);',
  '  if (create != noErr) { printf("-10000\\n"); return 0; }',
  '  OSStatus status = AEDeterminePermissionToAutomateTarget(&target, typeWildCard, typeWildCard, false);',
  '  printf("%d\\n", (int)status);',
  '  return 0;',
  '}',
].join('\n');

/** 权限状态码 → 可读状态（纯函数） */
export function parseAeStatus(code) {
  const n = Number(code);
  if (n === 0) return 'granted';
  if (n === -1744) return 'needs-consent';
  if (n === -1743) return 'denied';
  if (n === -600) return 'app-not-running';
  if (n === -10000) return 'unknown';
  return 'unknown';
}

/** osascript 的报错文本 → 分类（纯函数） */
export function classifyOsascriptError(stderr) {
  const text = String(stderr || '');
  if (/-1743|不允许发送 Apple 事件|not authorized|Not authorized/i.test(text)) return 'denied';
  if (/-1744|would require user consent|需要.*授权/i.test(text)) return 'needs-consent';
  if (/-1712|AppleEvent已超时|AppleEvent timed out|timed out/i.test(text)) return 'timeout';
  if (/-600|application isn.t running|不能获得.*application/i.test(text)) return 'app-not-running';
  return 'error';
}

/**
 * Safari「Allow JavaScript from Apple Events」是否可用（纯函数，按错误文本分类）。
 * 返回：disabled（设置里关着）/ no-document / not-running / denied / error
 */
export function classifySafariJsError(text) {
  const s = String(text || '');
  if (/Allow JavaScript from Apple Events/i.test(s) || /Developer section/i.test(s)) return 'disabled';
  if (/-1728|does not contain|no document|不包含|没有文档/i.test(s)) return 'no-document';
  if (/-600|application isn.t running|不能获得.*application/i.test(s)) return 'not-running';
  if (/-1743|不允许发送 Apple 事件|not authorized/i.test(s)) return 'denied';
  return 'error';
}

/**
 * 探测 Safari 的页面级 JS 通道（只执行 1+1，不碰用户数据）。
 *
 * 为什么需要：Safari 的网页内容不在 AX 树里，只能读浏览器壳；要读/点页面内容
 * 必须靠 Apple Events 注入 JS，而这条通道默认被 Safari 关着。
 * 探测一下能给出明确边界，而不是让调用方猜。
 *
 * @param {{exec?:Function, timeoutMs?:number}} [options]
 * @returns {Promise<{available:boolean, reason:string, result?:string, detail?:string}>}
 */
export async function checkSafariJavaScript(options = {}) {
  const opts = options || {};
  const run = opts.exec || exec;
  try {
    const { stdout } = await run('/usr/bin/osascript', ['-e', 'tell application "Safari" to do JavaScript "1+1" in front document'], { timeout: opts.timeoutMs || 5000 });
    return { available: true, reason: '', result: String(stdout || '').trim() };
  } catch (error) {
    const text = String((error && (error.stderr || error.message)) || error);
    return { available: false, reason: classifySafariJsError(text), detail: text.split('\n')[0].slice(0, 160) };
  }
}

/** 权限查询小程序的缓存路径 */
export function helperPath() {
  return path.join(os.homedir(), '.desktop-agent', 'bin', 'ae-permission');
}

/**
 * 确保权限查询小程序存在（不存在就编译一次）。
 * @returns {Promise<{ok:boolean, path:string, error?:string}>}
 */
export async function ensureHelper(options = {}) {
  const target = (options && options.path) || helperPath();
  const uid = typeof process.getuid === 'function' ? process.getuid() : -1;
  const deps = Object.assign({ exec, fs, uid }, (options && options.deps) || {});
  const stat = deps.stat || deps.fs.promises.stat;
  const chmod = deps.chmod || deps.fs.promises.chmod;

  // 1) 已经有文件：先验证它的归属和权限（防别人提前放一个可执行文件让我们跑）
  try {
    const info = await stat(target);
    const trust = executableTrust({ fileUid: info.uid, uid: deps.uid, mode: info.mode, exists: true });
    if (trust === 'ok') return { ok: true, path: target, trust };
    // 不可信的文件：不删除也不执行，直接编译覆盖（覆盖后仍是本用户的文件）
  } catch {}

  // 2) 目录本身必须可信：本用户所有且不能被他人写；否则拒绝在这里编译/执行
  const dir = path.dirname(target);
  try {
    await deps.fs.promises.mkdir(dir, { recursive: true });
    const dirInfo = await stat(dir);
    const dirTrust = executableTrust({ fileUid: dirInfo.uid, uid: deps.uid, mode: dirInfo.mode, exists: true });
    if (dirTrust !== 'ok') {
      return { ok: false, path: target, error: '缓存目录不可信（' + dirTrust + '）：' + dir };
    }
  } catch (e) {
    return { ok: false, path: target, error: '创建缓存目录失败：' + String(e && e.message || e).slice(0, 80) };
  }

  // 3) 编译到临时文件再改名，避免用到"编译了一半"的文件
  const tmpTarget = target + '.tmp-' + (typeof process.pid === 'number' ? process.pid : '0');
  const src = target + '.c';
  try {
    await deps.fs.promises.writeFile(src, HELPER_SOURCE, 'utf8');
    await deps.exec('/usr/bin/clang', ['-O2', '-framework', 'ApplicationServices', '-o', tmpTarget, src], { timeout: 60000 });
    await chmod(tmpTarget, 0o755);
    await deps.fs.promises.rename(tmpTarget, target);
    return { ok: true, path: target, trust: 'recompiled' };
  } catch (e) {
    try { await deps.fs.promises.rm(tmpTarget, { force: true }); } catch {}
    return { ok: false, path: target, error: String(e && e.message || e).slice(0, 120) };
  } finally {
    try { await deps.fs.promises.rm(src, { force: true }); } catch {}
  }
}

/**
 * 静默查某个应用的自动化授权状态（不会弹授权框）。
 * @param {{bundleId:string}} app
 * @returns {Promise<{status:string, code:number|null, error?:string}>}
 */
export async function checkAutomationPermission(app, options = {}) {
  const opts = options || {};
  const deps = Object.assign({ exec, ensureHelper }, opts.deps || {});
  const bundle = String((app && app.bundleId) || '');
  if (!bundle) return { status: 'unknown', code: null, error: '缺少 bundle id' };
  const helper = await deps.ensureHelper(opts);
  if (!helper.ok) return { status: 'unknown', code: null, error: '权限查询程序不可用：' + (helper.error || '') };
  try {
    const { stdout } = await deps.exec(helper.path, [bundle], { timeout: 8000 });
    const code = Number.parseInt(String(stdout).trim(), 10);
    if (!Number.isFinite(code)) return { status: 'unknown', code: null, error: '返回不可解析：' + String(stdout).slice(0, 40) };
    return { status: parseAeStatus(code), code };
  } catch (e) {
    return { status: 'unknown', code: null, error: String(e && e.message || e).slice(0, 120) };
  }
}

/**
 * 把脚本返回的 URL 脱敏成「协议 + 主机」，避免把用户的完整链接写进报告（纯函数）。
 * @param {string} url
 * @returns {string}
 */
export function redactUrl(url) {
  const text = String(url || '').trim();
  if (!text) return '';
  try {
    const u = new URL(text);
    if (u.protocol === 'file:') return 'file://' + (u.pathname ? '/…' : '');
    return u.protocol + '//' + u.host + '/…';
  } catch {
    return text.length > 24 ? text.slice(0, 12) + '…' : text;
  }
}

/** 读应用包里的脚本字典命令数（没有字典就是 0） */
export async function bundleSdefCommands(appPath) {
  try {
    const resDir = path.join(appPath, 'Contents', 'Resources');
    const entries = await fs.promises.readdir(resDir);
    let commands = 0;
    for (const f of entries.filter((x) => /\.sdef$/i.test(x))) {
      try {
        commands += countSdefCommands(await fs.promises.readFile(path.join(resDir, f), 'utf8'));
      } catch {}
    }
    return commands;
  } catch {
    return 0;
  }
}

/**
 * 发一段 AppleScript 给某个应用（调用前会查授权，没授权就不发，避免弹框）。
 * @param {{appName:string, bundleId:string, script:string, requirePermission?:boolean, timeoutMs?:number}} options
 * @returns {Promise<{ok:boolean, output?:string, status?:string, error?:string}>}
 */
export async function runAppScript(options = {}) {
  const opts = options || {};
  const deps = Object.assign({ exec, checkAutomationPermission }, opts.deps || {});
  const appName = String(opts.appName || '');
  const script = String(opts.script || '');
  if (!appName || !script) return { ok: false, status: 'error', error: '缺少应用名或脚本' };
  if (opts.requirePermission !== false && opts.bundleId) {
    const permission = await deps.checkAutomationPermission({ bundleId: opts.bundleId }, opts);
    if (permission.status !== 'granted') {
      return { ok: false, status: permission.status, error: '未授权自动化（' + permission.status + '），不发送 Apple 事件以免弹授权框' };
    }
  }
  const full = 'with timeout of ' + Math.ceil((opts.timeoutMs || 8000) / 1000) + ' seconds\n' + script + '\nend timeout';
  try {
    const { stdout } = await deps.exec('/usr/bin/osascript', ['-e', full], { timeout: (opts.timeoutMs || 8000) + 2000 });
    return { ok: true, status: 'ok', output: String(stdout).trim() };
  } catch (e) {
    const stderr = String((e && (e.stderr || e.message)) || '');
    const status = classifyOsascriptError(stderr);
    return { ok: false, status, error: stderr.split('\n').filter(Boolean).slice(-1)[0] || status };
  }
}
