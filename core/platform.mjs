'use strict';

/**
 * 平台抽象（Node 侧）：解析控制后端、路径、服务管理命令。
 * 控制后端统一走 ocu（官方支持 macOS 与 Windows）；UIA 桥是没有 ocu 时的兜底。
 */
import os from 'node:os';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 随包附带的 ocu（打包成单 App 时用） */
export function bundledOcu() {
  const cand = path.join(HERE, '..', 'third_party', 'open-computer-use', 'bin', 'ocu');
  return existsSync(cand) ? cand : null;
}

export const isMac = process.platform === 'darwin';
export const isWindows = process.platform === 'win32';
export const platform = process.platform;

/**
 * 控制后端：ocu 官方支持 macOS 与 Windows（dist/windows 有原生运行时），
 * 所以两边都优先用 ocu；UIA 桥仅作为没有 ocu 时的兜底方案。
 */
export function controlBackend() {
  if (isMac || isWindows) return 'ocu';
  return 'unsupported';
}

/** ocu 可执行文件路径（macOS 与 Windows 都有 npm 全局安装） */
export function resolveOcu() {
  if (process.env.OCU_BIN) return process.env.OCU_BIN;
  const bundled = bundledOcu();
  if (bundled) return bundled;
  if (isMac) return path.join(os.homedir(), '.local/bin/ocu');
  if (isWindows) {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    const cand = path.join(appData, 'npm', 'ocu.cmd');
    return existsSync(cand) ? cand : 'ocu.cmd'; // 退回 PATH 查找
  }
  return null;
}

export function requireOcu() {
  const bin = resolveOcu();
  if (!bin) {
    throw new Error('当前平台（' + process.platform + '）没有 ocu 控制后端；macOS/Windows 请先 npm i -g open-computer-use，见 flow/CROSS-PLATFORM.md');
  }
  return bin;
}

/**
 * 屏幕是否锁屏（仅 macOS）。
 * 锁屏后 Chrome 等 GUI 应用启动会慢一个数量级，任务超时需要相应放宽。
 */
export function isScreenLocked() {
  if (!isMac) return false;
  try {
    const out = execFileSync('/usr/sbin/ioreg', ['-n', 'Root', '-d1'], { encoding: 'utf8', timeout: 3000 });
    // ioreg 输出形如 "CGSSessionScreenIsLocked" = Yes / No，必须看值，不能只看键在不在
    const m = /CGSSessionScreenIsLocked"?\s*=\s*(Yes|No|true|false|1|0)/i.exec(out);
    if (!m) return false;
    return /^(yes|true|1)$/i.test(m[1]);
  } catch {
    return false;
  }
}

/** 当前前台应用名（跨平台，失败返回空串） */
export function readFrontmostApp() {
  return new Promise((resolve) => {
    if (isMac) {
      execFile('/usr/bin/osascript', ['-e',
        'tell application "System Events" to get name of first application process whose frontmost is true'],
        { timeout: 5000, encoding: 'utf8' },
        (err, stdout) => resolve(err ? '' : String(stdout || '').trim()));
      return;
    }
    if (isWindows) {
      const script = [
        'Add-Type @"',
        'using System; using System.Runtime.InteropServices; using System.Diagnostics;',
        'public class F { [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
        ' [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid); }',
        '"@',
        '$h = [F]::GetForegroundWindow(); $pid2 = 0; [void][F]::GetWindowThreadProcessId($h, [ref]$pid2);',
        'try { (Get-Process -Id $pid2).ProcessName } catch { "" }',
      ].join('\n');
      execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 6000 }, (err, stdout) =>
        resolve(err ? '' : String(stdout || '').trim()));
      return;
    }
    resolve('');
  });
}

/** 用户数据目录（跨平台） */
export function dataDir(name) {
  if (isMac) return path.join(os.homedir(), '.desktop-agent', name);
  if (isWindows) return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'desktop-agent', name);
  return path.join(os.homedir(), '.desktop-agent', name);
}

/** 调用 PowerShell（仅 Windows） */
export function runPowerShell(script, timeout = 15000) {
  return new Promise((resolve, reject) => {
    if (!isWindows) return reject(new Error('runPowerShell 只在 Windows 上可用'));
    execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      resolve(stdout);
    });
  });
}

export default { isMac, isWindows, platform, controlBackend, resolveOcu, requireOcu, dataDir, runPowerShell, readFrontmostApp, isScreenLocked };