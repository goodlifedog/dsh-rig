#!/usr/bin/env node
/**
 * 控制台入口：启停后台服务、提交任务、看状态。
 *   node core/cli.mjs start        启动后台守护进程
 *   node core/cli.mjs stop         停止
 *   node core/cli.mjs status       查看状态
 *   node core/cli.mjs run <任务名>  提交任务
 *   node core/cli.mjs tasks        列出任务
 */
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { readToken, withTokenHeaders } from './local-token.mjs';
import { attachSpawnError } from './safety.mjs';
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
  let spawnError = '';
  attachSpawnError(child, (error) => { spawnError = String((error && error.message) || error); });
  fs.writeFileSync(PID_FILE, String(child.pid));
  for (let i = 0; i < 30; i++) {
    await sleep(300);
    if (await alive()) { console.log('已启动，pid=' + child.pid); return; }
    if (spawnError) break;
  }
  console.error('启动失败' + (spawnError ? '：' + spawnError : '（超时，检查 logs/daemon.out）'));
  process.exitCode = 1;
}

function launchdManaged() {
  try {
    const uid = typeof process.getuid === 'function' ? process.getuid() : 501;
    execFileSync('/bin/launchctl', ['print', 'gui/' + uid + '/com.desktop-agent.daemon'], { stdio: 'ignore', timeout: 3000 });
    return true;
  } catch { return false; }
}

async function stop() {
  if (!(await alive())) { console.log('后台服务未运行'); return; }
  // 只停当前任务；这一步对两种部署方式都安全
  try { await api('/stop', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); } catch {}

  if (launchdManaged()) {
    // launchd 托管时：KeepAlive 会把杀掉的进程立刻拉回来，所以这里不能谎报「已停止」
    console.log('当前任务已停止；后台服务由 launchd 托管，不会随 stop 退出。');
    console.log('  暂停服务：launchctl bootout gui/' + (typeof process.getuid === 'function' ? process.getuid() : 501) + '/com.desktop-agent.daemon');
    console.log('  彻底卸载：npm run service:uninstall');
    console.log('  重启服务：npm run service:restart');
    return;
  }

  let pid = 0;
  try { pid = Number(fs.readFileSync(PID_FILE, 'utf8')); } catch {}
  if (!pid) { console.log('没有 pid 文件，无法确认怎么停；如装了服务请用 npm run service:uninstall'); return; }
  try { process.kill(pid, 'SIGTERM'); } catch {}
  for (let i = 0; i < 20; i += 1) {
    await sleep(200);
    if (!(await alive())) { console.log('已停止'); return; }
  }
  console.error('发了 SIGTERM 但服务还在跑（pid ' + pid + '），请检查 logs/daemon.out');
  process.exitCode = 1;
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
  console.error('用法：node core/cli.mjs <start|stop|status|tasks|run <任务名>>');
  process.exitCode = 2;   // 未知子命令按参数错误处理，避免脚本里的 || die 误判成功
}

main().catch((e) => { console.error(e.message); process.exit(1); });
