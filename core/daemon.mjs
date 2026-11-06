#!/usr/bin/env node
/**
 * 后台守护进程：所有电脑控制都在这里跑，DSH 只负责发指令和看小窗。
 *
 * 设计：
 *   - 常驻 detached 进程，不依附任何终端；
 *   - HTTP 控制面 127.0.0.1:7789：POST /run、GET /status、GET /tasks、POST /stop；
 *   - 任务串行执行（同一时刻只操作一个应用，避免互相踩）；
 *   - 全程把状态推给 overlay 小窗（7788），用户只看小窗即可。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { overlay } from './agentd.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.AGENTD_PORT || 7789);
const TASKS_DIR = path.join(__dirname, 'tasks');
const LOGS = path.join(ROOT, 'logs', 'daemon');

const state = {
  pid: process.pid,
  startedAt: new Date().toISOString(),
  current: null,      // { name, startedAt, pid }
  queue: [],
  history: [],        // { name, ok, startedAt, durationMs }
};

function listTasks() {
  if (!fs.existsSync(TASKS_DIR)) return [];
  return fs.readdirSync(TASKS_DIR).filter((f) => f.endsWith('.mjs')).map((f) => f.replace(/\.mjs$/, '')).sort();
}

function json(res, code, body) {
  const data = JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(data) });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve) => {
    let buf = '';
    req.on('data', (c) => { buf += c; if (buf.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(buf || '{}')); } catch { resolve({}); } });
  });
}

function runTask(name) {
  return new Promise((resolve) => {
    const file = path.join(TASKS_DIR, name + '.mjs');
    if (!fs.existsSync(file)) return resolve({ ok: false, error: '未知任务：' + name, available: listTasks() });

    fs.mkdirSync(LOGS, { recursive: true });
    const logFile = path.join(LOGS, name + '-' + new Date().toISOString().replace(/[:.]/g, '-') + '.log');
    const out = fs.createWriteStream(logFile);

    const startedAt = Date.now();
    const child = spawn(process.execPath, [file], { cwd: ROOT, env: { ...process.env, AGENTD_DAEMON: '1' } });
    state.current = { name, startedAt: new Date().toISOString(), pid: child.pid, logFile };
    overlay.status('后台任务：' + name).catch(() => {});
    overlay.log('开始执行 ' + name).catch(() => {});

    child.stdout.on('data', (b) => { out.write(b); });
    child.stderr.on('data', (b) => { out.write(b); });

    const timer = setTimeout(() => { try { child.kill('SIGTERM'); } catch {} }, 10 * 60 * 1000);

    // 长时间任务期间每 4 秒喂一次状态，否则小窗 5 秒空闲就会自己消失，用户看不到进度
    const beat = setInterval(() => {
      const secs = Math.round((Date.now() - startedAt) / 1000);
      overlay.status('后台任务：' + name + ' · ' + secs + 's').catch(() => {});
    }, 4000);

    // spawn 失败（找不到可执行文件、权限不足）不会触发 close，必须单独接住并清理
    const failEarly = (err) => {
      clearInterval(beat);
      clearTimeout(timer);
      try { out.end(); } catch {}
      const entry = { name, ok: false, code: null, error: String(err && err.message || err), startedAt: new Date(startedAt).toISOString(), durationMs: Date.now() - startedAt, logFile };
      state.current = null;
      state.history.unshift(entry);
      state.history = state.history.slice(0, 30);
      overlay.status('失败：' + name).catch(() => {});
      overlay.log('启动失败 ' + name + '：' + entry.error).catch(() => {});
      return entry;
    };
    child.on('error', (err) => { try { resolve(failEarly(err)); } catch {} });

    child.on('close', (code) => {
      clearInterval(beat);
      clearTimeout(timer);
      try { out.end(); } catch {}
      const durationMs = Date.now() - startedAt;
      const ok = code === 0;
      const entry = { name, ok, code, startedAt: new Date(startedAt).toISOString(), durationMs, logFile };
      state.current = null;
      state.history.unshift(entry);
      state.history = state.history.slice(0, 30);
      overlay.status(ok ? '完成：' + name : '失败：' + name).catch(() => {});
      overlay.log((ok ? '完成 ' : '失败 ') + name + ' 用时 ' + (durationMs / 1000).toFixed(1) + 's').catch(() => {});
      resolve(entry);
    });
  });
}

async function drain() {
  if (state.current || !state.queue.length) return;
  const name = state.queue.shift();
  await runTask(name);
  drain();
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname.replace(/\/+$/, '') || '/';

  if (p === '/' && req.method === 'GET') {
    return json(res, 200, {
      ok: true,
      service: 'desktop-agent-daemon',
      pid: state.pid,
      uptimeSec: Math.round((Date.now() - new Date(state.startedAt).getTime()) / 1000),
      current: state.current,
      queued: state.queue.length,
      tasks: listTasks(),
    });
  }

  if (p === '/status' && req.method === 'GET') {
    return json(res, 200, { ok: true, ...state, tasks: listTasks() });
  }

  if (p === '/tasks' && req.method === 'GET') {
    return json(res, 200, { ok: true, tasks: listTasks(), history: state.history });
  }

  if (p === '/run' && req.method === 'POST') {
    const body = await readBody(req);
    const names = body.tasks || (body.task ? [body.task] : []);
    if (!names.length) return json(res, 400, { ok: false, error: '缺少 task 或 tasks' });
    for (const n of names) state.queue.push(n);
    overlay.log('排队任务：' + names.join(', ')).catch(() => {});
    drain();
    return json(res, 202, { ok: true, queued: names, queuedCount: state.queue.length });
  }

  if (p === '/stop' && req.method === 'POST') {
    state.queue = [];
    if (state.current && state.current.pid) {
      try { process.kill(state.current.pid, 'SIGTERM'); } catch {}
    }
    return json(res, 200, { ok: true, stopped: true });
  }

  return json(res, 404, { ok: false, error: 'not found', path: p });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('[daemon] listening on 127.0.0.1:' + PORT + ' pid=' + state.pid);
  overlay.status('后台服务已启动').catch(() => {});
  overlay.log('守护进程启动，端口 ' + PORT).catch(() => {});
});

process.on('SIGTERM', () => { server.close(); process.exit(0); });
