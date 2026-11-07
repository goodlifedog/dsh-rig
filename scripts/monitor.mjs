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

// 环境跳过：锁屏等情况下被检脚本会退 0 并打印「环境跳过：…」，这时候不能算失败、也别硬编明细
const skipLine = (text) => lines(text).find((l) => /环境跳过/.test(l)) || '';

// 明细兜底：过去统一回落成「未通过」，于是出现「✅ 会话隔离 … 未通过」这种自相矛盾的行
function detailOr(parts, ok) {
  const text = (parts || []).filter(Boolean).join('｜');
  if (text) return text;
  return ok ? '（本项没有明细输出）' : '未通过（且无输出）';
}

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
    skipped: false,
  });

  // 2. 会话隔离（小窗只在该会话出现、切走/切回耗时）
  const scope = await runNode('session-scope-check.mjs');
  const hide = pick(scope.out, /切走后消失/);
  const back = pick(scope.out, /切回后重新出现/);
  steps.push({
    name: '会话隔离',
    ok: scope.ok,
    ms: scope.ms,
    skipped: Boolean(skipLine(scope.out)),
    detail: skipLine(scope.out) || detailOr([hide.replace(/^\s*✅\s*/, ''), back.replace(/^\s*✅\s*/, '')], scope.ok),
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
    skipped: Boolean(skipLine(fps.out)),
    detail: skipLine(fps.out) || detailOr([fpsLine, byteLine, pushLine].map((s) => s.replace(/^\s{2}/, '')), fps.ok),
  });

  // 4. 稳定性：短跑 2 轮，抓「任务变慢/失败」这类回归（完整巡检用 npm run soak）
  const soak = await runNode('soak.mjs', [], { SOAK_ROUNDS: '2' });
  const soakResult = pick(soak.out, /任务结果/);
  const soakMem = pick(soak.out, /小窗内存/);
  steps.push({
    name: '任务稳定性',
    ok: soak.ok,
    ms: soak.ms,
    skipped: Boolean(skipLine(soak.out)),
    detail: skipLine(soak.out) || detailOr([soakResult, soakMem].map((s) => s.replace(/^\s{2}/, '')), soak.ok),
  });

  const failed = steps.filter((s) => !s.ok && !s.skipped);
  const skippedSteps = steps.filter((s) => s.skipped);
  const w = Math.max(...steps.map((s) => s.name.length)) + 2;
  console.log('\n巡检结果（' + startedAt.toLocaleString('zh-CN') + '）\n');
  for (const s of steps) {
    const mark = s.skipped ? '  ⏭️ ' : (s.ok ? '  ✅ ' : '  ❌ ');
    console.log(mark + s.name.padEnd(w) + (s.ms / 1000).toFixed(1) + 's  ' + s.detail);
  }
  const skipNote = skippedSteps.length ? '，环境跳过 ' + skippedSteps.length + ' 项' : '';
  console.log('\n' + (failed.length ? failed.length + ' 项未通过：' + failed.map((s) => s.name).join('、') : '全部正常') + skipNote + '\n');

  const dir = path.join(ROOT, 'reports');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'monitor-' + new Date().toISOString().replace(/[:.]/g, '-') + '.md');
  const md = [
    '# 巡检报告',
    '',
    '- 时间：' + startedAt.toISOString(),
    '- 结果：' + (failed.length ? failed.length + ' 项未通过' : '全部正常')
      + (skippedSteps.length ? '（环境跳过 ' + skippedSteps.length + ' 项）' : ''),
    '',
    '| 项目 | 结果 | 耗时 | 关键数据 |',
    '| --- | --- | --- | --- |',
    ...steps.map((s) => '| ' + s.name + ' | ' + (s.skipped ? 'SKIP' : (s.ok ? 'PASS' : 'FAIL')) + ' | ' + (s.ms / 1000).toFixed(1) + 's | ' + s.detail.replace(/\|/g, '/') + ' |'),
    '',
  ].join('\n');
  fs.writeFileSync(file, md);
  console.log('报告：reports/' + path.basename(file) + '\n');
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
