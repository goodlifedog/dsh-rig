'use strict';

/**
 * 把后台 daemon 作为子进程带起来：打包成单个 App 后，用户装完打开就有完整能力。
 * 用 Electron 自带的 Node 运行时跑 core/daemon.mjs，不需要用户另装 Node。
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

let child = null;

function resolveCoreDir() {
  // 打包后：<App>/Contents/Resources/core；开发时：overlay/../core
  const packaged = path.join(process.resourcesPath || '', 'core');
  if (fs.existsSync(path.join(packaged, 'daemon.mjs'))) return packaged;
  return path.join(__dirname, '..', 'core');
}

async function daemonAlive() {
  try {
    const r = await fetch('http://127.0.0.1:7789/', { signal: AbortSignal.timeout(1200) });
    const d = await r.json();
    return Boolean(d && d.ok);
  } catch { return false; }
}

async function startDaemon() {
  if (await daemonAlive()) return { ok: true, reused: true };
  const coreDir = resolveCoreDir();
  const entry = path.join(coreDir, 'daemon.mjs');
  if (!fs.existsSync(entry)) return { ok: false, error: '找不到 daemon：' + entry };

  child = spawn(process.execPath, [entry], {
    cwd: path.dirname(coreDir),
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      OPEN_COMPUTER_USE_VISUAL_CURSOR: '0',
      PATH: process.env.PATH,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => { if (process.env.DSH_SUPERVISOR_DEBUG) process.stdout.write('[daemon] ' + d); });
  child.stderr.on('data', (d) => { if (process.env.DSH_SUPERVISOR_DEBUG) process.stderr.write('[daemon err] ' + d); });

  // 最多等 8 秒
  const started = Date.now();
  while (Date.now() - started < 8000) {
    if (await daemonAlive()) return { ok: true, pid: child.pid };
    await new Promise((r) => setTimeout(r, 300));
  }
  return { ok: false, error: 'daemon 启动超时' };
}

function stopDaemon() {
  if (!child) return;
  try { child.kill('SIGTERM'); } catch {}
  child = null;
}

module.exports = { startDaemon, stopDaemon, daemonAlive };
