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

// ---------- macOS ----------

async function macFrontmostBundle() {
  const r = await run('/usr/bin/osascript', ['-e',
    'tell application "System Events" to get bundle identifier of first process whose frontmost is true']);
  return r.ok ? r.out : null;
}

async function macWindowBounds(processName) {
  const r = await run('/usr/bin/osascript', ['-e',
    'tell application "System Events" to tell process "' + processName + '" to get {position, size} of window 1']);
  if (!r.ok) return null;
  const nums = r.out.match(/-?\d+/g);
  if (!nums || nums.length < 4) return null;
  const [x, y, w, h] = nums.map(Number);
  return w > 0 && h > 0 ? { x, y, w, h } : null;
}

async function macWindowTitle(processName) {
  const r = await run('/usr/bin/osascript', ['-e',
    'tell application "System Events" to tell process "' + processName + '" to get name of window 1']);
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
function isScreenLocked() {
  if (!isMac) return false;
  try {
    const out = require('node:child_process').execFileSync('/usr/sbin/ioreg', ['-n', 'Root', '-d1'], { encoding: 'utf8', timeout: 3000 });
    const m = /CGSSessionScreenIsLocked"?\s*=\s*(Yes|No|true|false|1|0)/i.exec(out);
    return m ? /^(yes|true|1)$/i.test(m[1]) : false;
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
};