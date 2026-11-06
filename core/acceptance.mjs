#!/usr/bin/env node
// 端到端验收：把关键能力跑一遍并出结论表
// 用法：node core/acceptance.mjs
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { overlay } from './agentd.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const RESULTS = [];

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: opts.timeout || 180000, maxBuffer: 64 * 1024 * 1024, cwd: ROOT }, (err, stdout, stderr) => {
      resolve({ code: err ? 1 : 0, stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

function record(name, ok, detail, skipped = false) {
  RESULTS.push({ name, ok, detail, skipped });
  const tag = skipped ? '  SKIP ' : (ok ? '  PASS ' : '  FAIL ');
  console.log(tag + name + '  ' + (detail || ''));
}

async function checkOverlay() {
  const h = await overlay.health();
  record('overlay 在线', !!h.ok, h.ok ? 'pid=' + h.pid : 'offline');
  return h;
}

async function checkIdleHide() {
  const before = await overlay.health();
  if (!before.ok) return record('空闲自动隐藏', false, 'overlay 不在线');
  await overlay.visible(false);
  await new Promise((r) => setTimeout(r, 500));
  const hidden = await overlay.health();
  record('手动隐藏生效', hidden.visible === false, 'visible=' + hidden.visible);
  await overlay.status('验收中');
  await new Promise((r) => setTimeout(r, 800));
  const shown = await overlay.health();
  record('活动触发显示', shown.visible === true, 'visible=' + shown.visible);
}

async function runTask(name, timeoutMs = 180000) {
  const r = await run('node', ['core/runner.mjs', 'run', name, '--timeout', String(timeoutMs)]);
  const out = r.stdout + r.stderr;
  // 环境原因跳过（用户正在使用目标应用 / 不在目标页面）不算失败
  const skipped = /当前就是前台|不打扰用户|跳过扫描/.test(out);
  const ok = r.code === 0 || skipped;
  record('任务 ' + name, ok, ok ? (skipped ? '环境跳过（用户正在使用）' : '') : out.slice(-200).replace(/\n/g, ' '), skipped);
  return ok;
}

async function main() {
  console.log('=== 桌面代理端到端验收 ===');
  const h = await checkOverlay();
  if (h.ok) await checkIdleHide();

  const scanOk = await runTask('boss-scan');
  const multiOk = await runTask('multi-app');
  const writeOk = await runTask('form-fill');
  const browserOk = await runTask('browser-demo');
  const electronOk = await runTask('electron-demo');

  const passed = RESULTS.filter((r) => r.ok && !r.skipped).length;
  const skipped = RESULTS.filter((r) => r.skipped).length;
  const total = RESULTS.length;
  console.log('\n结果: ' + passed + '/' + (total - skipped) + ' 通过' + (skipped ? '，' + skipped + ' 项环境跳过' : ''));
  for (const r of RESULTS) console.log((r.ok ? '  ✅ ' : '  ❌ ') + r.name);

  const dir = path.join(ROOT, 'reports');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'acceptance-' + new Date().toISOString().replace(/[:.]/g, '-') + '.md');
  const lines = [
    '# 桌面代理验收报告',
    '',
    '时间：' + new Date().toISOString(),
    '结果：' + passed + '/' + (total - skipped) + (skipped ? '（环境跳过 ' + skipped + ' 项）' : ''),
    '',
    '| 项目 | 结果 | 说明 |',
    '| --- | --- | --- |',
    ...RESULTS.map((r) => '| ' + r.name + ' | ' + (r.ok ? 'PASS' : 'FAIL') + ' | ' + (r.detail || '') + ' |'),
  ];
  fs.writeFileSync(file, lines.join('\n') + '\n');
  console.log('报告：' + file);
  process.exit(passed === total ? 0 : 1);
}

main().catch((e) => {
  console.error('FAIL:', e.message);
  process.exit(2);
});
