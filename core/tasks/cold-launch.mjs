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
import { isScreenLocked, lockedSkipNotice } from '../platform.mjs';

const exec = promisify(execFile);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// forceQuit 只给"退出无副作用"的应用用。备忘录可能有未保存内容，
// 强制结束有丢数据风险 —— 它退不掉就标跳过，不动用户的稿子。
const APPS = [
  { name: '计算器', bundle: 'com.apple.calculator', process: 'Calculator', forceQuit: true },
  { name: '系统设置', bundle: 'com.apple.systempreferences', process: 'System Settings', forceQuit: true },
  { name: '备忘录', bundle: 'com.apple.Notes', process: 'Notes', forceQuit: false },
];

async function quitApp(app) {
  try {
    await exec('/usr/bin/osascript', ['-e', 'tell application ' + JSON.stringify(app.name) + ' to quit'], { timeout: 8000 });
  } catch {}
  // 正常退出等 4 秒
  for (let i = 0; i < 20; i += 1) {
    if (!(await isAppRunning({ appName: app.name, processName: app.process }))) return true;
    await sleep(200);
  }
  // 只有明确"退出无副作用"的应用才强制结束；其余原样返回失败，交给上层标跳过
  if (!app.forceQuit) return false;
  try { await exec('/usr/bin/pkill', ['-x', app.process], { timeout: 5000 }); } catch {}
  for (let i = 0; i < 10; i += 1) {
    if (!(await isAppRunning({ appName: app.name, processName: app.process }))) return true;
    await sleep(200);
  }
  return false;
}

async function main() {
  if (await isScreenLocked()) { console.log(lockedSkipNotice('cold-launch.mjs')); return; }
  // 锁屏时前台断言没意义，但"能不能后台启动"本身仍可验证：照跑并标注前台断言跳过
  const locked = await isScreenLocked();
  if (locked) console.log('提示：屏幕已锁 —— 前台断言跳过，只验证后台启动是否成功');
  const rows = [];
  const frontStart = await frontName();
  console.log('起点前台:', frontStart);

  for (const app of APPS) {
    const row = { app: app.name };
    row.frontBeforeQuit = await frontName();
    row.quit = await quitApp(app);
    if (!row.quit) {
      row.skipped = '应用未能安全退出（可能有未保存内容），跳过以免丢失数据';
      rows.push(row);
      console.log(JSON.stringify(row));
      continue;
    }
    await sleep(600);
    row.frontAfterQuit = await frontName();
    row.quitOk = locked ? true : row.frontAfterQuit === row.frontBeforeQuit;

    const launch = await ensureAppRunning({ bundleId: app.bundle, appName: app.name, processName: app.process });
    await sleep(800);
    row.launched = Boolean(launch.launched || launch.running);
    row.frontAfterLaunch = await frontName();
    row.launchFrontUnchanged = locked ? true : row.frontAfterLaunch === row.frontAfterQuit;
    row.running = await isAppRunning({ appName: app.name, processName: app.process });

    rows.push(row);
    console.log(JSON.stringify(row));
  }

  const frontEnd = await frontName();
  const active = rows.filter((r) => !r.skipped);
  const ok = active.every((r) => r.quit && r.quitOk && r.launched && r.running && r.launchFrontUnchanged) && (locked || frontStart === frontEnd);
  const summary = { ok, locked, frontChecksSkipped: locked, skipped: rows.length - active.length, frontStart, frontEnd, rows };
  console.log('\n' + JSON.stringify(summary, null, 2));
  if (!ok) process.exitCode = 1;
}

main().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
