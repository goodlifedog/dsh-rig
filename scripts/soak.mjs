'use strict';
// 长时间跑怕掉帧、涨内存、任务越来越慢：连续跑几轮任务并采样小窗与进程指标。
//   node scripts/soak.mjs            默认 6 轮
//   SOAK_ROUNDS=12 node scripts/soak.mjs
import { execFileSync } from 'node:child_process';
import { readToken, withTokenHeaders } from '../core/local-token.mjs';

const DAEMON = process.env.AGENTD_URL || 'http://127.0.0.1:7789';
const OVERLAY = process.env.OVERLAY_URL || 'http://127.0.0.1:7788';
const ROUNDS = Math.max(1, Number(process.env.SOAK_ROUNDS) || 6);
// 默认交替跑两个 demo：一个偏控制（electron-demo）、一个会推帧（headless-demo），
// 这样帧率/画面这一路也能被采样到，而不是只看耗时
const TASKS = (process.env.SOAK_TASKS || 'electron-demo,headless-demo').split(',').map((s) => s.trim()).filter(Boolean);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const getJson = async (url, timeout = 3000) => {
  try { return await (await fetch(url, { signal: AbortSignal.timeout(timeout) })).json(); } catch { return null; }
};
const postJson = async (url, body) => {
  try {
    const token = await readToken();
    const headers = withTokenHeaders(token, { 'Content-Type': 'application/json' });
    const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body || {}), signal: AbortSignal.timeout(5000) });
    return await r.json();
  } catch { return null; }
};

function rssMb(pid) {
  if (!pid) return 0;
  try {
    const out = execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8', timeout: 5000 }).trim();
    return Math.round((Number(out) || 0) / 1024);
  } catch { return 0; }
}

async function waitIdle(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const st = await getJson(DAEMON + '/status');
    if (st && !st.current && (!st.queue || st.queue.length === 0)) return st;
    await sleep(400);
  }
  return null;
}

async function main() {
  const before = await getJson(DAEMON + '/status');
  if (!before) { console.log('❌ 后台 daemon 没起来（7789）'); process.exit(1); }
  const health0 = await getJson(OVERLAY + '/health');
  const pid = health0 && health0.pid;
  // 用「开始时间」当边界：/status 只回最近 30 条，靠长度差在记录满 30 条后会算错
  const sinceStartedAt = (before.history && before.history[0] && before.history[0].startedAt) || null;

  const samples = [];
  const startedAll = Date.now();
  for (let i = 0; i < ROUNDS; i += 1) {
    const task = TASKS[i % TASKS.length];
    const t0 = Date.now();
    await postJson(DAEMON + '/run', { task });
    const idle = await waitIdle(120000);
    const h = await getJson(OVERLAY + '/health');
    samples.push({
      round: i + 1,
      task,
      ms: Date.now() - t0,
      finished: Boolean(idle),
      visible: h ? h.visible : null,
      fps: h ? h.fps : null,
      frameBytes: h ? h.frameBytes : null,
      rss: rssMb(pid),
    });
    process.stdout.write('  第 ' + String(i + 1) + ' 轮 ' + task + '：' + (Date.now() - t0) + 'ms，内存 ' + samples[samples.length - 1].rss + 'MB\n');
  }

  const after = await getJson(DAEMON + '/status');
  const history = (after && after.history) || [];
  const newRuns = sinceStartedAt
    ? history.filter((h) => h && h.startedAt && h.startedAt > sinceStartedAt)
    : history.slice(0, ROUNDS);
  const failures = newRuns.filter((h) => h && h.ok === false);
  const rssStart = samples[0] ? samples[0].rss : 0;
  const rssEnd = samples[samples.length - 1] ? samples[samples.length - 1].rss : 0;
  const rssDelta = rssEnd - rssStart;
  const slowest = samples.reduce((a, b) => (b.ms > a.ms ? b : a), samples[0] || { ms: 0, task: '-' });
  const fpsValues = samples.map((s) => s.fps).filter((v) => typeof v === 'number' && v > 0);

  // 收尾：别把任务状态挂在胶囊上
  await postJson(OVERLAY + '/status', { clear: true });
  await postJson(OVERLAY + '/visible', { visible: false });

  const rows = [
    ['轮次', String(ROUNDS) + ' 轮｜用时 ' + Math.round((Date.now() - startedAll) / 1000) + 's'],
    ['任务结果', (newRuns.length - failures.length) + '/' + newRuns.length + ' 成功' + (failures.length ? '（失败：' + failures.map((f) => f.name).join(', ') + '）' : '')],
    ['最慢一轮', slowest ? slowest.task + ' ' + slowest.ms + 'ms' : '-'],
    ['小窗内存', rssStart + 'MB → ' + rssEnd + 'MB（变化 ' + (rssDelta >= 0 ? '+' : '') + rssDelta + 'MB）'],
    ['有帧的采样', fpsValues.length + '/' + samples.length + (fpsValues.length ? '（fps ' + Math.min(...fpsValues) + '–' + Math.max(...fpsValues) + '）' : '')],
  ];
  const width = Math.max(...rows.map((r) => r[0].length)) + 2;
  console.log('\n稳定性巡检\n');
  for (const [k, v] of rows) console.log('  ' + k.padEnd(width) + v);

  const problems = [];
  if (!newRuns.length) problems.push('daemon 没记录到运行结果');
  if (failures.length) problems.push(failures.length + ' 轮任务失败');
  if (rssDelta > 80) problems.push('内存增长 ' + rssDelta + 'MB，疑似泄漏');
  // 帧率只作为参考信息：采样点恰好落在任务间隙时 fps 会是 0，不代表链路有问题
  // （专门的帧率验证用 npm run fps:check，那里是连续推帧）
  console.log('\n' + (problems.length ? '需要关注：' + problems.join('；') : '表现稳定') + '\n');
  process.exit(problems.length ? 1 : 0);
}

main().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
