#!/usr/bin/env node
/**
 * AppleScript 通道验证：查授权状态（静默、不弹框），对已授权的应用发只读命令。
 *
 *   node core/tasks/applescript-channel.mjs
 *
 * 只读：取 Finder 的主目录名、取 Chrome 当前标签的地址（报告里脱敏成域名）。
 * 不启动应用、不点任何按钮、不改用户数据。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanDirs, findByBundle, allAppDirs } from '../app-scan.mjs';
import { frontName, isAppRunning, settleFront } from '../background.mjs';
import {
  ensureHelper,
  checkAutomationPermission,
  bundleSdefCommands,
  runAppScript,
  redactUrl,
} from '../applescript-driver.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');
const DIRS = allAppDirs();

const CASES = [
  { appName: 'Finder', bundleId: 'com.apple.finder', label: '主目录名', script: 'tell application "Finder" to get name of home', redact: false },
  { appName: 'Google Chrome', bundleId: 'com.google.Chrome', label: '当前标签地址', script: 'tell application "Google Chrome" to get URL of active tab of front window', redact: true },
  { appName: 'Safari', bundleId: 'com.apple.Safari', label: '应用名', script: 'tell application "Safari" to get name', redact: false },
  { appName: 'TextEdit', bundleId: 'com.apple.TextEdit', label: '无字典对照', script: 'tell application "TextEdit" to get name', redact: false },
];

/**
 * 通道验证结论（纯函数）：前台没被抢只是底线，还必须真的有应用执行成功过命令。
 * 一次都没执行成功（全部未运行/未授权）说明通道没被验证——要么报环境跳过，要么报失败，
 * 反正不能当「验证通过」。评审 6acf775 指出这类假绿。
 * @param {Array<{status:string, frontUnchanged?:boolean}>} rows
 * @param {boolean} helperOk
 */
export function summarizeApplescriptRows(rows, helperOk) {
  const list = Array.isArray(rows) ? rows : [];
  const frontOk = list.every((r) => r && r.frontUnchanged !== false);
  const okCount = list.filter((r) => r && r.status === 'ok').length;
  const notRunning = list.filter((r) => r && r.status === 'app-not-running').length;
  const denied = list.filter((r) => r && r.status === 'denied').length;
  const needsConsent = list.filter((r) => r && r.status === 'needs-consent').length;
  let problem = '';
  let envSkip = false;
  if (!frontOk) {
    problem = '前台被抢占';
  } else if (!list.length) {
    problem = '没有可验证的应用';
    envSkip = true;
  } else if (okCount === 0) {
    if (notRunning === list.length) {
      problem = '应用都没在运行，通道未验证';
      envSkip = true;
    } else if (denied + needsConsent + notRunning === list.length) {
      problem = '没有应用获得自动化授权，通道未验证';
      envSkip = true;
    } else {
      problem = '没有任何应用成功执行 AppleScript 命令';
    }
  }
  return { ok: frontOk && okCount > 0, frontOk, okCount, notRunning, denied, needsConsent, problem, envSkip };
}

async function main() {
  const frontStart = await frontName();
  const helper = await ensureHelper();
  const installed = await scanDirs(DIRS);
  const rows = [];
  for (const item of CASES) {
    const app = findByBundle(installed, item.bundleId);
    const row = { app: item.appName, bundle: item.bundleId, label: item.label };
    row.dict = app ? await bundleSdefCommands(app.appPath) : 0;
    row.running = await isAppRunning({ bundleId: item.bundleId, appName: item.appName });
    row.helperOk = helper.ok;
    const before = await frontName();
    if (!row.running) {
      row.status = 'app-not-running';
      row.detail = '应用没在运行，查不到授权状态（不为了测试去启动它）';
    } else {
      const perm = await checkAutomationPermission({ bundleId: item.bundleId });
      row.permission = perm.status;
      row.permissionCode = perm.code;
      if (perm.status === 'app-not-running') {
        row.status = 'app-not-running';
        row.detail = '应用没在运行（或进程名不匹配），未发 Apple 事件';
      } else if (perm.status !== 'granted') {
        row.status = perm.status;
        row.detail = perm.error || '未授权，不发 Apple 事件';
      } else {
        const run = await runAppScript({ appName: item.appName, bundleId: item.bundleId, script: item.script, timeoutMs: 6000 });
        row.status = run.ok ? 'ok' : run.status;
        row.output = run.ok ? (item.redact ? redactUrl(run.output) : String(run.output || '').slice(0, 40)) : '';
        row.detail = run.ok ? '' : String(run.error || '').slice(0, 80);
      }
    }
    const settled = await settleFront(before, { waitMs: 200, retries: 2 });
    row.frontStolen = settled.stolen;
    row.frontRestoredOk = settled.restored;
    row.frontUnchanged = (await frontName()) === before;
    rows.push(row);
    console.log(JSON.stringify(row));
  }

  const frontEnd = await frontName();
  const verdict = summarizeApplescriptRows(rows, helper.ok);
  const summary = {
    ok: verdict.ok,
    problem: verdict.problem,
    envSkip: verdict.envSkip,
    helperOk: helper.ok,
    grantedTested: verdict.okCount,
    notRunning: verdict.notRunning,
    frontStart,
    frontEnd,
    total: rows.length,
    rows,
  };
  const dir = path.join(ROOT, 'reports');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  fs.writeFileSync(path.join(dir, 'applescript-channel-' + stamp + '.json'), JSON.stringify(summary, null, 2));
  const lines = [
    '# AppleScript 通道验证',
    '',
    '- 时间：' + new Date().toISOString(),
    '- 权限查询小程序：' + (helper.ok ? '可用' : '不可用（' + helper.error + '）'),
    '- 前台：' + frontStart + ' -> ' + frontEnd + (summary.ok ? '（未变）' : '（被抢占）'),
    '- 已授权并成功执行只读命令：' + summary.grantedTested + ' 个；应用没运行：' + summary.notRunning + ' 个',
    '',
    '| 应用 | 脚本命令 | 权限 | 结果 | 输出 | 说明 |',
    '| --- | --- | --- | --- | --- | --- |',
  ];
  for (const r of rows) {
    lines.push('| ' + r.app + ' | ' + r.dict + ' | ' + (r.permission || '-') + ' | ' + r.status + ' | ' + (r.output || '-') + ' | ' + (r.detail || '') + ' |');
  }
  lines.push('');
  lines.push('权限查询用 AEDeterminePermissionToAutomateTarget(askUserIfNeeded=false)，不会弹授权框；没授权的应用一律不发送 Apple 事件。');
  lines.push('Chrome 的地址在报告里做了脱敏（只留协议和域名）。');
  fs.writeFileSync(path.join(dir, 'applescript-channel-' + stamp + '.md'), lines.join('\n'));
  if (summary.envSkip) console.log('环境跳过：' + summary.problem);
  else if (!summary.ok) console.log('❌ ' + summary.problem);
  console.log('\n汇总: ' + JSON.stringify({ ok: summary.ok, problem: summary.problem, envSkip: summary.envSkip, helperOk: summary.helperOk, grantedTested: summary.grantedTested, notRunning: summary.notRunning, total: summary.total }));
  console.log('报告: reports/applescript-channel-' + stamp + '.md');
  if (!summary.ok && !summary.envSkip) process.exitCode = 1;
}

const invokedDirectly = Boolean(process.argv[1])
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
}
