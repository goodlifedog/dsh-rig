#!/usr/bin/env node
// 生产任务运行器：注册表 + 串行/重试 + 结构化日志 + overlay 状态推送
//
// 用法：
//   node core/runner.mjs list
//   node core/runner.mjs run boss-scan
//   node core/runner.mjs run boss-scan --retries 2 --timeout 300000
//
// 任务 = core/tasks/ 下的任意 .mjs 文件，独立子进程运行，互不污染。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { overlay } from './agentd.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TASKS_DIR = path.join(__dirname, 'tasks');
const LOG_DIR = path.join(__dirname, '..', 'logs', 'runs');

function listTasks() {
  if (!fs.existsSync(TASKS_DIR)) return [];
  return fs
    .readdirSync(TASKS_DIR)
    .filter((f) => f.endsWith('.mjs'))
    .map((f) => ({ name: f.replace(/\.mjs$/, ''), file: path.join(TASKS_DIR, f) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

export async function runOnce(task, options = {}) {
  const opts = options || {};
  const timeoutMs = opts.timeoutMs;
  const logDir = opts.logDir || LOG_DIR;
  const spawnFn = opts.spawn || spawn;
  const startedAt = Date.now();
  const logFile = path.join(logDir, stamp() + '-' + task.name + '.jsonl');
  await fsp.mkdir(logDir, { recursive: true });
  const fd = await fsp.open(logFile, 'a');

  const record = (entry) => {
    const line = JSON.stringify({ ts: new Date().toISOString(), task: task.name, ...entry });
    // 原来用 void fd.write(...) 异步写、不等：close 与写有竞态，进程退出时最后几行可能丢，
    // 甚至在 fd 已关闭后写会抛未捕获异常。日志是排障的唯一线索，这里改成同步写。
    try { fs.writeSync(fd.fd, line + '\n'); } catch {}
  };
  record({ event: 'start', pid: process.pid });

  return await new Promise((resolve) => {
    // detached 让任务自成进程组：超时/取消时按组杀，避免任务脚本拉起的 ocu/Chrome 变成孤儿
    const child = spawnFn(process.execPath, [task.file], {
      detached: true,
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, AGENTD_RUNNER: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    currentChild = child;
    // 把任务子进程 pid 记进日志：出问题时要能查到"这个任务到底拉起了哪些进程"
    record({ event: 'task-spawned', taskPid: child.pid });

    let stdout = '';
    let stderr = '';
    let lastLineAt = 0;

    const onData = (buf, stream) => {
      const text = buf.toString();
      if (stream === 'out') stdout += text;
      else stderr += text;
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        record({ event: 'line', stream, text: line });
        lastLineAt = Date.now();
        console.log('  │ ' + line);
      }
    };

    child.stdout.on('data', (b) => onData(b, 'out'));
    child.stderr.on('data', (b) => onData(b, 'err'));

    const timer = setTimeout(() => {
      record({ event: 'timeout', afterMs: timeoutMs });
      // 先礼后兵：TERM 整组，5 秒后还在就 KILL 整组（卡在系统调用里的任务不理 TERM）
      const killGroup = (signal) => {
        try { process.kill(-child.pid, signal); } catch { try { child.kill(signal); } catch {} }
      };
      killGroup('SIGTERM');
      const hardTimer = setTimeout(() => {
        record({ event: 'timeout-kill', afterMs: timeoutMs + 5000 });
        killGroup('SIGKILL');
      }, 5000);
      hardTimer.unref();
    }, timeoutMs);

    // spawn 失败（ENOENT/权限/资源不足）只会发 'error'，不保证发 'close'：
    // 不接住就是主进程未捕获异常，任务「凭空消失」且日志里没有原因。
    let settled = false;
    const finish = async (payload) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (currentChild === child) currentChild = null;
      const durationMs = Date.now() - startedAt;
      record({ event: 'end', code: payload.code, signal: payload.signal, durationMs, stdoutBytes: stdout.length, stderrBytes: stderr.length, spawnError: payload.spawnError || undefined });
      try { await fd.close(); } catch {}
      resolve(Object.assign({ durationMs, stdout, stderr, logFile, lastLineAt }, payload));
    };

    child.on('error', (error) => {
      const message = '任务进程启动失败：' + ((error && error.message) || error);
      record({ event: 'spawn-error', error: message });
      console.error('[runner] ' + message);
      void finish({ code: null, signal: '', spawnError: message });
    });

    child.on('close', (code, signal) => {
      void finish({ code, signal });
    });
  });
}

// 当前正在跑的任务子进程：runner 收到 TERM 时要转发给它的进程组。
// 不做这一步的话：daemon 杀 runner 的进程组，任务因为在另一个组里会继续跑，它拉起的 ocu/Chrome 就变孤儿。
let currentChild = null;

function forwardSignalToTask(signal) {
  if (!currentChild || !currentChild.pid) return false;
  try {
    process.kill(-currentChild.pid, signal);
    return true;
  } catch {
    try { currentChild.kill(signal); return true; } catch { return false; }
  }
}

process.on('SIGTERM', () => {
  forwardSignalToTask('SIGTERM');
  // 给任务 4 秒收尾，再补 KILL 并退出；超时也要退，别让 daemon 等死
  setTimeout(() => {
    forwardSignalToTask('SIGKILL');
    process.exit(0);
  }, 4000).unref();
});

async function runTask(name, { retries = 1, timeoutMs = 300000 } = {}) {
  const tasks = listTasks();
  const task = tasks.find((t) => t.name === name);
  if (!task) throw new Error('未知任务：' + name + '（可用：' + tasks.map((t) => t.name).join(', ') + '）');

  let attempt = 0;
  const attempts = [];
  while (attempt < retries) {
    attempt += 1;
    console.log('[runner] ' + name + ' 第 ' + attempt + '/' + retries + ' 次');
    await overlay.status('运行任务：' + name + (retries > 1 ? '（' + attempt + '/' + retries + '）' : ''));
    const r = await runOnce(task, { timeoutMs });
    attempts.push({ attempt, code: r.code, durationMs: r.durationMs });

    if (r.code === 0) {
      console.log('[runner] 成功，用时 ' + (r.durationMs / 1000).toFixed(1) + 's，日志 ' + r.logFile);
      await overlay.status('任务完成：' + name);
      return { ok: true, attempts, logFile: r.logFile };
    }

    console.log('[runner] 失败 code=' + r.code + (attempt < retries ? '，准备重试' : ''));
    await overlay.log('任务失败：' + name + ' code=' + r.code);
    if (attempt < retries) await new Promise((res) => setTimeout(res, 2000));
  }

  await overlay.status('任务失败：' + name);
  return { ok: false, attempts };
}

// ---------- CLI ----------
// 被测试 import 时不能执行 CLI（否则会按 argv 直接 process.exit）
const invokedDirectly = Boolean(process.argv[1])
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
const argv = process.argv.slice(2);
const cmd = argv[0];
const opt = (key, dflt) => {
  const i = argv.indexOf('--' + key);
  return i >= 0 ? argv[i + 1] : dflt;
};

if (invokedDirectly) {
  if (!cmd || cmd === 'list') {
    const tasks = listTasks();
    console.log('可用任务（' + tasks.length + '）：');
    for (const t of tasks) console.log('  ' + t.name.padEnd(20) + path.relative(process.cwd(), t.file));
    process.exit(0);
  }

  if (cmd === 'run') {
    const name = argv[1];
    runTask(name, {
      retries: Math.max(1, Number(opt('retries', 1)) || 1),
      timeoutMs: Math.max(1000, Number(opt('timeout', 300000)) || 300000),
    })
      .then((r) => process.exit(r.ok ? 0 : 1))
      .catch((e) => {
        console.error('[runner] ' + e.message);
        process.exit(2);
      });
  } else {
    console.error('未知命令：' + cmd + '（可用：list / run）');
    process.exit(2);
  }
}
