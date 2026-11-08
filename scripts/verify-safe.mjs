#!/usr/bin/env node
/**
 * 「不碰屏幕」的验收：用户正在用电脑时也能放心跑。
 *
 *   npm run verify:safe
 *
 * 只跑不抢前台/不开可见窗口的项：语法与安全自查、健康、平台自检、应用清点、
 * CDP 通道（headless）、AppleScript 只读通道、并发验证（隐藏计算器 + headless 浏览器）。
 * 会动屏幕的验收（端到端 / 后台控制 / 小窗回归 / 会话隔离 / 帧率）不在这里，见 verify:live。
 */
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyLiveStep, summarizeLiveSteps } from '../core/live-verify.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const STEPS = [
  { name: '语法检查', args: ['scripts/syntax-check.mjs'] },
  { name: '安全边界自查', args: ['scripts/safety-audit.mjs'] },
  { name: '健康检查', args: ['scripts/health.mjs'] },
  { name: '平台自检', args: ['core/platform-smoke.mjs'] },
  { name: '应用清点', args: ['scripts/app-inventory.mjs'] },
  { name: 'CDP 通道（headless）', args: ['core/tasks/cdp-channel.mjs'], timeoutMs: 180000 },
  { name: 'AppleScript 只读通道', args: ['core/tasks/applescript-channel.mjs'], timeoutMs: 120000 },
  { name: '并发验证（隐藏应用 + headless 浏览器）', args: ['core/tasks/concurrent-demo.mjs'], timeoutMs: 180000 },
];

function run(args, timeoutMs) {
  return new Promise((resolve) => {
    const started = Date.now();
    execFile(process.execPath, args.map((a) => path.join(ROOT, a)), {
      cwd: ROOT,
      timeout: timeoutMs || 120000,
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env },
    }, (err, stdout, stderr) => {
      const timedOut = Boolean(err && err.killed);
      resolve({
        code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
        out: String(stdout || '') + String(stderr || ''),
        ms: Date.now() - started,
        timedOut,
        limitMs: timeoutMs || 120000,
      });
    });
  });
}

const steps = [];
for (const step of STEPS) {
  process.stdout.write('跑 ' + step.name + ' … ');
  const result = await run(step.args, step.timeoutMs);
  const verdict = classifyLiveStep(result);
  steps.push({ name: step.name, status: verdict.status, ms: result.ms, detail: verdict.detail });
  const mark = verdict.status === 'PASS' ? '✅' : (verdict.status === 'SKIP' ? '⏭' : '❌');
  console.log(mark + ' ' + verdict.status + '  ' + (verdict.detail || '') + '  ' + (result.ms / 1000).toFixed(1) + 's');
}

const summary = summarizeLiveSteps(steps);
const w = Math.max(...steps.map((s) => s.name.length)) + 2;
console.log('\n不碰屏幕的验收（' + new Date().toLocaleString('zh-CN') + '）\n');
for (const s of steps) {
  const mark = s.status === 'PASS' ? '  ✅ ' : (s.status === 'SKIP' ? '  ⏭  ' : '  ❌ ');
  console.log(mark + s.name.padEnd(w) + s.status.padEnd(6) + (s.detail || ''));
}
console.log('\n' + summary.text + '\n');
console.log('这一组全程不抢前台、不开可见窗口，用户正在用电脑时也可以跑。');
console.log('会动屏幕的完整验收在：npm run verify:live（要求键鼠空闲 ≥15 分钟，运行中你一碰键鼠就停）\n');
process.exit(summary.ok ? 0 : 1);
