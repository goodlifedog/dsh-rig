#!/usr/bin/env node
/**
 * 控制台入口：启停后台服务、提交任务、看状态。
 *   node core/cli.mjs start        启动后台守护进程
 *   node core/cli.mjs stop         停止
 *   node core/cli.mjs status       查看状态
 *   node core/cli.mjs run <任务名>  提交任务
 *   node core/cli.mjs tasks        列出任务
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { readToken, withTokenHeaders } from './local-token.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const DAEMON = path.join(__dirname, 'daemon.mjs');
const PORT = Number(process.env.AGENTD_PORT || 7789);
const BASE = 'http://127.0.0.1:' + PORT;
const PID_FILE = path.join(ROOT, 'logs', 'daemon.pid');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(pathname, opts) {
  // 会动东西的接口要带票据；只读接口服务端不校验，带了也无害
  const token = await readToken();
  const options = Object.assign({}, opts || {});
  options.headers = withTokenHeaders(token, (opts && opts.headers) || {});
  const res = await fetch(BASE + pathname, { ...options, signal: AbortSignal.timeout(5000) });
  return await res.json();
}

async function alive() {
  try { await api('/'); return true; } catch { return false; }
}

async function start() {
  if (await alive()) { console.log('后台服务已在运行'); return; }
  fs.mkdirSync(path.dirname(PID_FILE), { recursive: true });
  const out = fs.openSync(path.join(ROOT, 'logs', 'daemon.out'), 'a');
  const child = spawn(process.execPath, [DAEMON], { cwd: ROOT, detached: true, stdio: ['ignore', out, out] });
  child.unref();
  fs.writeFileSync(PID_FILE, String(child.pid));
  for (let i = 0; i < 30; i++) {
    await sleep(300);
    if (await alive()) { console.log('已启动，pid=' + child.pid); return; }
  }
  console.log('启动超时，检查 logs/daemon.out');
}

async function stop() {
  if (!(await alive())) { console.log('后台服务未运行'); return; }
  try { await api('/stop', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); } catch {}
  try {
    const pid = Number(fs.readFileSync(PID_FILE, 'utf8'));
    process.kill(pid, 'SIGTERM');
  } catch {}
  console.log('已停止');
}

async function status() {
  if (!(await alive())) { console.log('后台服务未运行（node core/cli.mjs start）'); return; }
  const s = await api('/status');
  const up = Math.round((Date.now() - new Date(s.startedAt).getTime()) / 1000);
  console.log('后台服务 : 运行中 pid=' + s.pid + ' | 已运行 ' + up + 's');
  console.log('当前任务 : ' + (s.current ? s.current.name : '空闲'));
  console.log('队列     : ' + s.queue.length);
  if (s.history.length) {
    console.log('最近任务 :');
    for (const h of s.history.slice(0, 5)) {
      console.log('  ' + (h.ok ? '✅' : '❌') + ' ' + h.name.padEnd(18) + (h.durationMs / 1000).toFixed(1) + 's');
    }
  }
}

async function main() {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === 'start') return start();
  if (cmd === 'stop') return stop();
  if (cmd === 'status') return status();
  if (cmd === 'tasks') {
    const t = await api('/tasks').catch(() => null);
    console.log(t ? t.tasks.join('\n') : '后台服务未运行');
    return;
  }
  if (cmd === 'run') {
    if (!arg) { console.log('用法：node core/cli.mjs run <任务名>'); return; }
    const r = await api('/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ task: arg }) });
    console.log(JSON.stringify(r));
    return;
  }
  console.log('用法：node core/cli.mjs <start|stop|status|tasks|run <任务名>>');
}

main().catch((e) => { console.error(e.message); process.exit(1); });
