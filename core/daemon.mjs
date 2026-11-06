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
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { overlay } from './agentd.mjs';
import { decideRetry } from './retry-policy.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.AGENTD_PORT || 7789);
// 允许指向别的任务目录：集成测试用临时目录，避免污染真实任务列表
const TASKS_DIR = process.env.AGENTD_TASKS_DIR || path.join(__dirname, 'tasks');
const LOGS = path.join(ROOT, 'logs', 'daemon');
// 临时性失败自动重跑几次（Chrome 启动慢、端口没起来这类），环境类失败不重试
const MAX_RETRIES = Math.max(0, Number(process.env.AGENTD_MAX_RETRIES || 1));
// 队列上限：本地程序狂刷 /run 时不能让队列无限增长（超了直接 429）
const MAX_QUEUE = Math.max(1, Number(process.env.AGENTD_MAX_QUEUE || 50));

const state = {
  pid: process.pid,
  startedAt: new Date().toISOString(),
  current: null,      // { name, startedAt, pid }
  pendingRetry: null, // { name, attempt, at }：失败后等待退避重跑，这段时间不能对外显示「空闲」
  cancelled: false,   // 用户主动停止（POST /stop）：这种结束不该触发自动重试
  queue: [],
  history: [],        // { name, ok, startedAt, durationMs, attempt } —— 内部保留 200 条用于统计
};

// 后台服务是 launchd 起的，系统按「这个可执行文件」认权限，和终端里跑不是一回事。
// 这里实际探一次，把「能不能控制系统」量出来，别让任务失败后靠猜。
function probe(cmd, args, timeout = 6000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        out: String(stdout || '').trim().slice(0, 200),
        error: err ? (String(stderr || '').trim().split('\n')[0] || err.message).slice(0, 160) : '',
      });
    });
  });
}

async function selfTest() {
  const checks = {};
  checks.systemEvents = await probe('/usr/bin/osascript', ['-e', 'tell application "System Events" to count processes']);
  const ocuPath = [process.env.OCU_BIN, path.join(ROOT, 'third_party', 'open-computer-use', 'bin', 'ocu')]
    .filter(Boolean).find((p) => { try { return fs.existsSync(p); } catch { return false; } });
  if (ocuPath) {
    checks.ocu = await probe(ocuPath, ['call', 'list_apps'], 15000);
  } else {
    checks.ocu = { ok: false, out: '', error: '找不到 ocu（可设 OCU_BIN）' };
  }
  const axOk = checks.systemEvents.ok;
  return {
    ok: axOk,
    checks,
    hint: axOk ? '' : '后台服务缺少辅助功能权限：系统设置 → 隐私与安全性 → 辅助功能，把 ' + process.execPath + ' 加进去',
  };
}

// 读日志末尾：重试判定要看到失败原因
function tailOf(file, bytes = 4096) {
  try {
    const st = fs.statSync(file);
    const start = Math.max(0, st.size - bytes);
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(st.size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    return buf.toString('utf8');
  } catch { return ''; }
}

// 按任务聚合最近运行记录：成功率、平均/最慢耗时、重试次数
function statsOf() {
  const runs = state.history;
  const byTask = new Map();
  let okCount = 0;
  let totalMs = 0;
  let retries = 0;
  for (const run of runs) {
    if (!run) continue;
    const item = byTask.get(run.name) || { name: run.name, count: 0, ok: 0, totalMs: 0, maxMs: 0, retries: 0 };
    item.count += 1;
    if (run.ok) { item.ok += 1; okCount += 1; }
    item.totalMs += run.durationMs || 0;
    totalMs += run.durationMs || 0;
    item.maxMs = Math.max(item.maxMs, run.durationMs || 0);
    if ((run.attempt || 0) > 0) { item.retries += 1; retries += 1; }
    byTask.set(run.name, item);
  }
  const tasks = Array.from(byTask.values())
    .map((t) => ({
      name: t.name,
      count: t.count,
      okRate: t.count ? Math.round((t.ok / t.count) * 100) : 0,
      avgMs: t.count ? Math.round(t.totalMs / t.count) : 0,
      maxMs: t.maxMs,
      retries: t.retries,
    }))
    .sort((a, b) => b.count - a.count);
  return {
    runs: runs.length,
    okRate: runs.length ? Math.round((okCount / runs.length) * 100) : 0,
    avgMs: runs.length ? Math.round(totalMs / runs.length) : 0,
    retries,
    tasks,
  };
}

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

function runTask(name, attempt = 0) {
  return new Promise((resolve) => {
    // 任务名必须是任务目录里真实存在的名字：不做校验会被 ../ 跳出目录执行任意脚本
    const available = listTasks();
    if (!available.includes(name)) {
      return resolve({ ok: false, error: '未知任务：' + name, available: available });
    }
    const file = path.join(TASKS_DIR, name + '.mjs');
    if (!fs.existsSync(file)) return resolve({ ok: false, error: '未知任务：' + name, available: available });

    fs.mkdirSync(LOGS, { recursive: true });
    const logFile = path.join(LOGS, name + '-' + new Date().toISOString().replace(/[:.]/g, '-') + '.log');
    const out = fs.createWriteStream(logFile);

    const startedAt = Date.now();
    const child = spawn(process.execPath, [file], { cwd: ROOT, env: { ...process.env, AGENTD_DAEMON: '1' } });
    state.current = { name, attempt, startedAt: new Date().toISOString(), pid: child.pid, logFile };
    state.pendingRetry = null;
    state.cancelled = false;
    overlay.status('后台任务：' + name + (attempt ? '（第 ' + (attempt + 1) + ' 次）' : '')).catch(() => {});
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
      const entry = { name, attempt, ok: false, code: null, error: String(err && err.message || err), startedAt: new Date(startedAt).toISOString(), durationMs: Date.now() - startedAt, logFile };
      state.current = null;
      state.history.unshift(entry);
      state.history = state.history.slice(0, 200);
      overlay.log('启动失败 ' + name + '：' + entry.error).catch(() => {});
      overlay.window(null).catch(() => {});
      overlay.status('失败：' + name + ' · ' + entry.error.slice(0, 40), 'error').catch(() => {});
      return entry;
    };
    child.on('error', (err) => { try { resolve(failEarly(err)); } catch {} });

    child.on('close', async (code) => {
      clearInterval(beat);
      clearTimeout(timer);
      try { out.end(); } catch {}
      const durationMs = Date.now() - startedAt;
      const ok = code === 0;
      // 用户主动停止不是失败：单独标记，健康统计和自动重试都不该把它算进去
      const cancelled = state.cancelled === true;
      const entry = { name, attempt, ok, code, cancelled, startedAt: new Date(startedAt).toISOString(), durationMs, logFile };
      state.current = null;
      state.history.unshift(entry);
      state.history = state.history.slice(0, 200);
      // 顺序有讲究：日志会被当成「动作」把状态点成运行中，所以先写日志，
      // 再解绑窗口（停掉抓帧循环、清掉陈旧错误），最后落「完成/失败」状态。
      const verb = cancelled ? '已停止 ' : (ok ? '完成 ' : '失败 ');
      await overlay.log(verb + name + ' 用时 ' + (durationMs / 1000).toFixed(1) + 's').catch(() => {});
      await overlay.window(null).catch(() => {});

      // 临时性失败（Chrome 启动慢、端口没起来）自动重跑；环境类问题重试也没用
      const decision = cancelled
        ? { retry: false, reason: '用户主动停止', delayMs: 0 }
        : decideRetry({ ok, text: tailOf(logFile), attempt, maxAttempts: MAX_RETRIES, code });
      if (decision.retry) {
        await overlay.status('重试中：' + name + '（第 ' + (attempt + 2) + ' 次，' + Math.round(decision.delayMs / 1000) + 's 后）', 'running').catch(() => {});
        await overlay.log('失败原因：' + decision.reason + '；' + Math.round(decision.delayMs / 1000) + 's 后自动重试').catch(() => {});
        state.pendingRetry = { name: name, attempt: attempt + 1, at: Date.now() + decision.delayMs };
        setTimeout(() => {
          state.pendingRetry = null;
          state.queue.unshift({ name, attempt: attempt + 1, retry: true });
          drain();
        }, decision.delayMs);
      } else {
        const label = cancelled ? '已停止：' + name : (ok ? '完成：' : '失败：') + name;
        await overlay.status(label + ' · ' + (durationMs / 1000).toFixed(1) + 's', 'idle').catch(() => {});
        if (!ok && !cancelled && decision.reason === '不是临时性失败') {
          await overlay.log('不做自动重试：' + decision.reason).catch(() => {});
        }
      }
      resolve(entry);
    });
  });
}

async function drain() {
  if (state.current || !state.queue.length) return;
  const item = state.queue.shift();
  const name = typeof item === 'string' ? item : item.name;
  const attempt = typeof item === 'string' ? 0 : (item.attempt || 0);
  await runTask(name, attempt);
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

  if (p === '/stats' && req.method === 'GET') {
    return json(res, 200, Object.assign({ ok: true }, statsOf()));
  }

  if (p === '/selftest' && req.method === 'GET') {
    try {
      return json(res, 200, Object.assign({ ok: true }, await selfTest()));
    } catch (error) {
      return json(res, 500, { ok: false, error: String(error.message || error) });
    }
  }

  if (p === '/status' && req.method === 'GET') {
    return json(res, 200, { ok: true, ...state, queueLength: state.queue.length, history: state.history.slice(0, 30), historyTotal: state.history.length, tasks: listTasks() });
  }

  if (p === '/tasks' && req.method === 'GET') {
    return json(res, 200, { ok: true, tasks: listTasks(), history: state.history });
  }

  if (p === '/run' && req.method === 'POST') {
    const body = await readBody(req);
    const names = body.tasks || (body.task ? [body.task] : []);
    if (!names.length) return json(res, 400, { ok: false, error: '缺少 task 或 tasks' });
    const available = listTasks();
    const unknown = names.filter((n) => typeof n !== 'string' || !available.includes(n));
    if (unknown.length) {
      return json(res, 400, { ok: false, error: '未知任务：' + unknown.join(', '), available: available });
    }
    const pendingCount = state.queue.length + (state.current ? 1 : 0);
    if (pendingCount + names.length > MAX_QUEUE) {
      return json(res, 429, { ok: false, error: '队列已满（上限 ' + MAX_QUEUE + '），请等前面的任务跑完', queued: pendingCount });
    }
    for (const n of names) state.queue.push(n);
    overlay.log('排队任务：' + names.join(', ')).catch(() => {});
    drain();
    return json(res, 202, { ok: true, queued: names, queuedCount: state.queue.length });
  }

  if (p === '/stop' && req.method === 'POST') {
    const hadTask = Boolean(state.current && state.current.pid);
    state.queue = [];
    state.cancelled = hadTask;
    if (hadTask) {
      try { process.kill(state.current.pid, 'SIGTERM'); } catch {}
    }
    return json(res, 200, { ok: true, stopped: hadTask, task: hadTask ? state.current.name : null });
  }

  return json(res, 404, { ok: false, error: 'not found', path: p });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('[daemon] listening on 127.0.0.1:' + PORT + ' pid=' + state.pid);
  overlay.status('后台服务已启动').catch(() => {});
  overlay.log('守护进程启动，端口 ' + PORT).catch(() => {});
});

process.on('SIGTERM', () => { server.close(); process.exit(0); });
