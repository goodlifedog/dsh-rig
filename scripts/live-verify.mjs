#!/usr/bin/env node
/**
 * 解锁后的完整验收入口：一条命令把「必须有屏幕」的验证按顺序跑完并出报告。
 *
 *   npm run verify:live
 *   LIVE_KEEP_AWAKE=1 npm run verify:live   # 用 caffeinate 保持亮屏，防止跑一半自动锁屏
 *   LIVE_FORCE=1 npm run verify:live        # 无视「用户刚动过键鼠」的保护
 *
 * 锁屏时直接打印环境跳过并退 0（不假装跑过）；用户正在用电脑时拒绝执行（会切窗口打扰）。
 */
import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isScreenLocked } from '../core/platform.mjs';
import { classifyLiveStep, summarizeLiveSteps, midRunStopReason } from '../core/live-verify.mjs';
import { overlayBase } from '../core/ports.mjs';
import { localHeaders } from '../core/local-token.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const KEEP_AWAKE = process.env.LIVE_KEEP_AWAKE === '1';
const FORCE = process.env.LIVE_FORCE === '1';
// 启动门槛：默认要求键鼠空闲 15 分钟（不是 3 分钟）——3 分钟常常只是用户去倒杯水，
// 回来就看见屏幕在切。想更快跑：LIVE_MIN_IDLE_SEC=180。
const MIN_IDLE_MS = Math.max(0, Number(process.env.LIVE_MIN_IDLE_SEC || 900)) * 1000;
// 跑的过程中用户一回来（键鼠空闲小于这个值）就立刻杀掉当前步骤
const ABORT_IDLE_MS = Math.max(5000, Number(process.env.LIVE_ABORT_IDLE_SEC || 20) * 1000);
const OVERLAY = overlayBase();

/** 停下时把任务可能弹出的小窗收掉：关非 default 会话、default 隐藏 */
async function tidyOverlay() {
  const post = async (p, body) => {
    try {
      await fetch(OVERLAY + p, { method: 'POST', headers: localHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify(body || {}), signal: AbortSignal.timeout(1500) });
    } catch {}
  };
  let sessions = [];
  try {
    const res = await fetch(OVERLAY + '/sessions', { headers: localHeaders(), signal: AbortSignal.timeout(1500) });
    sessions = (await res.json()).sessions || [];
  } catch {}
  for (const s of sessions) {
    if (s.session === 'default') await post('/visible', { session: 'default', visible: false });
    else await post('/close', { session: s.session });
  }
}

// 顺序有讲究：先跑最重的端到端验收，再跑分项，最后性能 —— 任何一步真失败都不影响后面把证据跑全
const STEPS = [
  { name: '端到端验收', script: 'core/acceptance.mjs', timeoutMs: 900000 },
  { name: '后台控制验收', script: 'scripts/bg-verify.mjs', timeoutMs: 900000 },
  { name: '小窗效果回归', script: 'scripts/ui-regression.mjs', timeoutMs: 300000 },
  { name: '会话隔离', script: 'scripts/session-scope-check.mjs', timeoutMs: 300000 },
  { name: '帧率压测', script: 'scripts/fps-check.mjs', timeoutMs: 240000 },
];

/** 用户最近有没有在用电脑（HID 空闲时间，毫秒） */
function hidIdleMs() {
  try {
    const out = execFileSync('/usr/sbin/ioreg', ['-c', 'IOHIDSystem', '-d', '4'], { encoding: 'utf8', timeout: 3000 });
    const m = /"HIDIdleTime" = (\d+)/.exec(out);
    return m ? Math.round(Number(m[1]) / 1e6) : -1;
  } catch {
    return -1;
  }
}

function runStep(step) {
  return new Promise((resolve) => {
    const started = Date.now();
    const args = KEEP_AWAKE
      ? ['/usr/bin/caffeinate', '-d', '-i', process.execPath, path.join(ROOT, step.script)]
      : [process.execPath, path.join(ROOT, step.script)];
    const cmd = args.shift();
    // detached：整个步骤自成一个进程组，用户回来时能连它起的子进程一起停掉
    const child = spawn(cmd, args, { cwd: ROOT, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let timedOut = false;
    let aborted = false;
    const killGroup = (sig) => {
      try { process.kill(-child.pid, sig); } catch {}
      try { child.kill(sig); } catch {}
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup('SIGKILL');
    }, step.timeoutMs);
    const poll = setInterval(() => {
      if (FORCE) return;
      const idle = hidIdleMs();
      if (idle >= 0 && idle < ABORT_IDLE_MS) {
        aborted = true;
        killGroup('SIGTERM');
        // 给任务链一点时间做应急清理（关掉自己拉起的应用）；不听话的 3 秒后强杀
        setTimeout(() => killGroup('SIGKILL'), 3000);
      }
    }, 1000);
    child.stdout.on('data', (b) => { out += b; });
    child.stderr.on('data', (b) => { out += b; });
    const done = (code) => {
      clearTimeout(timer);
      clearInterval(poll);
      resolve({ code: timedOut ? 124 : code, out, ms: Date.now() - started, timedOut, aborted, limitMs: step.timeoutMs });
    };
    child.on('error', () => done(1));
    child.on('close', (code) => done(code));
  });
}

async function main() {
  if (await isScreenLocked()) {
    console.log('环境跳过：屏幕已锁，需要解锁才能跑这些验证（解锁后：npm run verify:live）');
    return;
  }
  if (!FORCE && hidIdleMs() >= 0 && hidIdleMs() < MIN_IDLE_MS) {
    const mins = Math.round(MIN_IDLE_MS / 60000);
    console.error('检测到你还在电脑前（键鼠空闲 < ' + mins + ' 分钟），验收会切窗口，先不跑。');
    console.error('确实要跑：LIVE_FORCE=1 npm run verify:live（跑的过程中你一碰键鼠，它会立刻停）');
    process.exitCode = 2;
    return;
  }

  const steps = [];
  await tidyOverlay();
  try {
  for (const step of STEPS) {
    const userActive = !FORCE && hidIdleMs() >= 0 && hidIdleMs() < ABORT_IDLE_MS;
    const stop = midRunStopReason({ locked: await isScreenLocked(), userActive });
    if (stop) {
      steps.push({ name: step.name, status: 'SKIP', ms: 0, detail: '环境跳过：' + stop + '（本轮不再继续）' });
      console.log('  ⏭  ' + step.name + '  环境跳过：' + stop);
      continue;
    }
    process.stdout.write('跑 ' + step.name + ' … ');
    const result = await runStep(step);
    if (result.aborted) {
      steps.push({ name: step.name, status: 'SKIP', ms: result.ms, detail: '环境跳过：你一碰键鼠就停了（已杀掉当前步骤，不再动屏幕）' });
      console.log('⏭ SKIP  你回到电脑前，已立刻停止  ' + (result.ms / 1000).toFixed(1) + 's');
      // 等任务链把应急清理做完（关掉自己拉起应用），再收小窗
      await new Promise((r) => setTimeout(r, 1500));
      await tidyOverlay();
      break;
    }
    const verdict = classifyLiveStep(result);
    steps.push({ name: step.name, status: verdict.status, ms: result.ms, detail: verdict.detail });
    const mark = verdict.status === 'PASS' ? '✅' : (verdict.status === 'SKIP' ? '⏭' : '❌');
    console.log(mark + ' ' + verdict.status + '  ' + (verdict.detail || '') + '  ' + (result.ms / 1000).toFixed(1) + 's');
  }
  } finally {
    // 不管正常跑完还是中途停，都把任务可能弹出的小窗收拾干净
    await tidyOverlay();
  }

  const summary = summarizeLiveSteps(steps);
  const w = Math.max(...steps.map((s) => s.name.length)) + 2;
  console.log('\n解锁验收（' + new Date().toLocaleString('zh-CN') + '）\n');
  for (const s of steps) {
    const mark = s.status === 'PASS' ? '  ✅ ' : (s.status === 'SKIP' ? '  ⏭  ' : '  ❌ ');
    console.log(mark + s.name.padEnd(w) + s.status.padEnd(6) + (s.detail || ''));
  }
  console.log('\n' + summary.text + '\n');

  const dir = path.join(ROOT, 'reports');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'live-verify-' + new Date().toISOString().replace(/[:.]/g, '-') + '.md');
  const lines = [
    '# 解锁验收报告',
    '',
    '- 时间：' + new Date().toISOString(),
    '- 结果：' + summary.text,
    '',
    '| 项目 | 结果 | 耗时 | 说明 |',
    '| --- | --- | --- | --- |',
    ...steps.map((s) => '| ' + s.name + ' | ' + s.status + ' | ' + ((s.ms || 0) / 1000).toFixed(1) + 's | ' + String(s.detail || '').replace(/\|/g, '/') + ' |'),
    '',
  ].join('\n');
  fs.writeFileSync(file, lines);
  console.log('报告：reports/' + path.basename(file));
  process.exit(summary.ok ? 0 : 1);
}

main().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
