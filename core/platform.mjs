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

const PROJECT_ROOT = path.join(HERE, '..');

/** 随包附带的 ocu（打包成单 App 时用；install 时由 bundle-ocu.mjs 放到 third_party） */
export function bundledOcu(options = {}) {
  const root = (options && options.root) || PROJECT_ROOT;
  const cand = path.join(root, 'third_party', 'open-computer-use', 'bin', 'ocu');
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
/** npm 依赖装出来的那份 ocu（npm install 后直接可用，不需要用户全局装） */
export function dependencyOcu(options = {}) {
  const root = (options && options.root) || PROJECT_ROOT;
  const cand = path.join(root, 'node_modules', 'open-computer-use', 'bin', 'ocu');
  return existsSync(cand) ? cand : null;
}

/**
 * ocu 可执行文件的查找顺序（克隆即用的关键）：
 *   1. OCU_BIN 环境变量（显式指定优先）
 *   2. node_modules/open-computer-use/bin/ocu ← npm install 装出来的，默认路径
 *   3. third_party/open-computer-use/bin/ocu  ← bundle-ocu.mjs 随包附带的（打包 .app 用）
 *   4. ~/.local/bin/ocu（macOS 全局安装）／%APPDATA%/npm/ocu.cmd（Windows 全局安装）
 * 前两步任一命中就直接返回，所以新装用户不需要先 npm i -g。
 *
 * options 只用于单测注入（root/env/homedir/platform），不传就是真实环境。
 */
export function resolveOcu(options = {}) {
  const opts = options || {};
  const env = opts.env || process.env;
  const root = opts.root || PROJECT_ROOT;
  const home = opts.homedir || os.homedir();
  const plat = opts.platform || process.platform;
  if (env.OCU_BIN) return env.OCU_BIN;
  const dep = dependencyOcu({ root });
  if (dep) return dep;
  const bundled = bundledOcu({ root });
  if (bundled) return bundled;
  if (plat === 'darwin') return path.join(home, '.local/bin/ocu');
  if (plat === 'win32') {
    const appData = env.APPDATA || path.join(home, 'AppData', 'Roaming');
    const cand = path.join(appData, 'npm', 'ocu.cmd');
    return existsSync(cand) ? cand : 'ocu.cmd'; // 退回 PATH 查找
  }
  return null;
}

export function requireOcu(options = {}) {
  const bin = resolveOcu(options);
  if (!bin) {
    throw new Error('当前平台（' + process.platform + '）没有 ocu 控制后端；'
      + '在项目里跑 npm i open-computer-use 即可（已内置依赖），或全局装 npm i -g open-computer-use；见 flow/CROSS-PLATFORM.md');
  }
  return bin;
}

/**
 * 屏幕是否锁屏（仅 macOS）。
 * 锁屏后 Chrome 等 GUI 应用启动会慢一个数量级，任务超时需要相应放宽。
 */
/**
 * 解析 ioreg 输出里的锁屏标记（纯函数，便于单测）。
 * 支持文本格式（"CGSSessionScreenIsLocked" = Yes）和 plist 格式（<key>…</key><true/>）；
 * 键不存在时视为未锁屏。
 */
/** 锁屏跳过的统一提示（任务入口用；文案里必须含「环境跳过」和「锁屏」，出口分类才认） */
export function lockedSkipNotice(taskName = '') {
  return '环境跳过：屏幕已锁，锁屏下 AX/抓图都不可用' + (taskName ? '（' + taskName + '）' : '');
}

export function parseScreenLocked(output) {
  const text = String(output || '');
  if (/<key>CGSSessionScreenIsLocked<\/key>\s*<true\s*\/?>/i.test(text)) return true;
  if (/<key>CGSSessionScreenIsLocked<\/key>\s*<false\s*\/?>/i.test(text)) return false;
  const m = /CGSSessionScreenIsLocked"?\s*=\s*(Yes|No|true|false|1|0)/i.exec(text);
  if (!m) return false;
  return /^(yes|true|1)$/i.test(m[1]);
}

export function isScreenLocked() {
  // 测试用开关：锁屏状态下没法真跑 UI，但「锁屏时任务应该环境跳过」这条路径必须能验，
  // 用 AGENT_FAKE_LOCKED=1 强制判锁（只影响这个函数，不碰真实系统状态）。
  if (process.env.AGENT_FAKE_LOCKED === '1') return true;
  if (!isMac) return false;
  try {
    const out = execFileSync('/usr/sbin/ioreg', ['-n', 'Root', '-d1'], { encoding: 'utf8', timeout: 3000 });
    return parseScreenLocked(out);
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

export default { isMac, isWindows, platform, controlBackend, resolveOcu, requireOcu, dataDir, runPowerShell, readFrontmostApp, isScreenLocked, parseScreenLocked, lockedSkipNotice };