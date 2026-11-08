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

/**
 * 汇总判断（纯函数）：通道到底能不能用，不能只看「前台有没有被抢」。
 *
 * 真实问题：OpenCode/抖音 端口起不来、一次 CDP 都没连上，任务却因为前台没变而报成功——
 * 等于把「通道不可用」洗成绿灯。现在要求：有尝试的应用时，至少一个真的连上（cdp-ok）。
 * 全部 skipped-running（应用都在跑、不动它）属于没验证，但也不是失败。
 *
 * @param {Array<{status:string, frontUnchanged?:boolean}>} rows
 * @returns {{ok:boolean, frontOk:boolean, attempted:number, cdpOk:number, skippedRunning:number, problem:string}}
 */
export function summarizeCdpRows(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const frontOk = list.every((r) => r && r.frontUnchanged !== false);
  const attempted = list.filter((r) => r && r.status !== 'skipped-running').length;
  const cdpOk = list.filter((r) => r && r.status === 'cdp-ok').length;
  const skippedRunning = list.filter((r) => r && r.status === 'skipped-running').length;
  const channelUsable = attempted === 0 || cdpOk > 0;
  let problem = '';
  if (!frontOk) problem = '前台被抢占';
  else if (attempted > 0 && cdpOk === 0) problem = '一次 CDP 都没连上（' + attempted + ' 个应用全部失败）';
  return { ok: frontOk && channelUsable, frontOk, attempted, cdpOk, skippedRunning, problem };
}

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
    row.appPid = launch.appPid || 0;
    row.portTrust = launch.trust || '';
    if (!row.appPid) {
      // 兜底：launch 只可能用严格路径校验通过（path-exact）而没有 pid；
      // attachPage 现在 fail-closed，没有 pid 不会再连，所以这里直接如实标记，不进入 connect。
      row.status = 'cdp-unavailable';
      row.detail = '调试端口有响应，但没识别到应用 pid（trust=' + row.portTrust + '），按 fail-closed 拒绝连接';
      const quit = await quitApp({ bundleId: app.bundle, appName: app.name, processName: app.process });
      row.cleanup = quit.mode;
      row.frontUnchanged = (await frontName()) === before;
      rows.push(row);
      console.log(JSON.stringify(row));
      continue;
    }
    // 传 expectedPid 让 attachPage 再核一次端口主人（launch 阶段已核过，这里是第二道）
    const attached = await attachPage({ port, expectedPid: launch.appPid, app });
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
  const verdict = summarizeCdpRows(rows);
  const summary = {
    ok: verdict.ok,
    problem: verdict.problem,
    frontStart,
    frontEnd,
    cdpOk: verdict.cdpOk,
    attempted: verdict.attempted,
    unavailable: rows.filter((r) => r.status === 'cdp-unavailable').length,
    skippedRunning: verdict.skippedRunning,
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
  if (!summary.ok && summary.problem) console.log('❌ ' + summary.problem);
  console.log('\n汇总: ' + JSON.stringify({ ok: summary.ok, problem: summary.problem, cdpOk: summary.cdpOk, attempted: summary.attempted, unavailable: summary.unavailable, skippedRunning: summary.skippedRunning, total: summary.total }));
  console.log('报告: reports/cdp-driver-' + stamp + '.md');
  if (!summary.ok) process.exitCode = 1;
}

const invokedDirectly = Boolean(process.argv[1])
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
}
