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
import { scanDirs, findByBundle } from '../app-scan.mjs';
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
const DIRS = ['/Applications', '/Applications/Utilities', '/System/Applications', '/System/Applications/Utilities', '/System/Library/CoreServices'];

const CASES = [
  { appName: 'Finder', bundleId: 'com.apple.finder', label: '主目录名', script: 'tell application "Finder" to get name of home', redact: false },
  { appName: 'Google Chrome', bundleId: 'com.google.Chrome', label: '当前标签地址', script: 'tell application "Google Chrome" to get URL of active tab of front window', redact: true },
  { appName: 'Safari', bundleId: 'com.apple.Safari', label: '应用名', script: 'tell application "Safari" to get name', redact: false },
  { appName: 'TextEdit', bundleId: 'com.apple.TextEdit', label: '无字典对照', script: 'tell application "TextEdit" to get name', redact: false },
];

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
  const summary = {
    ok: rows.every((r) => r.frontUnchanged !== false),
    helperOk: helper.ok,
    grantedTested: rows.filter((r) => r.status === 'ok').length,
    notRunning: rows.filter((r) => r.status === 'app-not-running').length,
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
  console.log('\n汇总: ' + JSON.stringify({ ok: summary.ok, helperOk: summary.helperOk, grantedTested: summary.grantedTested, notRunning: summary.notRunning, total: summary.total }));
  console.log('报告: reports/applescript-channel-' + stamp + '.md');
  if (!summary.ok) process.exitCode = 1;
}

main().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
