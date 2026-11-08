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

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const KEEP_AWAKE = process.env.LIVE_KEEP_AWAKE === '1';
const FORCE = process.env.LIVE_FORCE === '1';

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
    const child = spawn(cmd, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch {}
    }, step.timeoutMs);
    child.stdout.on('data', (b) => { out += b; });
    child.stderr.on('data', (b) => { out += b; });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: timedOut ? 124 : code, out, ms: Date.now() - started, timedOut, limitMs: step.timeoutMs });
    });
  });
}

async function main() {
  if (await isScreenLocked()) {
    console.log('环境跳过：屏幕已锁，需要解锁才能跑这些验证（解锁后：npm run verify:live）');
    return;
  }
  if (!FORCE && hidIdleMs() >= 0 && hidIdleMs() < 180000) {
    console.error('检测到你正在用电脑（键鼠空闲 < 180 秒），验收会切窗口，先不跑。');
    console.error('确实要跑：LIVE_FORCE=1 npm run verify:live');
    process.exitCode = 2;
    return;
  }

  const steps = [];
  for (const step of STEPS) {
    const stop = midRunStopReason({ locked: await isScreenLocked(), userActive: false });
    if (stop) {
      steps.push({ name: step.name, status: 'SKIP', ms: 0, detail: '环境跳过：' + stop + '（本轮不再继续）' });
      console.log('  ⏭  ' + step.name + '  环境跳过：' + stop);
      continue;
    }
    process.stdout.write('跑 ' + step.name + ' … ');
    const result = await runStep(step);
    const verdict = classifyLiveStep(result);
    steps.push({ name: step.name, status: verdict.status, ms: result.ms, detail: verdict.detail });
    const mark = verdict.status === 'PASS' ? '✅' : (verdict.status === 'SKIP' ? '⏭' : '❌');
    console.log(mark + ' ' + verdict.status + '  ' + (verdict.detail || '') + '  ' + (result.ms / 1000).toFixed(1) + 's');
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
