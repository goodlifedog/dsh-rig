'use strict';
// daemon 集成测试：起一个独立端口 + 临时任务目录，验证队列、失败归类与自动重试。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PORT = 7791;
const BASE = 'http://127.0.0.1:' + PORT;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(check, timeoutMs, stepMs = 200) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try { last = await check(); } catch { last = null; }
    if (last) return last;
    await sleep(stepMs);
  }
  return null;
}

test('daemon：队列串行、环境失败不重试、临时失败重试一次', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'daemon-test-'));
  const tasks = {
    'ok-task': 'console.log("ok"); process.exit(0);\n',
    'flaky-task': 'console.error("FAIL: 等待 Chrome 调试端口超时"); process.exit(1);\n',
    'hard-fail': 'console.error("FAIL: 断言不成立：标题不对"); process.exit(1);\n',
  };
  for (const [name, body] of Object.entries(tasks)) {
    await fs.writeFile(path.join(dir, name + '.mjs'), body);
  }

  const child = spawn(process.execPath, [path.join(ROOT, 'core', 'daemon.mjs')], {
    cwd: ROOT,
    env: {
      ...process.env,
      AGENTD_PORT: String(PORT),
      AGENTD_TASKS_DIR: dir,
      AGENTD_MAX_RETRIES: '1',
      AGENTD_MAX_QUEUE: '3',
      OVERLAY_URL: 'http://127.0.0.1:1',   // 小窗不存在，调用直接失败但不影响任务
    },
    stdio: 'ignore',
  });

  t.after(async () => {
    try { child.kill('SIGTERM'); } catch {}
    await fs.rm(dir, { recursive: true, force: true });
  });

  const up = await waitFor(async () => {
    const r = await fetch(BASE + '/status', { signal: AbortSignal.timeout(1000) });
    return r.ok ? true : null;
  }, 15000);
  assert.ok(up, 'daemon 没能在 15 秒内起来');

  // 目录穿越：不存在的任务名必须被拒，且不能真的去执行目录外脚本
  for (const evil of ['../core/runner', '../../etc/passwd', 'ok-task/../../x', 'ok-task.mjs']) {
    const res = await fetch(BASE + '/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task: evil }),
    });
    assert.equal(res.status, 400, '应拒绝可疑任务名：' + evil);
  }

  // 队列上限：上限 3 时一次塞 4 个应当被 429 拒绝（且不会真的入队）
  const overflow = await fetch(BASE + '/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tasks: ['ok-task', 'ok-task', 'ok-task', 'ok-task'] }),
  });
  assert.equal(overflow.status, 429, '超过队列上限应返回 429');
  const afterOverflow = await (await fetch(BASE + '/status')).json();
  assert.equal(afterOverflow.queue.length, 0, '被拒绝的请求不应入队');

  const started = Date.now();
  await fetch(BASE + '/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tasks: ['ok-task', 'flaky-task', 'hard-fail'] }),
  });

  // 必须同时满足：没有正在跑、没有排队、也没有「等待退避重跑」的待办
  const idle = await waitFor(async () => {
    const st = await (await fetch(BASE + '/status')).json();
    const idleNow = !st.current && (!st.queue || st.queue.length === 0) && !st.pendingRetry;
    return idleNow && st.history.length >= 4 ? st : null;
  }, 30000);
  assert.ok(idle, '任务没有在 30 秒内跑完');

  const byName = {};
  for (const h of idle.history) {
    byName[h.name] = byName[h.name] || [];
    byName[h.name].push(h);
  }

  assert.equal(byName['ok-task'].length, 1, '成功的任务只应跑一次');
  assert.equal(byName['ok-task'][0].ok, true);
  assert.equal(byName['flaky-task'].length, 2, '临时性失败应自动重试一次');
  assert.deepEqual(byName['flaky-task'].map((h) => h.attempt || 0).sort(), [0, 1]);
  assert.equal(byName['hard-fail'].length, 1, '断言失败不应重试');

  // 队列是串行的：三条任务的总耗时应至少等于各任务耗时之和
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 3000, '重试有退避，总耗时应该超过 3 秒');

  const stats = await (await fetch(BASE + '/stats')).json();
  assert.equal(stats.runs, 4, '统计应包含 4 次运行（3 + 1 次重试）');
  assert.equal(stats.retries, 1, '统计里应记录 1 次重试');
  assert.equal(stats.okRate, 25, '4 次里只有 1 次成功');
});
