'use strict';

/**
 * 平台抽象（Node 侧）：解析控制后端、路径、服务管理命令。
 * macOS 用 ocu（Accessibility）；Windows 计划用 UI Automation，目前是预留。
 */
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';

export const isMac = process.platform === 'darwin';
export const isWindows = process.platform === 'win32';
export const platform = process.platform;

/** 控制后端：macOS=ocu，Windows=uia（未实现），其它=unsupported */
export function controlBackend() {
  if (isMac) return 'ocu';
  if (isWindows) return 'uia';
  return 'unsupported';
}

/** ocu 可执行文件路径（仅 macOS） */
export function resolveOcu() {
  if (process.env.OCU_BIN) return process.env.OCU_BIN;
  if (isMac) return path.join(os.homedir(), '.local/bin/ocu');
  return null;
}

export function requireOcu() {
  const bin = resolveOcu();
  if (!bin) {
    throw new Error('当前平台（' + process.platform + '）没有 ocu 控制后端；Windows 需要 UI Automation 后端，见 flow/CROSS-PLATFORM.md');
  }
  return bin;
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

export default { isMac, isWindows, platform, controlBackend, resolveOcu, requireOcu, dataDir, runPowerShell, readFrontmostApp };
