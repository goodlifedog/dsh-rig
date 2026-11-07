#!/usr/bin/env node
/**
 * 冷启动验收：把应用彻底退掉，再用后台方式拉起，检查前台有没有跳转。
 *
 *   node core/tasks/cold-launch.mjs
 *
 * 只挑「退出安全」的应用：计算器、系统设置、备忘录。
 * 文本编辑不参与（可能有未保存文档，退出会弹窗）。
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ensureAppRunning, frontName, isAppRunning } from '../background.mjs';
import { isScreenLocked } from '../platform.mjs';

const exec = promisify(execFile);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const APPS = [
  { name: '计算器', bundle: 'com.apple.calculator', process: 'Calculator' },
  { name: '系统设置', bundle: 'com.apple.systempreferences', process: 'System Settings' },
  { name: '备忘录', bundle: 'com.apple.Notes', process: 'Notes' },
];

async function quitApp(app) {
  try {
    await exec('/usr/bin/osascript', ['-e', 'tell application ' + JSON.stringify(app.name) + ' to quit'], { timeout: 8000 });
  } catch {}
  // 正常退出等 4 秒；还不退就强制结束（这些都是无未保存数据的系统应用）
  for (let i = 0; i < 20; i += 1) {
    if (!(await isAppRunning({ appName: app.name, processName: app.process }))) return true;
    await sleep(200);
  }
  try { await exec('/usr/bin/pkill', ['-x', app.process], { timeout: 5000 }); } catch {}
  for (let i = 0; i < 10; i += 1) {
    if (!(await isAppRunning({ appName: app.name, processName: app.process }))) return true;
    await sleep(200);
  }
  return false;
}

async function main() {
  if (await isScreenLocked()) {
    console.log('环境跳过：屏幕已锁，锁屏下无法验证前台是否跳转，等解锁后再跑 npm run cold:launch');
    return;
  }
  const rows = [];
  const frontStart = await frontName();
  console.log('起点前台:', frontStart);

  for (const app of APPS) {
    const row = { app: app.name };
    row.frontBeforeQuit = await frontName();
    row.quit = await quitApp(app);
    await sleep(600);
    row.frontAfterQuit = await frontName();
    row.quitOk = row.frontAfterQuit === row.frontBeforeQuit;

    const launch = await ensureAppRunning({ bundleId: app.bundle, appName: app.name, processName: app.process });
    await sleep(800);
    row.launched = Boolean(launch.launched || launch.running);
    row.frontAfterLaunch = await frontName();
    row.launchFrontUnchanged = row.frontAfterLaunch === row.frontAfterQuit;
    row.running = await isAppRunning({ appName: app.name, processName: app.process });

    rows.push(row);
    console.log(JSON.stringify(row));
  }

  const frontEnd = await frontName();
  const ok = rows.every((r) => r.quit && r.quitOk && r.launched && r.running && r.launchFrontUnchanged) && frontStart === frontEnd;
  const summary = { ok, frontStart, frontEnd, rows };
  console.log('\n' + JSON.stringify(summary, null, 2));
  if (!ok) process.exitCode = 1;
}

main().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
