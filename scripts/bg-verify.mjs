#!/usr/bin/env node
/**
 * 一条命令跑完「后台控制 + 前台不受影响」的全部验收，并汇总成报告。
 *
 *   npm run bg:verify
 *
 * 依次跑：应用矩阵 → 冷启动 → 稳定性 → 后台浏览器 → 用户在用A时控B
 * 锁屏时各项自己会报「环境跳过」，不会给出误导性结论。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

// 每项一个合理的上限：既不一刀切误杀，也不让卡死的检查拖住整轮
const CHECKS = [
  { name: '应用能力矩阵', script: 'core/tasks/app-matrix.mjs', timeoutMs: 240000 },
  { name: '冷启动不跳前台', script: 'core/tasks/cold-launch.mjs', timeoutMs: 90000 },
  { name: '后台操作稳定性', script: 'core/tasks/background-stability.mjs', timeoutMs: 90000 },
  { name: '后台浏览器', script: 'core/tasks/browser-background.mjs', timeoutMs: 120000 },
  { name: '用户在用A时控B', script: 'core/tasks/user-active-demo.mjs', timeoutMs: 90000 },
  { name: '终端后台控制', script: 'core/tasks/terminal-control.mjs', timeoutMs: 60000 },
];

// 单项超时：某个检查卡住时不能把整轮验收拖死
const DEFAULT_TIMEOUT_MS = Math.max(10000, Number(process.env.BG_VERIFY_TIMEOUT_MS) || 300000);

function run(script, timeoutMs) {
  const limit = Math.max(5000, Number(timeoutMs) || DEFAULT_TIMEOUT_MS);
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [path.join(ROOT, script)], { cwd: ROOT, env: { ...process.env } });
    let out = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch {}
    }, limit);
    child.stdout.on('data', (b) => { out += b; });
    child.stderr.on('data', (b) => { out += b; });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: timedOut ? 124 : (code === null ? 1 : code), ms: Date.now() - started, out, timedOut, limit });
    });
  });
}

function classify(result, name) {
  if (result.timedOut) return { status: 'FAIL', detail: '超时（超过 ' + Math.round((result.limit || 0) / 1000) + 's 未结束，已终止）' };
  const skipped = /环境跳过/.test(result.out);
  if (skipped) return { status: 'SKIP', detail: '环境跳过（' + (result.out.match(/环境跳过[：:]([^\n]{0,40})/) || [])[1] + '）' };
  if (result.code === 0) {
    // 取最后一段 JSON 里的关键数字；锁屏时部分断言被跳过要标注出来，别让人以为全验了
    const summary = (result.out.match(/汇总:\s*(\{[^}]+\})/) || [])[1] || '';
    const partial = /前台断言跳过/.test(result.out) ? '（锁屏：前台断言跳过）' : '';
    const skipMatch = result.out.match(/"skipped":\s*(\d+)/);
    const skipNote = skipMatch && Number(skipMatch[1]) > 0 ? '（' + skipMatch[1] + ' 个应用因安全原因跳过）' : '';
    return { status: 'PASS', detail: (summary ? summary.replace(/"/g, '') : '通过') + partial + skipNote };
  }
  const failLine = (result.out.match(/❌[^\n]{0,80}/) || [])[0] || '有项未通过';
  return { status: 'FAIL', detail: failLine };
}

async function main() {
  const rows = [];
  for (const check of CHECKS) {
    process.stdout.write('跑 ' + check.name + ' … ');
    const result = await run(check.script, check.timeoutMs);
    const verdict = classify(result, check.name);
    rows.push({ name: check.name, status: verdict.status, detail: verdict.detail, ms: result.ms });
    console.log(verdict.status + '  ' + (verdict.detail || '') + '  ' + (result.ms / 1000).toFixed(1) + 's');
  }

  const failed = rows.filter((r) => r.status === 'FAIL');
  const skipped = rows.filter((r) => r.status === 'SKIP');
  const passed = rows.filter((r) => r.status === 'PASS');
  const w = Math.max(...rows.map((r) => r.name.length)) + 2;
  console.log('\n后台控制验收（' + new Date().toLocaleString('zh-CN') + '）\n');
  for (const r of rows) {
    const mark = r.status === 'PASS' ? '  ✅ ' : (r.status === 'SKIP' ? '  ⚠️ ' : '  ❌ ');
    console.log(mark + r.name.padEnd(w) + r.status.padEnd(6) + (r.detail || ''));
  }
  console.log('\n通过 ' + passed.length + ' 项' + (skipped.length ? '，环境跳过 ' + skipped.length + ' 项' : '') + (failed.length ? '，失败 ' + failed.length + ' 项' : '') + '\n');

  const dir = path.join(ROOT, 'reports');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'bg-verify-' + new Date().toISOString().replace(/[:.]/g, '-') + '.md');
  const lines = [
    '# 后台控制验收报告',
    '',
    '- 时间：' + new Date().toISOString(),
    '- 结果：通过 ' + passed.length + '，环境跳过 ' + skipped.length + '，失败 ' + failed.length,
    '',
    '| 项目 | 结果 | 说明 |',
    '| --- | --- | --- |',
  ];
  for (const r of rows) lines.push('| ' + r.name + ' | ' + r.status + ' | ' + (r.detail || '').replace(/\|/g, '/') + ' |');
  fs.writeFileSync(file, lines.join('\n') + '\n');
  console.log('报告：reports/' + path.basename(file));
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
