'use strict';

/**
 * 平台抽象层（overlay 侧，CommonJS）。
 * macOS 用 osascript + screencapture；Windows 用 PowerShell + User32 + PrintWindow。
 * 两边导出同一组函数，main.js 只调这里，不再直接写死命令。
 */

const { execFile } = require('node:child_process');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { psQuote, psLikeContains, hwndExpression } = require('./ps-quote.js');
const { appleScriptQuote } = require('./quote.js');

const isMac = process.platform === 'darwin';
const isWindows = process.platform === 'win32';

function run(cmd, args, timeout = 3000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      resolve({ ok: !err, out: (stdout || '').trim(), err });
    });
  });
}

function runPowerShell(script, timeout = 8000) {
  return run('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], timeout);
}

// ---------- 屏幕录制权限（静默预检 + 纯判定） ----------

const SCREEN_RECORDING_MISSING_MESSAGE = '缺少屏幕录制权限';

/**
 * 根据静默预检结果决定是否允许抓图（纯函数，便于单测）。
 *
 * 约定：
 *   granted === true  → granted
 *   granted === false → permission-missing，不抓图（否则 screencapture 可能弹授权框）
 *   其它（null/undefined）→ unknown，继续尝试抓图（拿不到结论不能卡死抓帧）
 *   非 macOS → not-needed，Windows 抓图不需要这个权限
 *
 * @param {{granted?:boolean|null, platform?:string}} [input]
 * @returns {{status:'granted'|'permission-missing'|'unknown'|'not-needed', granted:boolean|null, proceed:boolean, message:string}}
 */
function decideCapturePermission(input = {}) {
  const { granted, platform = process.platform } = input || {};
  if (platform !== 'darwin') {
    return { status: 'not-needed', granted: true, proceed: true, message: '' };
  }
  if (granted === true) {
    return { status: 'granted', granted: true, proceed: true, message: '' };
  }
  if (granted === false) {
    return { status: 'permission-missing', granted: false, proceed: false, message: SCREEN_RECORDING_MISSING_MESSAGE };
  }
  return { status: 'unknown', granted: null, proceed: true, message: '' };
}

/**
 * 根据 CGWindowList 的窗口标题空值率判断「可能缺屏幕录制权限」（纯函数，M2）。
 *
 * macOS 无屏幕录制权限时 kCGWindowName 会是空串，表现为「找不到窗口/画面失败」。
 * 全空最可疑；部分为空时按 limitRatio 阈值标记，避免误报。
 *
 * @param {{titles?:Array<*>, limitRatio?:number}} [input]
 * @returns {{status:'no-windows'|'all-empty'|'mostly-empty'|'partial-empty'|'normal',
 *            total:number, empty:number, emptyRatio:number, allEmpty:boolean,
 *            suspectPermission:boolean, message:string}}
 */
function classifyWindowTitles(input = {}) {
  const { titles, limitRatio = 0.5 } = input || {};
  const list = Array.isArray(titles) ? titles.map((t) => String(t == null ? '' : t).trim()) : [];
  const total = list.length;
  if (total === 0) {
    return {
      status: 'no-windows', total: 0, empty: 0, emptyRatio: 0,
      allEmpty: false, suspectPermission: false, message: '',
    };
  }

  const empty = list.filter((t) => t === '').length;
  const emptyRatio = empty / total;
  const limit = Number.isFinite(Number(limitRatio))
    ? Math.min(1, Math.max(0, Number(limitRatio)))
    : 0.5;
  const base = { total, empty, emptyRatio: Math.round(emptyRatio * 1000) / 1000 };

  if (empty === total) {
    return Object.assign({
      status: 'all-empty',
      allEmpty: true,
      suspectPermission: true,
      message: '窗口标题全部为空，可能缺少屏幕录制权限',
    }, base);
  }
  if (emptyRatio >= limit) {
    return Object.assign({
      status: 'mostly-empty',
      allEmpty: false,
      suspectPermission: true,
      message: empty + '/' + total + ' 个窗口标题为空，可能缺少屏幕录制权限',
    }, base);
  }
  if (empty > 0) {
    return Object.assign({
      status: 'partial-empty',
      allEmpty: false,
      suspectPermission: false,
      message: '',
    }, base);
  }
  return Object.assign({
    status: 'normal',
    allEmpty: false,
    suspectPermission: false,
    message: '',
  }, base);
}

/**
 * 静默预检屏幕录制权限：CGPreflightScreenCaptureAccess 只读、不会弹授权框。
 * 返回 granted=null 表示拿不到结论（未知），由 decideCapturePermission 放行抓图。
 *
 * @param {{timeoutMs?:number}} [options]
 * @returns {Promise<{granted:boolean|null, detail?:string}>}
 */
async function checkScreenRecordingPermission(options = {}) {
  if (!isMac) return { granted: true, detail: 'not-needed' };
  const timeoutMs = Number(options && options.timeoutMs) || 2000;
  const script =
    'ObjC.import("CoreGraphics");' +
    'let granted=null;' +
    'try { granted = Number($.CGPreflightScreenCaptureAccess()) === 1; } catch (e) { granted = null; }' +
    'JSON.stringify({ granted: granted });';
  const r = await run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script], timeoutMs);
  if (!r.ok) return { granted: null, detail: 'preflight 失败（不阻断抓图）' };
  try {
    const data = JSON.parse(String(r.out));
    if (typeof data.granted === 'boolean') return { granted: data.granted };
  } catch {}
  return { granted: null, detail: 'preflight 输出无法解析（不阻断抓图）' };
}

// ---------- macOS ----------

async function macFrontmostBundle() {
  const r = await run('/usr/bin/osascript', ['-e',
    'tell application "System Events" to get bundle identifier of first process whose frontmost is true']);
  return r.ok ? r.out : null;
}

async function macWindowBounds(processName) {
  const r = await run('/usr/bin/osascript', ['-e',
    'tell application "System Events" to tell process ' + appleScriptQuote(processName) + ' to get {position, size} of window 1']);
  if (!r.ok) return null;
  const nums = r.out.match(/-?\d+/g);
  if (!nums || nums.length < 4) return null;
  const [x, y, w, h] = nums.map(Number);
  return w > 0 && h > 0 ? { x, y, w, h } : null;
}

async function macWindowTitle(processName) {
  const r = await run('/usr/bin/osascript', ['-e',
    'tell application "System Events" to tell process ' + appleScriptQuote(processName) + ' to get name of window 1']);
  return r.ok ? r.out : null;
}

async function macCaptureWindow(windowId, outPath) {
  const r = await run('/usr/sbin/screencapture', ['-x', '-o', '-l', String(windowId), outPath], 5000);
  if (!r.ok) throw new Error('screencapture 失败: ' + (r.err && r.err.message));
  return fsp.readFile(outPath);
}

// ---------- Windows ----------

const PS_WIN32_FRONT = [
  'Add-Type @"',
  'using System; using System.Runtime.InteropServices; using System.Diagnostics;',
  'public class W { [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
  ' [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid); }',
  '"@',
  '$h = [W]::GetForegroundWindow(); $pid2 = 0; [void][W]::GetWindowThreadProcessId($h, [ref]$pid2);',
  'try { (Get-Process -Id $pid2).ProcessName } catch { "" }'
].join('\n');

const PS_WIN32_BOUNDS = (processName) => [
  'Add-Type @"',
  'using System; using System.Runtime.InteropServices;',
  'public struct RECT { public int Left, Top, Right, Bottom; }',
  'public class W { [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r); }',
  '"@',
  '$p = Get-Process -Name ' + psQuote(processName) + ' -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1',
  'if (-not $p) { exit 0 }',
  '$r = New-Object RECT',
  '[void][W]::GetWindowRect($p.MainWindowHandle, [ref]$r)',
  '"$($r.Left) $($r.Top) $($r.Right - $r.Left) $($r.Bottom - $r.Top)"'
].join('\n');

const PS_WIN32_CAPTURE = (hwndExpr, outPath) => [
  'Add-Type -AssemblyName System.Drawing',
  'Add-Type @"',
  'using System; using System.Runtime.InteropServices;',
  'public struct RECT { public int Left, Top, Right, Bottom; }',
  'public class W { [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);',
  ' [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags); }',
  '"@',
  '$h = ' + hwndExpr,
  '$r = New-Object RECT; [void][W]::GetWindowRect($h, [ref]$r)',
  '$w = $r.Right - $r.Left; $hh = $r.Bottom - $r.Top',
  'if ($w -le 0 -or $hh -le 0) { exit 1 }',
  '$bmp = New-Object System.Drawing.Bitmap $w, $hh',
  '$g = [System.Drawing.Graphics]::FromImage($bmp)',
  '$hdc = $g.GetHdc()',
  '[void][W]::PrintWindow($h, $hdc, 2)',
  '$g.ReleaseHdc($hdc); $g.Dispose()',
  '$bmp.Save(' + psQuote(outPath) + ', [System.Drawing.Imaging.ImageFormat]::Png)',
  '$bmp.Dispose()'
].join('\n');

async function win32Hwnd(processName) {
  // 一律用单引号字符串 + 转义，避免进程名/标题里的 $(...) 被当成命令执行
  const r = await runPowerShell('(Get-Process -Name ' + psQuote(processName) + ' -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1).MainWindowHandle');
  return r.ok ? r.out : '';
}

async function win32WindowTitle(processName) {
  const script = '$p = Get-Process -Name ' + psQuote(processName) + ' -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle } | Select-Object -First 1; if ($p) { $p.MainWindowTitle }';
  const r = await runPowerShell(script, 6000);
  return r.ok && r.out ? r.out : null;
}

async function win32Frontmost() {
  const r = await runPowerShell(PS_WIN32_FRONT, 6000);
  return r.ok && r.out ? r.out : null;
}

async function win32WindowBounds(processName) {
  const r = await runPowerShell(PS_WIN32_BOUNDS(processName), 6000);
  if (!r.ok || !r.out) return null;
  const n = r.out.split(/\s+/).map(Number);
  if (n.length < 4 || !(n[2] > 0)) return null;
  return { x: n[0], y: n[1], w: n[2], h: n[3] };
}

async function win32HwndByTitle(title) {
  if (!title) return '';
  // 标题来自外部（/window 的 title），必须按单引号字符串转义后再拼进脚本
  const r = await runPowerShell('(Get-Process | Where-Object { $_.MainWindowTitle -like ' + psLikeContains(title) + ' } | Select-Object -First 1).MainWindowHandle');
  return r.ok ? r.out : '';
}

async function win32CaptureWindow(windowId, outPath, hints) {
  // Windows 上 windowId 来自 desktopCapturer 的序号，不是 HWND；优先按窗口标题反查
  const byTitle = hints && hints.title ? await win32HwndByTitle(hints.title) : '';
  const byId = hwndExpression(windowId);
  // byTitle 来自 PowerShell 输出，也按白名单校验，只接受 0x 十六进制
  const fromTitle = /^0x[0-9a-f]+$/i.test(String(byTitle || '').trim()) ? String(byTitle).trim() : '';
  const hwndExpr = fromTitle || byId || await win32Hwnd('Electron');
  const r = await runPowerShell(PS_WIN32_CAPTURE(hwndExpr, outPath), 8000);
  if (!r.ok) throw new Error('PrintWindow 失败: ' + (r.err && r.err.message));
  return fsp.readFile(outPath);
}

// ---------- 对外统一接口 ----------

function tempPath(ext) {
  return path.join(os.tmpdir(), 'overlay-cap-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + ext);
}

/** 屏幕是否锁屏（仅 macOS）：锁屏时抓帧会失败、应用启动变慢，健康检查里要能看出来 */
/** 解析 ioreg 的锁屏标记（与 core/platform.mjs 的 parseScreenLocked 保持一致，带一致性单测） */
function parseScreenLocked(output) {
  const text = String(output || '');
  if (/<key>CGSSessionScreenIsLocked<\/key>\s*<true\s*\/?>/i.test(text)) return true;
  if (/<key>CGSSessionScreenIsLocked<\/key>\s*<false\s*\/?>/i.test(text)) return false;
  const m = /CGSSessionScreenIsLocked"?\s*=\s*(Yes|No|true|false|1|0)/i.exec(text);
  if (!m) return false;
  return /^(yes|true|1)$/i.test(m[1]);
}

function isScreenLocked() {
  if (!isMac) return false;
  try {
    const out = require('node:child_process').execFileSync('/usr/sbin/ioreg', ['-n', 'Root', '-d1'], { encoding: 'utf8', timeout: 3000 });
    return parseScreenLocked(out);
  } catch { return false; }
}

async function readFrontmostApp() {
  if (isMac) return { bundle: await macFrontmostBundle() };
  if (isWindows) return { bundle: await win32Frontmost() };
  return { bundle: null };
}

async function readWindowBounds(processName) {
  if (isMac) return macWindowBounds(processName);
  if (isWindows) return win32WindowBounds(processName);
  return null;
}

async function readWindowTitle(processName) {
  if (isMac) return macWindowTitle(processName);
  if (isWindows) return win32WindowTitle(processName);
  return null;
}

async function captureWindow(windowId, hints) {
  const out = tempPath('.png');
  try {
    if (isMac) return await macCaptureWindow(windowId, out);
    if (isWindows) return await win32CaptureWindow(windowId, out, hints);
    throw new Error('不支持的平台: ' + process.platform);
  } finally {
    fsp.rm(out, { force: true }).catch(() => {});
  }
}

module.exports = {
  isMac,
  isWindows,
  platform: process.platform,
  readFrontmostApp,
  readWindowBounds,
  readWindowTitle,
  captureWindow,
  isScreenLocked,
  parseScreenLocked,
  SCREEN_RECORDING_MISSING_MESSAGE,
  decideCapturePermission,
  classifyWindowTitles,
  checkScreenRecordingPermission,
};