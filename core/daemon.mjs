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
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { overlay } from './agentd.mjs';
import { classifySelfTest, envSkipReason } from './run-classify.mjs';
import { checkPermissions } from './permissions.mjs';
import { isLoopbackHost } from './safety.mjs';
import { decideRetry } from './retry-policy.mjs';
import { frontAppFast, startFrontWatch } from './front-watch.mjs';
import { ensureToken, isAuthorized } from './local-token.mjs';
import { parseProcessTable, findOrphans, signalProcessTree, isProcessAlive, killTaskTree } from './orphan-cleanup.mjs';
import { evaluateTaskPermissionGate, overrideFromEnv, permissionSkipLines } from './permission-gate.mjs';

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

// 控制面票据：只用于会真正动东西的接口（/run、/stop、/selftest）。
// 没有它，本机任意进程都能让守护进程跑任务。
const TOKEN = await ensureToken();

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
  // 兼容字段：老消费者（scripts/health.mjs）读 checks.systemEvents 判断系统事件。
  // 它实际探的是「自动化」权限（让 System Events 别的应用），所以同时作为 automation 项。
  const automationProbe = await probe('/usr/bin/osascript', ['-e', 'tell application "System Events" to count processes']);
  checks.systemEvents = automationProbe;
  const ocuPath = [process.env.OCU_BIN, path.join(ROOT, 'third_party', 'open-computer-use', 'bin', 'ocu')]
    .filter(Boolean).find((p) => { try { return fs.existsSync(p); } catch { return false; } });
  if (ocuPath) {
    checks.ocu = await probe(ocuPath, ['call', 'list_apps'], 15000);
  } else {
    checks.ocu = { ok: false, out: '', error: '找不到 ocu（可设 OCU_BIN）' };
  }
  // 辅助功能 / 屏幕录制：用 ocu doctor 的结论（只读，不会弹 TCC 授权窗口）
  let permissions = null;
  try { permissions = await checkPermissions(); } catch {}
  const permKnown = Boolean(permissions && Array.isArray(permissions.missing) && permissions.missing.indexOf('unknown') === -1);
  const accessibilityOk = permKnown ? permissions.missing.indexOf('accessibility') === -1 : false;
  const screenCaptureOk = permKnown ? permissions.missing.indexOf('screenCapture') === -1 : false;

  // H5：三项分开报，各自 hint 指向正确设置页（辅助功能 / 自动化 / 屏幕录制）
  const classified = classifySelfTest({
    accessibility: accessibilityOk,
    automation: automationProbe.ok,
    screenCapture: screenCaptureOk,
    executable: process.execPath,
  });
  checks.accessibility = Object.assign({ source: 'ocu doctor', trusted: accessibilityOk }, classified.checks.accessibility);
  checks.automation = Object.assign({}, automationProbe, classified.checks.automation);
  checks.screenCapture = Object.assign({ source: 'ocu doctor', granted: screenCaptureOk }, classified.checks.screenCapture);
  return {
    // 向后兼容：老消费者只看 ok（旧语义=系统事件/自动化可用）
    ok: automationProbe.ok,
    allOk: classified.ok,
    checks,
    names: classified.names,
    hints: classified.hints,
    hint: classified.hint,
    missing: classified.missing,
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
  let envSkips = 0;
  for (const run of runs) {
    if (!run) continue;
    const item = byTask.get(run.name) || { name: run.name, count: 0, ok: 0, skips: 0, totalMs: 0, maxMs: 0, retries: 0 };
    item.count += 1;
    // 环境跳过也是 ok=true，但它没验证任何东西：成功率和「成功数」都不能把它算进去
    if (run.envSkip === true) { item.skips += 1; envSkips += 1; }
    else if (run.ok) { item.ok += 1; okCount += 1; }
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
      skips: t.skips,
      okRate: t.count - t.skips > 0 ? Math.round((t.ok / (t.count - t.skips)) * 100) : 0,
      avgMs: t.count ? Math.round(t.totalMs / t.count) : 0,
      maxMs: t.maxMs,
      retries: t.retries,
    }))
    .sort((a, b) => b.count - a.count);
  return {
    runs: runs.length,
    envSkips,
    okRate: runs.length - envSkips > 0 ? Math.round((okCount / (runs.length - envSkips)) * 100) : 0,
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

const MAX_BODY_BYTES = 1024 * 1024;

/**
 * 读 JSON 请求体：超限给 413、坏 JSON 给 400。
 *
 * 之前是「超 1MB 直接 req.destroy() + JSON 解析失败静默当 {}」：前者让调用方拿不到任何响应、
 * 请求挂住；后者会把「垃圾数据」当合法空对象继续走，/run 只会回一句「缺少 task」，看不出是格式错。
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let done = false;
    const fail = (message, statusCode) => {
      if (done) return;
      done = true;
      const error = new Error(message);
      error.statusCode = statusCode;
      reject(error);
    };
    req.on('data', (chunk) => {
      if (done) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        // 不要立刻 destroy：那会把还没发出去的 413 响应一起掐断。把剩余数据丢掉，
        // 让上层把 413 写回去（客户端可能仍收到提前结束，但状态码是可读的）。
        fail('请求体超过 ' + MAX_BODY_BYTES + ' 字节', 413);
        try { req.resume(); } catch {}
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        const error = new Error('请求体不是合法 JSON');
        error.statusCode = 400;
        return reject(error);
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        const error = new Error('请求体必须是 JSON 对象');
        error.statusCode = 400;
        return reject(error);
      }
      resolve(parsed);
    });
    req.on('error', (error) => fail('读取请求体失败：' + String((error && error.message) || error), 400));
  });
}

// 全局只保留一个看门狗；任务结束或新任务开始时先停掉旧的，避免泄漏
let activeFrontWatch = null;
let lastFrontWatchStats = null;

function stopActiveFrontWatch() {
  if (activeFrontWatch) {
    lastFrontWatchStats = activeFrontWatch.stats();
    activeFrontWatch.stop();
    activeFrontWatch = null;
  }
}

/** 读任务源码 → 推断 need → 按需探测权限 → 判定；任务不需要 AX/录屏时返回 null（不探测） */
async function taskPermissionGate(file) {
  let source = '';
  try { source = fs.readFileSync(file, 'utf8'); } catch { return null; }
  try { return await evaluateTaskPermissionGate({ source, allowOverride: overrideFromEnv() }); } catch { return null; }
}

/**
 * 环境跳过（缺权限）：不 spawn 任务，写一条 code=0 的日志 + history（envSkip=true）。
 * 这样健康统计/巡检不会把它记成 FAIL，也不会当成「运行中」。
 */
function envSkipEntry(name, attempt, gate) {
  fs.mkdirSync(LOGS, { recursive: true });
  const logFile = path.join(LOGS, name + '-' + new Date().toISOString().replace(/[:.]/g, '-') + '.log');
  const reason = gate.skipReason || '环境跳过：权限不足';
  try {
    fs.writeFileSync(logFile, [reason].concat(permissionSkipLines(gate)).join('\n') + '\n');
  } catch {}
  const entry = {
    name, attempt, ok: true, code: 0, cancelled: false,
    envSkip: true, skipReason: reason, frontSteals: 0,
    startedAt: new Date().toISOString(), durationMs: 0, logFile,
  };
  state.current = null;
  state.history.unshift(entry);
  state.history = state.history.slice(0, 200);
  console.log('[daemon] ' + reason);
  overlay.status('环境跳过：' + name + '（缺权限）', 'idle').catch(() => {});
  overlay.log(reason).catch(() => {});
  overlay.window(null).catch(() => {});
  return entry;
}

async function runTask(name, attempt = 0) {
  // 任务名必须是任务目录里真实存在的名字：不做校验会被 ../ 跳出目录执行任意脚本
  const available = listTasks();
  if (!available.includes(name)) {
    return { ok: false, error: '未知任务：' + name, available: available };
  }
  const file = path.join(TASKS_DIR, name + '.mjs');
  if (!fs.existsSync(file)) return { ok: false, error: '未知任务：' + name, available: available };

  // H1 权限闸门：需要 AX/录屏但系统没授权时按「环境跳过」处理（不 spawn、不记 FAIL）。
  // 探测失败（ocu doctor 读不到）时 evaluateTaskPermissionGate 会 proceed=true + warning，不会卡死队列。
  const gate = await taskPermissionGate(file);
  if (gate && gate.warning) {
    console.warn('[daemon] ' + gate.warning);
    overlay.log(gate.warning).catch(() => {});
  }
  if (gate && !gate.proceed) return envSkipEntry(name, attempt, gate);

  return await new Promise((resolve) => {
    fs.mkdirSync(LOGS, { recursive: true });
    const logFile = path.join(LOGS, name + '-' + new Date().toISOString().replace(/[:.]/g, '-') + '.log');
    const out = fs.createWriteStream(logFile);

    const startedAt = Date.now();
    // 任务自成进程组：daemon 退出或取消时按组收，避免 ocu/Chrome 孙进程变孤儿
    const child = spawn(process.execPath, [file], { detached: true, cwd: ROOT, env: { ...process.env, AGENTD_DAEMON: '1' } });
    state.current = { name, attempt, startedAt: new Date().toISOString(), pid: child.pid, logFile };
    // 备注：看门狗在下面启动，状态里只暴露"有没有在守"
    state.pendingRetry = null;
    state.cancelled = false;

    // 前台看门狗：任务期间前台被抢就还原（用户反复切同一应用 3 次以上则认账）
    // FRONT_GUARD=0 可整体关闭（调试或特殊场景用）
    //
    // 注意这里的竞态：frontAppFast 是异步的（约 120ms），如果任务很快就结束，
    // 回调会在任务结束后才创建看门狗 —— 那样它会一直轮询下去（泄漏）。
    // 所以用 taskSettled 标记，任务已结束就不再创建；并用模块级引用兜底停掉旧的。
    let taskSettled = false;
    if (process.env.FRONT_GUARD !== '0') frontAppFast().then((expect) => {
      if (!expect || taskSettled) return;
      stopActiveFrontWatch();
      activeFrontWatch = startFrontWatch({
        expect,
        onSteal: (e) => {
          if (e.userSwitched) return;
          overlay.log('前台被 ' + e.to + ' 抢占，已还原到 ' + e.from).catch(() => {});
        },
      });
    }).catch(() => {});
    overlay.status('后台任务：' + name + (attempt ? '（第 ' + (attempt + 1) + ' 次）' : '')).catch(() => {});
    overlay.log('开始执行 ' + name).catch(() => {});

    // 只留尾部 8KB 用于「这轮是不是环境跳过」的判定（任务输出可能很大，不能全留内存）
    let tail = '';
    const keepTail = (b) => {
      tail = (tail + b.toString()).slice(-8192);
      out.write(b);
    };
    child.stdout.on('data', keepTail);
    child.stderr.on('data', keepTail);

    // 超时不能只杀任务本身：任务是以 detached 起的独立进程组，组里的 ocu/Chrome 只 kill(pid) 收不到。
    // 统一走 killTaskTree：TERM 整组 -> 3 秒后还活着就 KILL 整组。
    const timer = setTimeout(() => {
      const sent = killTaskTree(child.pid, { graceMs: 3000 });
      overlay.log('任务超时，已结束进程组 pid=' + child.pid + (sent.term && sent.term.group ? '（整组）' : '')).catch(() => {});
    }, 10 * 60 * 1000);

    // 长时间任务期间每 4 秒喂一次状态，否则小窗 5 秒空闲就会自己消失，用户看不到进度
    const beat = setInterval(() => {
      const secs = Math.round((Date.now() - startedAt) / 1000);
      overlay.status('后台任务：' + name + ' · ' + secs + 's').catch(() => {});
    }, 4000);

    // spawn 失败（找不到可执行文件、权限不足）不会触发 close，必须单独接住并清理
    const failEarly = (err) => {
      clearInterval(beat);
      clearTimeout(timer);
      taskSettled = true;
      stopActiveFrontWatch();
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
      taskSettled = true;
      stopActiveFrontWatch();
      try { out.end(); } catch {}
      const durationMs = Date.now() - startedAt;
      const ok = code === 0;
      // 用户主动停止不是失败：单独标记，健康统计和自动重试都不该把它算进去
      const cancelled = state.cancelled === true;
      const guard = lastFrontWatchStats;
      // 环境跳过要和「真成功」分开：任务锁屏时退 0 + 打印环境跳过，如果只记 ok=true，
      // soak/monitor 会把整轮跳过说成「成功」（实测踩过）。
      const skipReason = ok ? envSkipReason(tail) : '';
      const entry = {
        name, attempt, ok, code, cancelled,
        envSkip: Boolean(skipReason), skipReason,
        frontSteals: guard ? guard.steals : 0,
        startedAt: new Date(startedAt).toISOString(), durationMs, logFile,
      };
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

/**
 * 只接受本机命令行客户端：浏览器页面发起的请求一律拒绝。
 * 否则任何网页都能通过表单/预检直接让守护进程跑任务（任务里有打字、退出应用这类动作）。
 */
function assertLocalClient(req) {
  // 先看 Host：挡 DNS rebinding（页面用 evil.com 解析到 127.0.0.1 打本地服务）
  const host = req.headers && req.headers.host;
  if (!isLoopbackHost(host)) {
    const error = new Error('拒绝非本机 Host 的请求（Host: ' + String(host || '').slice(0, 80) + '）');
    error.statusCode = 403;
    throw error;
  }
  const origin = req.headers && req.headers.origin;
  if (origin) {
    const error = new Error('拒绝浏览器来源的请求（Origin: ' + String(origin).slice(0, 80) + '）');
    error.statusCode = 403;
    throw error;
  }
  if ((req.method || 'GET') === 'POST') {
    const type = String((req.headers && req.headers['content-type']) || '');
    if (!/^application\/json\b/i.test(type)) {
      const error = new Error('POST 需要 Content-Type: application/json');
      error.statusCode = 415;
      throw error;
    }
  }
}

async function handleRequest(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname.replace(/\/+$/, '') || '/';
  try {
    assertLocalClient(req);
  } catch (error) {
    return json(res, error.statusCode || 403, { ok: false, error: String(error.message || error) });
  }
  // 除 GET /（存活探测，只回 pid/uptime）外，所有接口都要票据：
  // /status、/tasks、/stats 会带出任务历史与日志路径，也算信息泄漏；之前只挡写接口，
  // 和 SECURITY.md 写的「全部接口都要 token」不一致（评审指出）。
  const needsToken = p !== '/';
  // 默认只认请求头；?token= 会漏进 shell history / 进程列表，需要显式开 AGENT_ALLOW_QUERY_TOKEN=1
  const allowQueryToken = process.env.AGENT_ALLOW_QUERY_TOKEN === '1';
  if (needsToken && !isAuthorized(req.headers, TOKEN, {
    queryToken: url.searchParams.get('token') || '',
    allowQuery: allowQueryToken,
  })) {
    return json(res, 401, { ok: false, error: '缺少或无效的 X-Agent-Token（从 ~/.desktop-agent/api-token 读取）' });
  }

  if (p === '/' && req.method === 'GET') {
    // 存活探测要能无票调用（启动脚本/看门狗用），所以只回最小信息；
    // 任务列表、当前任务、日志路径这些一律放 /status（需要票）。
    return json(res, 200, {
      ok: true,
      service: 'desktop-agent-daemon',
      pid: state.pid,
      uptimeSec: Math.round((Date.now() - new Date(state.startedAt).getTime()) / 1000),
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
      // 必须按进程组收（负 pid）：只 kill(pid) 会留下任务拉起的 ocu/Chrome，
      // 而 Chrome 带着无鉴权的 --remote-debugging-port 会一直开着。3 秒不退再 KILL。
      const sent = killTaskTree(state.current.pid, { graceMs: 3000 });
      const how = sent.term && sent.term.group ? '进程组' : '单进程';
      overlay.log('已停止任务（SIGTERM ' + how + ' pid=' + state.current.pid + '）').catch(() => {});
    }
    return json(res, 200, { ok: true, stopped: hadTask, task: hadTask ? state.current.name : null });
  }

  return json(res, 404, { ok: false, error: 'not found', path: p });
}

const server = http.createServer(async (req, res) => {
  try {
    await handleRequest(req, res);
  } catch (error) {
    // 任何请求级异常都要变成 JSON 响应：之前 readBody 抛错会变成未处理 rejection，
    // 调用方只看到连接挂着，日志里也只有一行堆栈。
    if (res.headersSent) {
      try { res.end(); } catch {}
      return;
    }
    json(res, error && error.statusCode ? error.statusCode : 500, {
      ok: false,
      error: String((error && error.message) || error).slice(0, 200),
    });
  }
});
// 本地控制面不该被慢请求/半截请求拖住（默认 300s 太长）
server.requestTimeout = 20000;
server.headersTimeout = 15000;

// 端口被占时给一条能直接照做的错误，不要静默崩在 launchd 里反复重试
server.on('error', (error) => {
  if (error && error.code === 'EADDRINUSE') {
    execFile('/usr/sbin/lsof', ['-nP', '-iTCP:' + PORT, '-sTCP:LISTEN', '-t'], (err, stdout) => {
      const pid = String(stdout || '').trim().split('\n')[0] || '';
      console.error('[daemon] 端口 ' + PORT + ' 已被占用' + (pid ? '（pid ' + pid + '）' : '') +
        '：可能是手工启动的游离实例，launchd 拉不起来。先跑 npm run service:restart');
      process.exit(78);
    });
    return;
  }
  console.error('[daemon] 服务启动失败：' + String((error && error.message) || error));
  process.exit(1);
});


/** 启动时清一次孤儿：只清 ppid=1、当前用户、且命令行属于本项目（ocu/app-agent 或本项目 Chrome profile）的进程 */
async function cleanOrphanAgents() {
  try {
    const table = await new Promise((resolve) => {
      execFile('/bin/ps', ['-axo', 'pid=,ppid=,user=,command='], (err, stdout) => resolve(err ? '' : stdout));
    });
    const rows = parseProcessTable(table);
    // 两类孤儿：本项目依赖（ocu / app-agent）+ 本项目 profile 的残留 Chrome。
    // 后者带 --remote-debugging-port 却没人收：CDP 无鉴权，等于把已登录 profile 摊在同机任意进程面前。
    const pids = findOrphans(rows, { user: os.userInfo().username, selfPid: process.pid });
    if (!pids.length) return 0;
    // 孤儿是单个进程：这里只按 pid 杀，不用负 pid（它们的进程组可能已被回收/共用）
    for (const pid of pids) { try { process.kill(pid, 'SIGTERM'); } catch {} }
    await new Promise((r) => setTimeout(r, 1200));
    for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    console.log('[daemon] 清理孤儿进程：' + pids.join(', '));
    return pids.length;
  } catch {
    return 0;
  }
}

server.listen(PORT, '127.0.0.1', () => {
  console.log('[daemon] listening on 127.0.0.1:' + PORT + ' pid=' + state.pid);
  cleanOrphanAgents().catch(() => {});
  // 启动时顺手清一次旧日志/报告（默认留 7 天 / 200 份；PRUNE_ON_START=0 关闭）
  if (process.env.PRUNE_ON_START !== '0') {
    execFile(process.execPath, [path.join(ROOT, 'scripts/prune.mjs'), '--apply'], { cwd: ROOT, timeout: 30000 }, () => {});
  }
  overlay.status('后台服务已启动').catch(() => {});
  overlay.log('守护进程启动，端口 ' + PORT).catch(() => {});
});

/** 按进程组结束正在跑的任务：先 TERM 整组，5 秒不退再 KILL 整组，然后退出 daemon */
function shutdownWithRunningTask() {
  const current = state.current;
  const pid = current && current.pid;
  if (!pid) {
    try { server.close(); } catch {}
    process.exit(0);
    return;
  }
  // 和 /stop、超时分支共用同一份「先整组 TERM、再整组 KILL」实现，避免三条路径各写一遍
  signalProcessTree(pid, 'SIGTERM');
  const deadline = Date.now() + 5000;
  const tick = () => {
    const alive = isProcessAlive(pid);
    if (alive && Date.now() < deadline) {
      setTimeout(tick, 200);
      return;
    }
    if (alive) signalProcessTree(pid, 'SIGKILL');
    try { server.close(); } catch {}
    process.exit(0);
  };
  tick();
}

process.on('SIGTERM', () => {
  // 有任务在跑时不能直接 exit：那会把正在操作应用的进程留成孤儿
  if (state.current && state.current.pid) {
    console.log('[daemon] 收到 SIGTERM，先结束当前任务进程组 pid=' + state.current.pid);
    shutdownWithRunningTask();
    return;
  }
  server.close();
  process.exit(0);
});

// 常驻服务不该因为一次未捕获异常就整体退出：记日志、继续服务。
process.on('uncaughtException', (error) => {
  console.error('[daemon] 未捕获异常：', (error && error.stack) || error);
});
process.on('unhandledRejection', (error) => {
  console.error('[daemon] 未处理拒绝：', (error && error.stack) || error);
});
