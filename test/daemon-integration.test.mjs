'use strict';
// daemon 集成测试：起一个独立端口 + 临时任务目录，验证队列、失败归类与自动重试。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import { readToken } from '../core/local-token.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

/**
 * 起测试用 daemon 前先要一个空闲端口。
 * 以前写死 7791：两个会话同时跑测试（实测有并行评审会话）会抢同一端口，
 * 表现为「daemon 没能在 15 秒内起来」这种偶发失败。
 */
async function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

const PORT = await freePort();
const TOKEN = await readToken();
const TOKEN_HEADERS = TOKEN ? { 'X-Agent-Token': TOKEN } : {};
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
    'env-skip-task': 'console.log("环境跳过：锁屏测试"); process.exit(0);\n',
    // 缺权限导致任务失败：daemon 也要按环境跳过归类，不能记真 FAIL（复核 M1）
    'perm-fail-task': 'console.error("Accessibility permission is required to read the app state"); process.exit(1);\n',
    'long-task': 'setTimeout(function () {}, 30000);\n',
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

  const gets = (p) => fetch(BASE + p, { headers: TOKEN_HEADERS, signal: AbortSignal.timeout(3000) });

  const up = await waitFor(async () => {
    const r = await gets('/');
    return r.ok ? true : null;
  }, 15000);
  assert.ok(up, 'daemon 没能在 15 秒内起来');

  // 控制面票据：写接口必须带 token，否则 401
  const noToken = await fetch(BASE + '/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ task: 'ok-task' }),
  });
  assert.equal(noToken.status, 401, '没带 token 的 /run 必须拒绝');

  // 只读接口也要票据（会带出任务历史与日志路径），唯一例外是 GET / 存活探测：
  // 它只回 ok/pid/uptime，不能带任务列表，否则等于变相绕过票据读 /status。
  assert.equal((await fetch(BASE + '/status')).status, 401, '无票读 /status 必须拒绝');
  assert.equal((await fetch(BASE + '/tasks')).status, 401, '无票读 /tasks 必须拒绝');
  assert.equal((await fetch(BASE + '/stats')).status, 401, '无票读 /stats 必须拒绝');
  const bareRoot = await (await fetch(BASE + '/')).json();
  assert.equal(bareRoot.ok, true);
  assert.equal(bareRoot.tasks, undefined, '存活探测不能暴露任务列表');
  assert.equal(bareRoot.current, undefined, '存活探测不能暴露当前任务');
  assert.ok((await gets('/status')).ok, '带票读 /status 必须正常');

  // 目录穿越：不存在的任务名必须被拒，且不能真的去执行目录外脚本
  for (const evil of ['../core/runner', '../../etc/passwd', 'ok-task/../../x', 'ok-task.mjs']) {
    const res = await fetch(BASE + '/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...TOKEN_HEADERS },
      body: JSON.stringify({ task: evil }),
    });
    assert.equal(res.status, 400, '应拒绝可疑任务名：' + evil);
  }

  // 安全边界：浏览器来源（带 Origin）一律拒绝，避免网页直接驱动守护进程跑任务
  const fromBrowser = await fetch(BASE + '/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
    body: JSON.stringify({ task: 'ok-task' }),
  });
  assert.equal(fromBrowser.status, 403, '带 Origin 的请求必须拒绝');

  // 请求体格式/大小：超限 413、坏 JSON 400、非对象 400；而且坏请求之后服务必须还活着
  const tooBig = await fetch(BASE + '/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...TOKEN_HEADERS },
    body: 'x'.repeat(1024 * 1024 + 10),
  }).catch(() => ({ status: 0 }));
  assert.equal(tooBig.status, 413, '超大请求体应 413');
  const badJson = await fetch(BASE + '/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...TOKEN_HEADERS },
    body: '{bad json',
  });
  assert.equal(badJson.status, 400, '坏 JSON 应 400');
  const arrayBody = await fetch(BASE + '/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...TOKEN_HEADERS },
    body: '[1,2]',
  });
  assert.equal(arrayBody.status, 400, '非对象 JSON 应 400');
  assert.equal((await gets('/status')).status, 200, '坏请求之后服务必须还活着');

  // 安全边界：Host 不是本机回环一律拒绝（挡 DNS rebinding：evil.com 解析到 127.0.0.1）
  const spoofedHost = await new Promise((resolve) => {
    const rq = http.request({ host: '127.0.0.1', port: PORT, path: '/', method: 'GET', headers: { Host: 'evil.example:' + PORT } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    rq.on('error', () => resolve(0));
    rq.end();
  });
  assert.equal(spoofedHost, 403, '非本机 Host 必须拒绝');

  // 安全边界：非 JSON 的 POST（表单式跨站提交）一律拒绝
  const formPost = await fetch(BASE + '/run', {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify({ task: 'ok-task' }),
  });
  assert.equal(formPost.status, 415, '非 JSON 的 POST 必须拒绝');

  // 队列上限：上限 3 时一次塞 4 个应当被 429 拒绝（且不会真的入队）
  const overflow = await fetch(BASE + '/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...TOKEN_HEADERS },
    body: JSON.stringify({ tasks: ['ok-task', 'ok-task', 'ok-task', 'ok-task'] }),
  });
  assert.equal(overflow.status, 429, '超过队列上限应返回 429');
  const afterOverflow = await (await gets('/status')).json();
  assert.equal(afterOverflow.queue.length, 0, '被拒绝的请求不应入队');

  const started = Date.now();
  await fetch(BASE + '/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...TOKEN_HEADERS },
    body: JSON.stringify({ tasks: ['ok-task', 'flaky-task', 'hard-fail'] }),
  });

  // 必须同时满足：没有正在跑、没有排队、也没有「等待退避重跑」的待办
  const idle = await waitFor(async () => {
    const st = await (await gets('/status')).json();
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

  const stats = await (await gets('/stats')).json();
  assert.equal(stats.runs, 4, '统计应包含 4 次运行（3 + 1 次重试）');
  assert.equal(stats.retries, 1, '统计里应记录 1 次重试');
  assert.equal(stats.okRate, 25, '4 次里只有 1 次成功');

  // 环境跳过要以 envSkip 标记出来：任务退 0 + 打印「环境跳过」，daemon 不能把它当普通成功
  await fetch(BASE + '/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...TOKEN_HEADERS },
    body: JSON.stringify({ task: 'env-skip-task' }),
  });
  const skipRun = await waitFor(async () => {
    const st = await (await gets('/status')).json();
    const hit = (st.history || []).find((h) => h.name === 'env-skip-task');
    return hit && !st.current ? hit : null;
  }, 20000);
  assert.ok(skipRun, '环境跳过任务没有跑完');
  assert.equal(skipRun.ok, true, '退 0 仍然算 ok');
  assert.equal(skipRun.envSkip, true, '必须标出 envSkip，否则 soak/monitor 会当成验证成功');
  const stats2 = await (await gets('/stats')).json();
  assert.equal(stats2.runs, 5);
  assert.equal(stats2.envSkips, 1, '统计里要单列环境跳过次数');
  assert.equal(stats2.okRate, 25, '成功率分母要排除环境跳过（1 成功 / 4 次真跑）');

  // /stop：清队列 + 停当前任务，历史要标 cancelled（不能当失败、也不该触发重试）
  await fetch(BASE + '/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...TOKEN_HEADERS },
    body: JSON.stringify({ tasks: ['long-task', 'long-task'] }),
  });
  const running = await waitFor(async () => {
    const st = await (await gets('/status')).json();
    return st.current && st.current.name === 'long-task' ? st : null;
  }, 15000);
  assert.ok(running, '长任务应当开始运行');
  assert.equal((running.queue || []).length, 1, '第二个长任务应在队列里');
  const stopped = await (await fetch(BASE + '/stop', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...TOKEN_HEADERS },
    body: '{}',
  })).json();
  assert.equal(stopped.ok, true);
  assert.equal(stopped.stopped, true, '/stop 应报告停掉了任务');
  const afterStop = await waitFor(async () => {
    const st = await (await gets('/status')).json();
    const hit = (st.history || []).find((h) => h.name === 'long-task');
    return !st.current && hit ? { st, hit } : null;
  }, 15000);
  assert.ok(afterStop, '/stop 后任务应退出');
  assert.equal(afterStop.hit.cancelled, true, '主动停止要标 cancelled');
  assert.equal((afterStop.st.queue || []).length, 0, '/stop 要清空队列');

  // 复核 M1：失败轮次也要按「权限缺失 = 环境跳过」归类（与 acceptance/run-classify 同一口径），
  // 否则 daemon 记真 FAIL、验收对同一份输出记 SKIP，健康面板会忽红忽绿。
  await fetch(BASE + '/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...TOKEN_HEADERS },
    body: JSON.stringify({ task: 'perm-fail-task' }),
  });
  const permFail = await waitFor(async () => {
    const st = await (await gets('/status')).json();
    const hit = (st.history || []).find((h) => h.name === 'perm-fail-task');
    return hit && !st.current ? hit : null;
  }, 20000);
  assert.ok(permFail, '缺权限失败任务没有跑完');
  assert.equal(permFail.ok, false, '退出码 1 仍然要如实记 ok=false');
  assert.equal(permFail.envSkip, true, '权限缺失导致的失败必须标 envSkip');
  assert.match(String(permFail.skipReason || ''), /辅助功能权限/, '跳过原因要说清缺哪项权限');
});