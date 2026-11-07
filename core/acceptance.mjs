#!/usr/bin/env node
// 端到端验收：把关键能力跑一遍并出结论表
// 用法：node core/acceptance.mjs
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { envSkipReason } from './run-classify.mjs';
import { overlay } from './agentd.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const RESULTS = [];

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: opts.timeout || 180000, maxBuffer: 64 * 1024 * 1024, cwd: ROOT, env: opts.env ? { ...process.env, ...opts.env } : process.env }, (err, stdout, stderr) => {
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
  if (shown.visible === true) {
    record('活动触发显示', true, '');
  } else {
    // 小窗按设计只在 DSH 前台时显示；前台是别的应用时隐藏属于正常行为
    const front = frontmostBundle();
    const suppressed = Boolean(front) && !/deepseek|\.dsh/i.test(front);
    record('活动触发显示', suppressed, suppressed ? '前台=' + front + '，按设计隐藏' : 'visible=' + shown.visible, suppressed);
  }
}

function frontmostBundle() {
  if (process.platform !== 'darwin') return null;
  try {
    return execFileSync('/usr/bin/osascript', ['-e',
      'tell application "System Events" to get bundle identifier of first process whose frontmost is true'],
      { encoding: 'utf8', timeout: 3000 }).trim();
  } catch { return null; }
}

async function runTask(name, timeoutMs = 180000, env) {
  const r = await run('node', ['core/runner.mjs', 'run', name, '--timeout', String(timeoutMs)], env ? { env } : {});
  const out = r.stdout + r.stderr;
  // 环境原因跳过不算失败；规则与健康面板共用一份（core/run-classify.mjs）
  const reason = envSkipReason(out);
  const skipped = Boolean(reason);
  const ok = r.code === 0 || skipped;
  record('任务 ' + name, ok, ok ? (reason ? '环境跳过（' + reason + '）' : '') : out.slice(-200).replace(/\n/g, ' '), skipped);
  return ok;
}

async function main() {
  console.log('=== 桌面代理端到端验收 ===');
  const h = await checkOverlay();
  if (h.ok) await checkIdleHide();

  const scanOk = await runTask('boss-scan');
  const multiOk = await runTask('multi-app');
  const writeOk = await runTask('form-fill');
  const platformOk = await runTask('platform-demo');
  const browserOk = await runTask('browser-demo');
  const electronOk = await runTask('electron-demo');
  // 新通道也要过验收闸门：否则等于"写完就算完成"（外部评审 P0）
  const cdpOk = await runTask('cdp-channel', 120000);
  const asOk = await runTask('applescript-channel', 120000);
  const bgOk = await runTask('background-control', 150000);
  const matrixOk = await runTask('app-matrix', 420000, {
    // 样本挑"不抢前台"的两个：Steam 会短暂抢前台（矩阵能兜住，但它不该当验收样本）
    MATRIX_APPS_JSON: JSON.stringify([
      { name: 'FastZip', bundle: 'cn.better365.FastZip', process: 'FastZip' },
      { name: 'iRightMouse', bundle: 'cn.better365.iRightMouse', process: 'iRightMouse' },
    ]),
  });

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
  // 环境跳过不算失败：只有"没通过且不是跳过"才返回 1
  process.exit(passed === total - skipped ? 0 : 1);
}

main().catch((e) => {
  console.error('FAIL:', e.message);
  process.exit(2);
});