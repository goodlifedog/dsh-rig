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
import { hidIdleMs } from '../front-watch.mjs';
import { shouldDeferForActiveUser } from '../user-activity.mjs';
import { installEmergencyAppCleanup } from '../task-emergency-cleanup.mjs';
import { quitAppSync } from '../sync-quit.mjs';
import { checkAutomationPermission as defaultCheckAutomationPermission } from '../applescript-driver.mjs';

const exec = promisify(execFile);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 本任务几乎所有"看前台/退应用"动作都靠 Apple Events：frontName()（`tell application "System Events"`）、
 * quit（`tell application <目标> to quit`）。首次对未授权的 target 发 event 会静默弹系统授权框，
 * 所以在第一个 AppleEvent 之前先静默预检（AEDeterminePermissionToAutomateTarget + askUserIfNeeded=false）。
 */
export const SYSTEM_EVENTS_BUNDLE = 'com.apple.systemevents';

/**
 * 授权状态 → 是否跳过该 app 的 AppleEvent（纯函数，便于单测）。
 * 与本轮 note-cleanup 不同：这里是验收任务，拿不到结论也按「跳过」处理——宁可不测，也不弹框。
 * @param {string} status
 * @returns {{allow:boolean, skipped:boolean, status:string, reason:string}}
 */
export function decideAutomationSkip(status) {
  const s = String(status == null ? '' : status).trim() || 'unknown';
  if (s === 'granted') return { allow: true, skipped: false, status: s, reason: '' };
  const denied = s === 'denied' || s === 'needs-consent';
  return {
    allow: false,
    skipped: true,
    status: s,
    reason: '环境跳过：' + (denied ? '未授权自动化' : '查不到自动化授权状态') + '（' + s +
      '），不发送 Apple Event 以免弹授权框',
  };
}

/**
 * 静默预检某个 target 的自动化授权（可注入 deps.checkAutomationPermission 便于单测）。
 * @param {string} bundleId
 * @param {{deps?:{checkAutomationPermission?:Function}}} [options]
 * @returns {Promise<{allow:boolean, skipped:boolean, status:string, reason:string}>}
 */
export async function preflightAutomation(bundleId, options = {}) {
  const opts = options || {};
  const deps = opts.deps || {};
  const check = deps.checkAutomationPermission || defaultCheckAutomationPermission;
  let status = 'unknown';
  try {
    const result = await check({ bundleId }, opts);
    status = (result && result.status) || 'unknown';
  } catch {
    status = 'unknown';
  }
  return decideAutomationSkip(status);
}

// forceQuit 只给"退出无副作用"的应用用。备忘录可能有未保存内容，
// 强制结束有丢数据风险 —— 它退不掉就标跳过，不动用户的稿子。
const APPS = [
  { name: '计算器', bundle: 'com.apple.calculator', process: 'Calculator', forceQuit: true },
  { name: '系统设置', bundle: 'com.apple.systempreferences', process: 'System Settings', forceQuit: true },
  { name: '备忘录', bundle: 'com.apple.Notes', process: 'Notes', forceQuit: false },
];

/**
 * 退出一个应用。返回结构化结果：
 *   { quit:boolean, automationSkipped?:string, note?:string }
 * 发 AppleEvent 之前先静默预检自动化授权——未授权时不发（发了只会弹框），按环境跳过交给上层。
 */
async function quitApp(app) {
  if (!(await isAppRunning({ appName: app.name, processName: app.process }))) {
    return { quit: true, note: '没在运行，无需发退出 AppleEvent' };
  }
  const gate = await preflightAutomation(app.bundle);
  if (!gate.allow) return { quit: false, automationSkipped: gate.reason };
  try {
    await exec('/usr/bin/osascript', ['-e', 'tell application ' + JSON.stringify(app.name) + ' to quit'], { timeout: 8000 });
  } catch {}
  // 正常退出等 4 秒
  for (let i = 0; i < 20; i += 1) {
    if (!(await isAppRunning({ appName: app.name, processName: app.process }))) return { quit: true };
    await sleep(200);
  }
  // 只有明确"退出无副作用"的应用才强制结束；其余原样返回失败，交给上层标跳过
  if (!app.forceQuit) return { quit: false };
  try { await exec('/usr/bin/pkill', ['-x', app.process], { timeout: 5000 }); } catch {}
  for (let i = 0; i < 10; i += 1) {
    if (!(await isAppRunning({ appName: app.name, processName: app.process }))) return { quit: true };
    await sleep(200);
  }
  return { quit: false };
}

async function main() {
  // 这个任务会先退出目标应用（包括备忘录）：你正在用电脑时不做，免得把你正在用的窗口关掉
  const activity = shouldDeferForActiveUser(await hidIdleMs());
  if (activity.defer) {
    console.log('环境跳过：' + activity.reason);
    return;
  }
  // 锁屏时前台断言没意义，但"能不能后台启动"本身仍可验证：照跑并标注前台断言跳过
  const locked = await isScreenLocked();
  if (locked) console.log('提示：屏幕已锁 —— 前台断言跳过，只验证后台启动是否成功');
  const rows = [];
  // 被中途杀掉时，把已经拉起来的应用关掉
  const launchedApps = [];
  installEmergencyAppCleanup({ list: () => launchedApps, quit: (app) => quitApp(app), quitSync: quitAppSync });
  // 第一个 AppleEvent 之前：frontName() 就是对 System Events 发事件。未授权直接环境跳过，
  // 不要用"发一次试试"的方式探测——那正是会静默弹授权框的路径。
  const systemGate = await preflightAutomation(SYSTEM_EVENTS_BUNDLE);
  if (!systemGate.allow) {
    console.log(systemGate.reason);
    return;
  }
  const frontStart = await frontName();
  console.log('起点前台:', frontStart);

  for (const app of APPS) {
    const row = { app: app.name };
    row.frontBeforeQuit = await frontName();
    const quit = await quitApp(app);
    row.quit = quit.quit;
    if (quit.automationSkipped) {
      // 未授权自动化：不发 AppleEvent，按环境跳过（不算失败）
      row.skipped = quit.automationSkipped;
      rows.push(row);
      console.log(JSON.stringify(row));
      continue;
    }
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
    if (launch.launched) launchedApps.push({ bundleId: app.bundle, appName: app.name, processName: app.process });
    row.frontAfterLaunch = await frontName();
    row.launchFrontUnchanged = locked ? true : row.frontAfterLaunch === row.frontAfterQuit;
    row.running = await isAppRunning({ appName: app.name, processName: app.process });

    // 自己拉起来的自己收掉：否则每跑一次冷启动验收，桌面就多一个计算器/系统设置/备忘录
    if (launch.launched) {
      const cleanup = await quitApp(app);
      row.cleanup = cleanup.quit ? 'quit' : 'needs-confirm';
      if (cleanup.automationSkipped) row.cleanupDetail = cleanup.automationSkipped;
      else if (row.cleanup !== 'quit') row.cleanupDetail = '应用未能安全退出（可能有未保存内容），已留在后台';
      row.runningAfterCleanup = await isAppRunning({ appName: app.name, processName: app.process });
    }

    rows.push(row);
    console.log(JSON.stringify(row));
  }

  const frontEnd = await frontName();
  const active = rows.filter((r) => !r.skipped);
  // 全部跳过（典型原因：未授权自动化 / 应用都不肯退出）→ 环境跳过，不是失败
  const envSkip = rows.length > 0 && active.length === 0;
  const ok = active.every((r) => r.quit && r.quitOk && r.launched && r.running && r.launchFrontUnchanged) && (locked || frontStart === frontEnd);
  const summary = {
    ok,
    envSkip,
    locked,
    frontChecksSkipped: locked,
    skipped: rows.length - active.length,
    skippedReasons: rows.filter((r) => r.skipped).map((r) => ({ app: r.app, reason: r.skipped })),
    frontStart,
    frontEnd,
    rows,
  };
  if (envSkip) console.log('环境跳过：所有目标应用都没能验证（未授权自动化或应用未退出），本轮不计为失败');
  console.log('\n' + JSON.stringify(summary, null, 2));
  if (!ok && !envSkip) process.exitCode = 1;
}

// 导入本模块（单测拿纯函数/预检）时不要执行任务本体；runner 直接跑文件时照常执行。
const invokedDirectly = Boolean(process.argv[1])
  && (await import('node:path')).resolve(process.argv[1]) === (await import('node:url')).fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
}