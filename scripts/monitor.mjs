#!/usr/bin/env node
// 一键巡检：健康 + 小窗效果 + 会话隔离 + 帧率，汇总成一份报告，便于定期看效果。
//   npm run monitor
//   MONITOR_FAST=1 npm run monitor   # 跳过小窗效果回归，缩短到约 30 秒
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const FAST = process.env.MONITOR_FAST === '1';

function runNode(script, args, env) {
  return new Promise((resolve) => {
    const started = Date.now();
    execFile(process.execPath, [path.join(ROOT, 'scripts', script), ...(args || [])], {
      cwd: ROOT,
      timeout: 300000,
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, ...(env || {}) },
    }, (err, stdout, stderr) => {
      const out = String(stdout || '') + String(stderr || '');
      resolve({ ok: !err, ms: Date.now() - started, out });
    });
  });
}

const lines = (text) => String(text || '').split('\n').map((s) => s.replace(/\s+$/, '')).filter(Boolean);
const pick = (text, re) => (lines(text).find((l) => re.test(l)) || '').trim();

async function main() {
  const steps = [];
  const startedAt = new Date();

  // 1. 整体健康（--deep 会带上 14 项小窗效果回归）
  const health = await runNode('health.mjs', FAST ? [] : ['--deep']);
  const healthy = lines(health.out).filter((l) => /^\s+✅|^\s+❌/.test(l));
  steps.push({
    name: FAST ? '整体健康' : '整体健康 + 小窗效果回归',
    ok: health.ok,
    ms: health.ms,
    detail: healthy.filter((l) => l.includes('❌')).join(' ') || (healthy.length + ' 项全部正常'),
  });

  // 2. 会话隔离（小窗只在该会话出现、切走/切回耗时）
  const scope = await runNode('session-scope-check.mjs');
  const hide = pick(scope.out, /切走后消失/);
  const back = pick(scope.out, /切回后重新出现/);
  steps.push({
    name: '会话隔离',
    ok: scope.ok,
    ms: scope.ms,
    detail: [hide.replace(/^\s*✅\s*/, ''), back.replace(/^\s*✅\s*/, '')].filter(Boolean).join('｜') || '未通过',
  });

  // 3. 帧率（默认 12 秒）
  const fps = await runNode('fps-check.mjs', [], { FPS_CHECK_SECONDS: process.env.MONITOR_FPS_SECONDS || '12' });
  const fpsLine = pick(fps.out, /目标\/实际帧率/);
  const byteLine = pick(fps.out, /单帧体积/);
  const pushLine = pick(fps.out, /推一帧耗时/);
  steps.push({
    name: '帧率压测',
    ok: fps.ok,
    ms: fps.ms,
    detail: [fpsLine, byteLine, pushLine].map((s) => s.replace(/^\s{2}/, '')).filter(Boolean).join('｜') || '未通过',
  });

  const failed = steps.filter((s) => !s.ok);
  const w = Math.max(...steps.map((s) => s.name.length)) + 2;
  console.log('\n巡检结果（' + startedAt.toLocaleString('zh-CN') + '）\n');
  for (const s of steps) {
    console.log((s.ok ? '  ✅ ' : '  ❌ ') + s.name.padEnd(w) + (s.ms / 1000).toFixed(1) + 's  ' + s.detail);
  }
  console.log('\n' + (failed.length ? failed.length + ' 项未通过：' + failed.map((s) => s.name).join('、') : '全部正常') + '\n');

  const dir = path.join(ROOT, 'reports');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'monitor-' + new Date().toISOString().replace(/[:.]/g, '-') + '.md');
  const md = [
    '# 巡检报告',
    '',
    '- 时间：' + startedAt.toISOString(),
    '- 结果：' + (failed.length ? failed.length + ' 项未通过' : '全部正常'),
    '',
    '| 项目 | 结果 | 耗时 | 关键数据 |',
    '| --- | --- | --- | --- |',
    ...steps.map((s) => '| ' + s.name + ' | ' + (s.ok ? 'PASS' : 'FAIL') + ' | ' + (s.ms / 1000).toFixed(1) + 's | ' + s.detail.replace(/\|/g, '/') + ' |'),
    '',
  ].join('\n');
  fs.writeFileSync(file, md);
  console.log('报告：reports/' + path.basename(file) + '\n');
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
