'use strict';
// M-1：任务停止/超时改成「杀进程组」，避免遗留带 --remote-debugging-port 的 Chrome。
// 这里测的是可注入的信号/时序逻辑（不依赖真实进程），最后一组用真实子进程验证负 pid 真的能连孙进程一起收掉。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  signalProcessTree,
  killTaskTree,
  isProcessAlive,
  DEFAULT_KILL_GRACE_MS,
} from '../core/orphan-cleanup.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- signalProcessTree ----------

test('优先按进程组杀（负 pid）', () => {
  const calls = [];
  const r = signalProcessTree(1234, 'SIGTERM', (pid, signal) => { calls.push([pid, signal]); });
  assert.deepEqual(calls, [[-1234, 'SIGTERM']]);
  assert.equal(r.ok, true);
  assert.equal(r.group, true);
});

test('没有独立进程组时回退到单 pid', () => {
  const calls = [];
  const kill = (pid, signal) => {
    calls.push([pid, signal]);
    if (pid < 0) { const e = new Error('no such process group'); e.code = 'ESRCH'; throw e; }
  };
  const r = signalProcessTree(42, 'SIGTERM', kill);
  assert.deepEqual(calls, [[-42, 'SIGTERM'], [42, 'SIGTERM']]);
  assert.equal(r.ok, true);
  assert.equal(r.group, false);
});

test('两种都失败也不抛，返回 ok=false', () => {
  const r = signalProcessTree(7, 'SIGKILL', () => { throw Object.assign(new Error('denied'), { code: 'EPERM' }); });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'EPERM');
});

test('pid 非法时一个信号都不发（挡住 kill(-0) 自杀）', () => {
  let calls = 0;
  for (const bad of [0, -5, NaN, null, undefined, '']) {
    signalProcessTree(bad, 'SIGTERM', () => { calls += 1; });
  }
  assert.equal(calls, 0, 'pid<=0/NaN 不能发出任何信号');
});

// ---------- killTaskTree ----------

function fakeKill(calls) {
  return (pid, signal) => { calls.push([pid, signal]); };
}

test('先 TERM 整组，宽限期到了才 KILL 整组', () => {
  const calls = [];
  let scheduled = null;
  const r = killTaskTree(900, {
    kill: fakeKill(calls),
    isAlive: () => true,
    graceMs: 3000,
    schedule: (fn, ms) => { scheduled = { fn, ms }; return 1; },
  });

  assert.deepEqual(calls, [[-900, 'SIGTERM']], '第一步只能发 TERM');
  assert.ok(scheduled, '必须排一个宽限定时器');
  assert.equal(scheduled.ms, 3000);
  assert.equal(r.hardKillScheduled, true);

  scheduled.fn();
  assert.deepEqual(calls, [[-900, 'SIGTERM'], [-900, 'SIGKILL']], '宽限期到 → 整组 KILL');
  assert.equal(r.hardKill.ok, true);
});

test('宽限期内进程已退出就不再补 KILL', () => {
  const calls = [];
  let scheduled = null;
  const r = killTaskTree(901, {
    kill: fakeKill(calls),
    isAlive: () => false,
    schedule: (fn, ms) => { scheduled = { fn, ms }; return 1; },
  });
  scheduled.fn();
  assert.deepEqual(calls, [[-901, 'SIGTERM']], '已经退出的进程不该再收到 KILL');
  assert.equal(r.hardKill.skipped, true);
});

test('graceMs=0 时直接 KILL（不留宽限）', () => {
  const calls = [];
  const r = killTaskTree(902, { kill: fakeKill(calls), isAlive: () => true, graceMs: 0 });
  assert.deepEqual(calls, [[-902, 'SIGTERM'], [-902, 'SIGKILL']]);
  assert.equal(r.hardKillScheduled, false);
});

test('cancel 之后不再补 KILL', () => {
  const calls = [];
  let scheduled = null;
  const r = killTaskTree(903, {
    kill: fakeKill(calls),
    isAlive: () => true,
    schedule: (fn, ms) => { scheduled = { fn, ms }; return 1; },
  });
  r.cancel();
  scheduled.fn();
  assert.deepEqual(calls, [[-903, 'SIGTERM']], '取消后不该再有动作');
});

test('pid 无效时直接返回，不发信号也不排定时器', () => {
  let calls = 0;
  let scheduled = 0;
  const r = killTaskTree(0, {
    kill: () => { calls += 1; },
    schedule: () => { scheduled += 1; return 1; },
  });
  assert.equal(calls, 0);
  assert.equal(scheduled, 0);
  assert.equal(r.term.ok, false);
});

test('默认宽限期是 3 秒（评审要求：TERM 后留 3 秒再 KILL）', () => {
  assert.equal(DEFAULT_KILL_GRACE_MS, 3000);
  let ms = null;
  killTaskTree(904, { kill: () => {}, isAlive: () => true, schedule: (fn, delay) => { ms = delay; return 1; } });
  assert.equal(ms, 3000);
});

test('isProcessAlive：自己活着，非法 pid 一律 false', () => {
  assert.equal(isProcessAlive(process.pid), true);
  assert.equal(isProcessAlive(0), false);
  assert.equal(isProcessAlive(NaN), false);
});

// ---------- 真实子进程：负 pid 必须能连孙进程一起收掉 ----------

test('真实进程组：killTaskTree 连孙进程一起结束', async () => {
  // 任务进程（组长）拉一个同组的孙进程，模拟「任务拉起 ocu/Chrome」
  const childScript = [
    "const { spawn } = require('node:child_process');",
    "const g = spawn(process.execPath, ['-e', 'setTimeout(function(){}, 60000)'], { stdio: 'ignore' });",
    "process.stdout.write(String(g.pid) + '\\n');",
    "setTimeout(function () {}, 60000);",
  ].join('\n');

  const task = spawn(process.execPath, ['-e', childScript], {
    detached: true,                       // 和 runner/daemon 起任务的方式一致
    stdio: ['ignore', 'pipe', 'ignore'],
  });

  // 清理只用「确认大于 0」的 pid：process.kill(0, ...) 会打中自己所在的进程组，
  // 一旦上面的等待超时（孙进程 pid 还没拿到），就会把测试进程组一起轰掉——踩过一次。
  const cleanup = () => {
    try { signalProcessTree(task.pid, 'SIGKILL'); } catch {}
    if (Number(grandchildPid) > 0) { try { process.kill(grandchildPid, 'SIGKILL'); } catch {} }
  };
  let grandchildPid = 0;
  try {
    grandchildPid = await new Promise((resolve, reject) => {
      let buf = '';
      const timer = setTimeout(() => reject(new Error('孙进程 pid 迟迟没打印')), 8000);
      task.stdout.on('data', (b) => {
        buf += b.toString();
        const line = buf.split('\n')[0].trim();
        if (/^\d+$/.test(line)) { clearTimeout(timer); resolve(Number(line)); }
      });
      task.on('error', (e) => { clearTimeout(timer); reject(e); });
    });
    assert.ok(isProcessAlive(task.pid), '组长应还活着');
    assert.ok(isProcessAlive(grandchildPid), '孙进程应还活着');

    const r = killTaskTree(task.pid, { graceMs: 500 });
    assert.equal(r.term.ok, true);
    assert.equal(r.term.group, true, '应当是从进程组下手（负 pid 生效）');

    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (!isProcessAlive(task.pid) && !isProcessAlive(grandchildPid)) break;
      await sleep(100);
    }
    assert.equal(isProcessAlive(task.pid), false, '组长应被结束');
    assert.equal(isProcessAlive(grandchildPid), false, '孙进程必须一起被结束（只杀组长会漏）');
  } finally {
    cleanup();
  }
});

// ---------- 端到端：daemon 的 POST /stop 必须收掉整个任务进程组 ----------
// 评审 M-1 的原始场景：任务里拉起的 Chrome/Electron 不在 daemon 的进程树里，
// 只 kill(pid) 时它们会活下来（Chrome 还带着无鉴权的 --remote-debugging-port）。

import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readToken } from '../core/local-token.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

async function waitFor(check, timeoutMs, stepMs = 100) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await check().catch(() => null);
    if (v) return v;
    await sleep(stepMs);
  }
  return null;
}

test('/stop 会连任务拉起的孙进程一起结束（只杀 pid 会漏）', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'daemon-stop-'));
  const pidFile = path.join(dir, 'grandchild.pid');
  // 任务：拉一个同进程组的孙进程（模拟 ocu/Chrome），然后自己长睡
  await fs.writeFile(path.join(dir, 'spawn-child.mjs'), [
    "import { spawn } from 'node:child_process';",
    "import fs from 'node:fs';",
    "const g = spawn(process.execPath, ['-e', 'setTimeout(function(){}, 60000)'], { stdio: 'ignore' });",
    "fs.writeFileSync(" + JSON.stringify(pidFile) + ", String(g.pid));",
    "console.log('grandchild=' + g.pid);",
    "setTimeout(function () {}, 60000);",
  ].join(String.fromCharCode(10)));

  const port = await freePort();
  const token = await readToken();
  const headers = { 'Content-Type': 'application/json', ...(token ? { 'X-Agent-Token': token } : {}) };
  const base = 'http://127.0.0.1:' + port;

  const daemon = spawn(process.execPath, [path.join(ROOT, 'core', 'daemon.mjs')], {
    cwd: ROOT,
    env: {
      ...process.env,
      AGENTD_PORT: String(port),
      AGENTD_TASKS_DIR: dir,
      AGENTD_MAX_RETRIES: '0',
      PRUNE_ON_START: '0',            // 测试不能顺带裁真日志
      OVERLAY_URL: 'http://127.0.0.1:1',
    },
    stdio: 'ignore',
  });
  t.after(async () => {
    try { daemon.kill('SIGTERM'); } catch {}
    await fs.rm(dir, { recursive: true, force: true });
  });

  const up = await waitFor(async () => (await fetch(base + '/')).ok, 15000);
  assert.ok(up, 'daemon 没能在 15 秒内起来');

  await fetch(base + '/run', { method: 'POST', headers, body: JSON.stringify({ task: 'spawn-child' }) });

  const taskPid = await waitFor(async () => {
    const st = await (await fetch(base + '/status', { headers })).json();
    return st.current && st.current.name === 'spawn-child' ? st.current.pid : null;
  }, 15000);
  assert.ok(taskPid, '任务应当开始运行');

  const grandchildPid = await waitFor(async () => {
    try {
      const raw = (await fs.readFile(pidFile, 'utf8')).trim();
      return /^\d+$/.test(raw) ? Number(raw) : null;
    } catch { return null; }
  }, 15000);
  assert.ok(grandchildPid, '孙进程 pid 应当被写出来');
  assert.ok(isProcessAlive(grandchildPid), '孙进程这时应该活着');

  const stopped = await (await fetch(base + '/stop', { method: 'POST', headers, body: '{}' })).json();
  assert.equal(stopped.ok, true);
  assert.equal(stopped.stopped, true);

  const allDead = await waitFor(async () => {
    const taskDead = !isProcessAlive(taskPid);
    const childDead = !isProcessAlive(grandchildPid);
    return taskDead && childDead ? { taskDead, childDead } : null;
  }, 8000);
  assert.ok(allDead, '任务进程和它拉起的孙进程都必须被结束（' + JSON.stringify({
    taskAlive: isProcessAlive(taskPid), grandchildAlive: isProcessAlive(grandchildPid),
  }) + '）');

  // 兜底：万一断言失败也别把孙进程留在机器上
  if (isProcessAlive(grandchildPid)) { try { process.kill(grandchildPid, 'SIGKILL'); } catch {} }
});
