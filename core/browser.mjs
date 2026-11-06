'use strict';

/**
 * 专用浏览器实例：给自动化一套自己的 Chrome，完全不碰用户正在用的窗口。
 *
 * 设计：
 *   - 独立 user-data-dir（默认在 ~/.desktop-agent/chrome-profile），登录态可长期保留；
 *   - 窗口放在屏幕外 (-5000, -5000)，配合 --no-first-run 等参数，用户看不到；
 *   - --remote-debugging-port=0，从 DevToolsActivePort 读真实端口，避免端口冲突；
 *   - 通过 CDP 驱动，不依赖 Accessibility，也不受「用户当前标签页」影响。
 *
 * 首次使用需要在离屏窗口里登录一次（例如 BOSS 扫码），之后再跑就不用管。
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { CDP, listTargets } from './cdp.mjs';
import { overlay } from './agentd.mjs';

export const CHROME_BIN = process.env.CHROME_BIN
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

export const DEFAULT_PROFILE = process.env.AGENT_CHROME_PROFILE
  || path.join(os.homedir(), '.desktop-agent', 'chrome-profile');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function readDevToolsActivePort(userDataDir) {
  const file = path.join(userDataDir, 'DevToolsActivePort');
  if (!fs.existsSync(file)) return null;
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  const port = Number(lines[0]);
  if (!Number.isInteger(port) || port <= 0) return null;
  return { port, wsPath: lines[1] || null };
}

async function waitForPort(userDataDir, { timeoutMs = 30000 } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const info = readDevToolsActivePort(userDataDir);
    if (info) return info;
    await sleep(200);
  }
  throw new Error('等待 Chrome 调试端口超时：' + userDataDir);
}

/** 列出进程（跨平台），返回 [{ pid, command }] */
async function listProcesses() {
  const { execFileSync } = await import('node:child_process');
  if (process.platform === 'win32') {
    try {
      const out = execFileSync('powershell', ['-NoProfile', '-Command',
        'Get-CimInstance Win32_Process | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress'],
        { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
      const arr = JSON.parse(out || '[]');
      return (Array.isArray(arr) ? arr : [arr]).map((x) => ({ pid: Number(x.ProcessId), command: String(x.CommandLine || '') }));
    } catch { return []; }
  }
  const out = execFileSync('ps', ['-ax', '-o', 'pid=,command='], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  return out.split('\n').filter(Boolean).map((line) => {
    const m = line.trim().match(/^(\d+)\s+(.*)$/);
    return m ? { pid: Number(m[1]), command: m[2] } : null;
  }).filter(Boolean);
}

/** 通过 user-data-dir 在进程表里找到 Chrome 主进程 pid */
export async function findChromePid(userDataDir, { timeoutMs = 8000 } = {}) {
  const started = Date.now();
  const exeHint = process.platform === 'win32' ? 'chrome.exe' : 'MacOS/Google Chrome';
  while (Date.now() - started < timeoutMs) {
    try {
      for (const p of await listProcesses()) {
        if (p.command.includes(userDataDir) && p.command.includes(exeHint) && !p.command.includes('Helper') && !p.command.includes('--type=')) {
          return p.pid;
        }
      }
    } catch {}
    await sleep(200);
  }
  return 0;
}

async function waitForHttp(port, { timeoutMs = 15000 } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch('http://127.0.0.1:' + port + '/json/version', { signal: AbortSignal.timeout(800) });
      if (res.ok) return await res.json();
    } catch {}
    await sleep(200);
  }
  throw new Error('等待 Chrome DevTools 就绪超时：端口 ' + port);
}

/**
 * 清理 profile 里会导致「窗口跑到用户屏幕上」的数据：
 *   - browser.window_placement：Chrome 会按它还原窗口，覆盖 --window-position
 *   - 会话恢复文件：会把用户上次的标签页恢复出来
 */
export async function sanitizeProfile(userDataDir) {
  const prefFiles = [];
  for (const dir of ['Default', 'Profile 1', 'Profile 2']) {
    prefFiles.push(path.join(userDataDir, dir, 'Preferences'));
    for (const f of ['Current Session', 'Current Tabs', 'Last Session', 'Last Tabs']) {
      const p = path.join(userDataDir, dir, f);
      try { await fsp.rm(p, { force: true }); } catch {}
    }
  }
  for (const file of prefFiles) {
    try {
      const raw = await fsp.readFile(file, 'utf8');
      const json = JSON.parse(raw);
      let changed = false;
      if (json.browser) {
        if (json.browser.window_placement) { delete json.browser.window_placement; changed = true; }
        if (json.browser.restore_on_startup !== undefined) { json.browser.restore_on_startup = 5; changed = true; }
      }
      if (changed) await fsp.writeFile(file, JSON.stringify(json));
    } catch {}
  }
}

/**
 * 启动离屏 Chrome。
 * @param {{userDataDir?: string, headless?: boolean, extraArgs?: string[], port?: number}} opts
 */
export async function launch(opts = {}) {
  const userDataDir = opts.userDataDir || DEFAULT_PROFILE;
  await fsp.mkdir(userDataDir, { recursive: true });

  // 清掉上一次残留的端口文件，避免读到旧端口
  const portFile = path.join(userDataDir, 'DevToolsActivePort');
  if (fs.existsSync(portFile)) fs.unlinkSync(portFile);

  // 关键：清掉窗口位置和会话恢复，否则 Chrome 会把窗口还原到用户屏幕上
  await sanitizeProfile(userDataDir);

  const args = [
    '--remote-debugging-port=' + (opts.port || 0),
    '--user-data-dir=' + userDataDir,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-sync',
    '--disable-features=Translate,MediaRouter,OptimizationHints',
    opts.profileDirectory ? '--profile-directory=' + opts.profileDirectory : null,
    opts.headless ? '--headless=new' : '--window-position=-5000,-5000',
    '--window-size=1280,900',
    ...(opts.extraArgs || []),
  ].filter(Boolean);
  if (opts.startUrl) args.push(opts.startUrl);

  // 记录当前前台的 bundle id，启动后立刻抢回来（启动 Chrome 难免会激活一下）
  let prevBundleId = null;
  try {
    const { execFileSync } = await import('node:child_process');
    prevBundleId = execFileSync('osascript', ['-e',
      'tell application "System Events" to get bundle identifier of first process whose frontmost is true'],
      { encoding: 'utf8' }).trim();
  } catch {}

  let child;
  if (process.platform === 'darwin' && opts.background !== false) {
    // 用 open -g 后台启动：不让 Chrome 抢到前台
    child = spawn('open', ['-g', '-n', '-a', 'Google Chrome', '--args', ...args], { detached: true, stdio: ['ignore', 'ignore', 'ignore'] });
    child.unref();
    child = { pid: await findChromePid(userDataDir) };
  } else if (process.platform === 'win32') {
    // Windows 没有等价的后台启动：直接起进程，窗口可能短暂获得前台
    child = spawn(CHROME_BIN, args, { detached: true, stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true });
    child.unref();
    const pid = await findChromePid(userDataDir);
    if (pid) child = { pid };
  } else {
    child = spawn(CHROME_BIN, args, { detached: true, stdio: ['ignore', 'ignore', 'ignore'] });
    child.unref();
  }

  // 有后台控制在跑时，小窗自动出现
  overlay.status('专用浏览器运行中').catch(() => {});
  overlay.log('启动离屏 Chrome（端口 ' + (opts.port || 0) + '）').catch(() => {});

  const info = await waitForPort(userDataDir, { timeoutMs: opts.timeoutMs || 30000 });
  await waitForHttp(info.port, { timeoutMs: opts.timeoutMs || 30000 });

  // 把前台还回去：Chrome 的激活发生在窗口创建之后，所以要延迟并多试几次
  if (prevBundleId && prevBundleId !== 'com.google.Chrome') {
    const { spawnSync } = await import('node:child_process');
    const restore = () => {
      try { spawnSync('open', ['-b', prevBundleId], { stdio: 'ignore', timeout: 5000 }); } catch {}
    };
    setTimeout(restore, 400);
    setTimeout(restore, 1200);
    setTimeout(restore, 2200);
  }

  return {
    pid: child.pid,
    port: info.port,
    userDataDir,
    async connect({ urlMatch, titleMatch, timeoutMs = 20000 } = {}) {
      const started = Date.now();
      const target = urlMatch || titleMatch || null;
      while (Date.now() - started < timeoutMs) {
        try {
          const page = await CDP.attach({ host: '127.0.0.1', port: info.port, target });
          // 硬保证：连上后立刻把窗口挪到屏幕外（macOS 会按保存的窗口状态还原，参数压不住）
          try {
            const win = await page.send('Browser.getWindowForTarget', { targetId: page.target.id });
            await page.send('Browser.setWindowBounds', {
              windowId: win.windowId,
              bounds: { left: -5000, top: -5000, windowState: 'normal' },
            });
          } catch {}
          return page;
        } catch {
          await sleep(300);
        }
      }
      throw new Error('等待 Chrome 页面超时');
    },
    async close() {
      try { process.kill(-child.pid, 'SIGTERM'); } catch {}
      try { child.kill('SIGTERM'); } catch {}
      overlay.status('专用浏览器已关闭').catch(() => {});
    },
  };
}

/** 连接到已经开着的调试端口（不自启）。 */
export async function attach({ port, host = '127.0.0.1' } = {}) {
  await waitForHttp(port, { timeoutMs: 5000 });
  return {
    port,
    async connect({ urlMatch, titleMatch, timeoutMs = 15000 } = {}) {
      const started = Date.now();
      const target = urlMatch || titleMatch || null;
      while (Date.now() - started < timeoutMs) {
        try {
          return await CDP.attach({ host, port, target });
        } catch {
          await sleep(300);
        }
      }
      throw new Error('等待页面超时');
    },
  };
}
