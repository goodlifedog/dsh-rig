'use strict';

/**
 * 把后台 daemon 作为子进程带起来：打包成单个 App 后，用户装完打开就有完整能力。
 * 用 Electron 自带的 Node 运行时跑 core/daemon.mjs，不需要用户另装 Node。
 *
 * 注意：spawn 出来的子进程必须挂 error/exit 监听。不挂的话 spawn 失败（例如打包后
 * daemon.mjs 路径不对、Electron 运行时起不来）会以 'error' 事件抛到主进程，
 * 小窗直接崩；而 daemon 中途退出又没人记录，表现就是「后台任务突然全不动了」。
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_PORT = 7789;
const START_TIMEOUT_MS = 8000;

/**
 * 工厂：把 spawn/fetch 等外部依赖注入进来，便于单测覆盖失败分支。
 */
function createSupervisor(deps = {}) {
  const spawnFn = deps.spawn || spawn;
  const fetchFn = deps.fetch || fetch;
  const fsApi = deps.fs || fs;
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const now = deps.now || (() => Date.now());
  const port = Number(deps.port) || DEFAULT_PORT;

  let child = null;
  let spawnError = '';
  let lastExit = null;
  let stopping = false;

  function resolveCoreDir() {
    // 打包后：<App>/Contents/Resources/core；开发时：overlay/../core
    const packaged = path.join(process.resourcesPath || '', 'core');
    if (fsApi.existsSync(path.join(packaged, 'daemon.mjs'))) return packaged;
    return path.join(__dirname, '..', 'core');
  }

  async function daemonAlive() {
    try {
      const r = await fetchFn('http://127.0.0.1:' + port + '/', { signal: AbortSignal.timeout(1200) });
      const d = await r.json();
      return Boolean(d && d.ok);
    } catch { return false; }
  }

  /** 记录子进程事件：始终挂监听，失败也只记录，不往外抛 */
  function watch(nextChild) {
    spawnError = '';
    stopping = false;
    nextChild.on('error', (error) => {
      spawnError = 'daemon 子进程启动失败：' + ((error && error.message) || error);
      console.error('[overlay] ' + spawnError);
    });
    nextChild.on('exit', (code, signal) => {
      const expected = stopping;
      lastExit = { code: code == null ? null : Number(code), signal: signal || '', at: new Date().toISOString(), expected };
      if (child === nextChild) child = null;
      if (!expected) {
        console.error('[overlay] daemon 子进程意外退出（code=' + lastExit.code + ' signal=' + lastExit.signal +
          '）：后台任务暂时不可用，检查 ' + port + ' 是否被别的进程占用后执行 npm run service:restart');
      }
    });
  }

  async function startDaemon() {
    if (await daemonAlive()) return { ok: true, reused: true };
    const coreDir = resolveCoreDir();
    const entry = path.join(coreDir, 'daemon.mjs');
    if (!fsApi.existsSync(entry)) return { ok: false, error: '找不到 daemon：' + entry };

    const spawned = spawnFn(process.execPath, [entry], {
      cwd: path.dirname(coreDir),
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        OPEN_COMPUTER_USE_VISUAL_CURSOR: '0',
        PATH: process.env.PATH,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child = spawned;
    watch(spawned);
    if (spawned.stdout && spawned.stdout.on) {
      spawned.stdout.on('data', (d) => { if (process.env.DSH_SUPERVISOR_DEBUG) process.stdout.write('[daemon] ' + d); });
    }
    if (spawned.stderr && spawned.stderr.on) {
      spawned.stderr.on('data', (d) => { if (process.env.DSH_SUPERVISOR_DEBUG) process.stderr.write('[daemon err] ' + d); });
    }

    const started = now();
    while (now() - started < START_TIMEOUT_MS) {
      if (await daemonAlive()) return { ok: true, pid: spawned.pid };
      await sleep(300);
    }
    // 超时：把子进程侧的失败原因一起带出去，别只报「启动超时」
    const detail = spawnError || (lastExit ? 'daemon 进程退出了（code=' + lastExit.code + ') ' : '');
    return { ok: false, error: 'daemon 启动超时' + (detail ? '：' + detail : ''), pid: spawned.pid };
  }

  function stopDaemon() {
    const running = child;
    if (!running) return;
    stopping = true;
    try { running.kill('SIGTERM'); } catch {}
    child = null;
  }

  /** 给 /health 用的管理状态：小窗有没有在托管 daemon、上次为什么退出 */
  function status() {
    return {
      managed: Boolean(child),
      pid: (child && child.pid) || 0,
      spawnError,
      lastExit,
    };
  }

  return { startDaemon, stopDaemon, daemonAlive, status, resolveCoreDir };
}

const defaultSupervisor = createSupervisor();

module.exports = {
  startDaemon: defaultSupervisor.startDaemon,
  stopDaemon: defaultSupervisor.stopDaemon,
  daemonAlive: defaultSupervisor.daemonAlive,
  status: defaultSupervisor.status,
  createSupervisor,
};
