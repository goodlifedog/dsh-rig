#!/usr/bin/env node
/**
 * CDP 通道验证：对 Electron / Chromium 系应用开调试端口，看能不能连进去读页面。
 *
 *   node core/tasks/cdp-driver.mjs
 *
 * 只做读操作（标题/地址/文字/按钮数量），不点任何业务按钮，验证完自动退出应用。
 * 应用已经在跑时跳过：open 传的 --args 对已有进程不生效，硬重启会打断用户正在用的东西。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isAppRunning, quitApp, frontName, settleFront } from '../background.mjs';
import { launchWithDebug, attachPage, readPage, debugPortFor } from '../cdp-driver.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');

const APPS = [
  { name: 'ChatGPT', bundle: 'com.openai.codex', process: 'ChatGPT' },
  { name: 'OpenCode', bundle: 'ai.opencode.desktop', process: 'OpenCode' },
  { name: '抖音', bundle: 'com.bytedance.douyin.desktop', process: '抖音' },
];

async function main() {
  const frontStart = await frontName();
  const rows = [];
  for (const app of APPS) {
    const before = await frontName();
    const row = { app: app.name, bundle: app.bundle };
    const running = await isAppRunning({ bundleId: app.bundle, appName: app.name, processName: app.process });
    if (running) {
      row.status = 'skipped-running';
      row.detail = '应用已在运行，不能带调试端口重启（不打断用户）';
      row.frontUnchanged = true;
      rows.push(row);
      console.log(JSON.stringify(row));
      continue;
    }
    const port = debugPortFor(app.bundle);
    row.port = port;
    const launch = await launchWithDebug(app, { port, waitMs: 12000 });
    row.launchWaitMs = launch.waitedMs;
    if (!launch.ok) {
      row.status = 'cdp-unavailable';
      row.detail = '调试端口没起来：' + (launch.error || '');
      const quit = await quitApp({ bundleId: app.bundle, appName: app.name, processName: app.process });
      row.cleanup = quit.mode;
      row.frontUnchanged = (await frontName()) === before;
      rows.push(row);
      console.log(JSON.stringify(row));
      continue;
    }
    row.browser = launch.version && launch.version.Browser ? launch.version.Browser : '';
    const attached = await attachPage({ port });
    if (!attached.ok) {
      row.status = 'attach-failed';
      row.detail = attached.error || '';
    } else {
      try {
        const page = await readPage(attached.cdp);
        row.status = 'cdp-ok';
        row.title = page.title.slice(0, 60);
        row.url = page.url.slice(0, 100);
        row.textLen = page.text.length;
        row.textSample = page.text.replace(/\s+/g, ' ').slice(0, 80);
        const stats = await attached.cdp.evaluate(
          '({ buttons: document.querySelectorAll("button,[role=button]").length, inputs: document.querySelectorAll("input,textarea,[contenteditable=true]").length })',
        );
        const value = stats || {};
        row.buttons = value.buttons || 0;
        row.inputs = value.inputs || 0;
      } catch (e) {
        row.status = 'read-failed';
        row.detail = String(e && e.message || e).slice(0, 120);
      } finally {
        try { attached.cdp.close(); } catch {}
      }
    }
    const settled = await settleFront(before, { waitMs: 250, retries: 2 });
    row.frontStolen = settled.stolen;
    row.frontRestoredOk = settled.restored;
    const quit = await quitApp({ bundleId: app.bundle, appName: app.name, processName: app.process });
    row.cleanup = quit.mode;
    // 应用退出过程中也可能把自己顶到前台（异步激活），退出后再复查一次并还原
    const afterQuit = await settleFront(before, { waitMs: 250, retries: 2 });
    row.frontStolenAfterQuit = afterQuit.stolen;
    row.frontRestoredOkAfterQuit = afterQuit.restored;
    row.frontUnchanged = (await frontName()) === before;
    rows.push(row);
    console.log(JSON.stringify(row));
  }

  const frontEnd = await frontName();
  const summary = {
    ok: rows.every((r) => r.frontUnchanged !== false),
    frontStart,
    frontEnd,
    cdpOk: rows.filter((r) => r.status === 'cdp-ok').length,
    unavailable: rows.filter((r) => r.status === 'cdp-unavailable').length,
    skippedRunning: rows.filter((r) => r.status === 'skipped-running').length,
    total: rows.length,
    rows,
  };
  const dir = path.join(ROOT, 'reports');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  fs.writeFileSync(path.join(dir, 'cdp-driver-' + stamp + '.json'), JSON.stringify(summary, null, 2));
  const lines = [
    '# CDP 通道验证',
    '',
    '- 时间：' + new Date().toISOString(),
    '- 前台：' + frontStart + ' -> ' + frontEnd + (summary.ok ? '（未变）' : '（被抢占）'),
    '- 结果：' + summary.cdpOk + '/' + summary.total + ' 个应用能连上 CDP',
    '',
    '| 应用 | 状态 | 端口 | 标题 | 按钮 | 输入框 | 收尾 | 说明 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const r of rows) {
    lines.push('| ' + r.app + ' | ' + r.status + ' | ' + (r.port || '-') + ' | ' + (r.title || '-') +
      ' | ' + (r.buttons === undefined ? '-' : r.buttons) + ' | ' + (r.inputs === undefined ? '-' : r.inputs) +
      ' | ' + (r.cleanup || '-') + ' | ' + (r.detail || r.browser || '') + ' |');
  }
  lines.push('');
  lines.push('skipped-running = 应用已在运行，不动它；cdp-unavailable = 应用没开放调试端口；cdp-ok = 连进去读到页面。');
  fs.writeFileSync(path.join(dir, 'cdp-driver-' + stamp + '.md'), lines.join('\n'));
  console.log('\n汇总: ' + JSON.stringify({ ok: summary.ok, cdpOk: summary.cdpOk, unavailable: summary.unavailable, skippedRunning: summary.skippedRunning, total: summary.total }));
  console.log('报告: reports/cdp-driver-' + stamp + '.md');
  if (!summary.ok) process.exitCode = 1;
}

main().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
