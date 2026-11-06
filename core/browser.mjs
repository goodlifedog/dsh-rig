'use strict';

/**
 * 专用浏览器实例：给自动化一套自己的 Chrome，完全不碰用户正在用的窗口。
 *
 * 设计：
 *   - 独立 user-data-dir（默认在 ~/.desktop-agent/chrome-profile），登录态可长期保留；
 *   - 窗口放在屏幕外 (-5000, -5000)，配合 --no-first-run 等参数，用户看不到；
 *   - headless: true 时用 --headless=new：连窗口都不创建，屏幕上彻底没有东西；
 *   - --remote-debugging-port=0，从 DevToolsActivePort 读真实端口，避免端口冲突；
 *   - 通过 CDP 驱动，不依赖 Accessibility，也不受「用户当前标签页」影响。
 *
 * 稳定性约定（headless 尤其重要）：
 *   同一个 user-data-dir 只允许一个 Chrome。上一次没退干净的进程会占着
 *   SingletonLock，新实例只会把命令行交给旧实例然后自己退出，DevToolsActivePort
 *   永远不出现 —— 表现就是「等待 Chrome 调试端口超时」。所以 launch() 每次启动前
 *   先清残留进程 + 端口/锁文件，启动失败再清理重试一次。
 *
 * 首次使用需要在离屏窗口里登录一次（例如 BOSS 扫码），之后再跑就不用管。
 */

import { spawn, spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { CDP, listTargets } from './cdp.mjs';
import { overlay } from './agentd.mjs';
import { isScreenLocked } from './platform.mjs';

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

/** 列出进程（跨平台），返回 [{ pid, state, command }]；state 为 ps 的 stat（Z=僵尸） */
async function listProcesses() {
  if (process.platform === 'win32') {
    try {
      const out = execFileSync('powershell', ['-NoProfile', '-Command',
        'Get-CimInstance Win32_Process | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress'],
        { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
      const arr = JSON.parse(out || '[]');
      return (Array.isArray(arr) ? arr : [arr]).map((x) => ({
        pid: Number(x.ProcessId), state: '', command: String(x.CommandLine || ''),
      }));
    } catch { return []; }
  }
  const out = execFileSync('ps', ['-ax', '-o', 'pid=,stat=,command='], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  return out.split('\n').filter(Boolean).map((line) => {
    const m = line.trim().match(/^(\d+)\s+(\S+)\s+(.*)$/);
    return m ? { pid: Number(m[1]), state: m[2], command: m[3] } : null;
  }).filter(Boolean);
}

/** 这个进程是不是「用同一个 user-data-dir 的 Chrome 主进程」 */
function isChromeMainProcess(p, userDataDir) {
  const exeHint = process.platform === 'win32' ? 'chrome.exe' : 'MacOS/Google Chrome';
  if (!p.command.includes(userDataDir)) return false;
  if (!p.command.includes(exeHint)) return false;
  if (p.command.includes('Helper')) return false;
  if (p.command.includes('--type=')) return false;
  return !String(p.state || '').startsWith('Z');
}

/** 通过 user-data-dir 在进程表里找到 Chrome 主进程 pid */
export async function findChromePid(userDataDir, { timeoutMs = 8000 } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      for (const p of await listProcesses()) {
        if (isChromeMainProcess(p, userDataDir)) return p.pid;
      }
    } catch {}
    await sleep(200);
  }
  return 0;
}

/** pid 是否还活着（僵尸进程算死） */
async function isProcessAlive(pid) {
  if (!pid) return false;
  try {
    const p = (await listProcesses()).find((x) => x.pid === pid);
    if (!p) return false;
    return !String(p.state || '').startsWith('Z');
  } catch {
    try { process.kill(pid, 0); return true; } catch { return false; }
  }
}

/**
 * 清理同一个 user-data-dir 的残留 Chrome：先 SIGTERM，等不到再 SIGKILL。
 * 这是 headless 反复启动失败的根因（旧进程占着 SingletonLock）。
 * @returns {Promise<{killed: number[], remaining: number[]}>}
 */
export async function killStaleChrome(userDataDir, { timeoutMs = 5000, onLog = null } = {}) {
  const alive = async () => {
    try { return (await listProcesses()).filter((p) => isChromeMainProcess(p, userDataDir)); }
    catch { return []; }
  };

  let procs = await alive();
  if (!procs.length) return { killed: [], remaining: [] };

  const pids = procs.map((p) => p.pid);
  if (onLog) onLog('发现同 profile 的残留 Chrome 进程：' + pids.join(',') + '，正在清理');
  for (const pid of pids) { try { process.kill(pid, 'SIGTERM'); } catch {} }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(150);
    procs = await alive();
    if (!procs.length) return { killed: pids, remaining: [] };
  }

  for (const p of procs) { try { process.kill(p.pid, 'SIGKILL'); } catch {} }
  await sleep(300);
  const remaining = (await alive()).map((p) => p.pid);
  if (onLog && remaining.length) onLog('残留 Chrome 强杀后仍在：' + remaining.join(','));
  return { killed: pids, remaining };
}

/**
 * 删掉会挡住新实例的端口文件与单实例锁（都是 Chrome 自己写的，删掉安全）。
 * 不删 DevToolsActivePort 的话，可能会读到上一次的旧端口连到别的进程。
 */
export async function resetProfileLocks(userDataDir) {
  const removed = [];
  for (const name of ['DevToolsActivePort', 'SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
    try {
      await fsp.rm(path.join(userDataDir, name), { force: true });
      removed.push(name);
    } catch {}
  }
  return removed;
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

function buildArgs(opts, userDataDir) {
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
  return args;
}

/** 真正把进程拉起来，返回 { pid }；spawn 的 error 事件必须自己接住，否则会崩进程 */
async function spawnChrome(opts, userDataDir, args) {
  const start = (cmd, argv, extra = {}) => {
    const child = spawn(cmd, argv, { detached: true, stdio: ['ignore', 'ignore', 'ignore'], ...extra });
    child.on('error', () => {});
    child.unref();
    return child;
  };

  // 锁屏时 Chrome 起得慢（实测 ~18s），找 pid 的等待时间要相应放宽，否则拿到 0
  const pidTimeout = isScreenLocked() ? 30000 : 8000;

  if (process.platform === 'darwin' && opts.background !== false) {
    // 用 open -g 后台启动：不让 Chrome 抢到前台
    start('open', ['-g', '-n', '-a', 'Google Chrome', '--args', ...args]);
    return { pid: await findChromePid(userDataDir, { timeoutMs: pidTimeout }) };
  }
  if (process.platform === 'win32') {
    // Windows 没有等价的后台启动：直接起进程，窗口可能短暂获得前台
    const child = start(CHROME_BIN, args, { windowsHide: true });
    return { pid: (await findChromePid(userDataDir, { timeoutMs: pidTimeout })) || child.pid };
  }
  const child = start(CHROME_BIN, args);
  return { pid: child.pid };
}

/** 把前台还给用户：Chrome 的激活发生在窗口创建之后，所以要延迟并多试几次 */
function restoreFront(prevBundleId) {
  if (!prevBundleId || prevBundleId === 'com.google.Chrome') return;
  const restore = () => {
    try { spawnSync('open', ['-b', prevBundleId], { stdio: 'ignore', timeout: 5000 }); } catch {}
  };
  setTimeout(restore, 400);
  setTimeout(restore, 1200);
  setTimeout(restore, 2200);
}

/**
 * 启动离屏 / headless Chrome。
 * @param {{userDataDir?: string, headless?: boolean, extraArgs?: string[], port?: number,
 *          retries?: number, timeoutMs?: number, background?: boolean}} opts
 */
export async function launch(opts = {}) {
  const userDataDir = opts.userDataDir || DEFAULT_PROFILE;
  // 锁屏时 GUI 应用启动会慢一个数量级（实测 Chrome ~1s → ~18s），超时相应放宽
  const screenLocked = isScreenLocked();
  const baseTimeout = opts.timeoutMs || 30000;
  const timeoutMs = screenLocked ? baseTimeout * 3 : baseTimeout;
  if (screenLocked) console.log('[browser] 检测到锁屏，启动超时放宽到 ' + timeoutMs + 'ms');
  const attempts = Math.max(1, Number(opts.retries == null ? 2 : opts.retries));
  await fsp.mkdir(userDataDir, { recursive: true });

  const logLine = (text) => { overlay.log(text).catch(() => {}); };
  const args = buildArgs(opts, userDataDir);

  // 记录当前前台的 bundle id，启动后立刻抢回来（启动 Chrome 难免会激活一下）
  let prevBundleId = null;
  try {
    prevBundleId = execFileSync('osascript', ['-e',
      'tell application "System Events" to get bundle identifier of first process whose frontmost is true'],
      { encoding: 'utf8' }).trim();
  } catch {}

  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    // 1) 先清残留：旧进程活着时新实例只会把命令行转交给它然后退出，
    //    端口文件永远不出现 —— 这就是「等待 Chrome 调试端口超时」的直接原因。
    const stale = await killStaleChrome(userDataDir, { onLog: logLine });
    // 2) 端口文件与单实例锁一起清掉，避免读到上一轮的旧端口
    await resetProfileLocks(userDataDir);
    // 3) 清窗口位置与会话恢复，否则窗口会被还原到用户屏幕上
    await sanitizeProfile(userDataDir);

    try {
      const child = await spawnChrome(opts, userDataDir, args);

      // 有后台控制在跑时，小窗自动出现
      overlay.status('专用浏览器运行中').catch(() => {});
      overlay.log('启动离屏 Chrome（端口 ' + (opts.port || 0) + (opts.headless ? '，headless' : '') + '）').catch(() => {});

      const info = await waitForPort(userDataDir, { timeoutMs });
      await waitForHttp(info.port, { timeoutMs });

      restoreFront(prevBundleId);

      return {
        pid: child.pid,
        port: info.port,
        userDataDir,
        headless: Boolean(opts.headless),
        attempt,
        staleKilled: stale.killed,
        async connect({ urlMatch, titleMatch, timeoutMs: connectTimeoutMs = 20000 } = {}) {
          const started = Date.now();
          const target = urlMatch || titleMatch || null;
          while (Date.now() - started < connectTimeoutMs) {
            try {
              const page = await CDP.attach({ host: '127.0.0.1', port: info.port, target });
              // 硬保证：连上后立刻把窗口挪到屏幕外（macOS 会按保存的窗口状态还原，参数压不住）
              // headless 模式下没有窗口，这一步会失败，忽略即可。
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
        /** 关掉浏览器：SIGTERM → 等 4s → SIGKILL，并清掉端口/锁文件，保证下次启动干净 */
        async close() {
          // pid 可能是 0（findChromePid 超时）：process.kill(-0) 会命中当前进程组，等于自杀，必须挡住
          const pid = Number(child && child.pid) || 0;
          if (pid > 0) {
            try { process.kill(-pid, 'SIGTERM'); } catch {}
            try { process.kill(pid, 'SIGTERM'); } catch {}
          }
          const deadline = Date.now() + 4000;
          const closePid = Number(child && child.pid) || 0;
          while (closePid > 0 && Date.now() < deadline && (await isProcessAlive(closePid))) await sleep(150);
          if (closePid > 0 && await isProcessAlive(closePid)) {
            try { process.kill(closePid, 'SIGKILL'); } catch {}
            await sleep(200);
          }
          // 同名 profile 的其它残留（本次启动拉起的 Helper 之外的进程）一并收掉
          await killStaleChrome(userDataDir, { timeoutMs: 2000 });
          await resetProfileLocks(userDataDir);
          overlay.status('专用浏览器已关闭').catch(() => {});
          return { pid: child.pid, alive: await isProcessAlive(child.pid) };
        },
      };
    } catch (err) {
      lastError = err;
      // 这次尝试半启动的进程也清掉，否则会污染下一次尝试
      await killStaleChrome(userDataDir, { onLog: logLine });
      await resetProfileLocks(userDataDir);
      if (attempt < attempts) {
        logLine('Chrome 启动失败（' + err.message + '），清理后重试');
        await sleep(400);
      }
    }
  }

  throw new Error('启动 Chrome 失败（已尝试 ' + attempts + ' 次）：'
    + (lastError && lastError.message ? lastError.message : '未知错误'));
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