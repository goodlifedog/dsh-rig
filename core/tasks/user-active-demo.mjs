#!/usr/bin/env node
/**
 * 「你在用 A，我在后台控 B」场景验证。
 *
 *   node core/tasks/user-active-demo.mjs
 *
 * 做法：
 *   1. 记录当前前台应用 F（视为用户正在用的应用）
 *   2. 选一个不是 F 的目标应用 B（默认计算器），在后台点按钮、读数值
 *   3. 每一步都断言前台仍然是 F
 *   4. 顺带记录 F 的界面树有没有被我们改动（如果读得到）
 */
import { frontName, state, find, click, isAppRunning } from '../background.mjs';
import { isScreenLocked, lockedSkipNotice } from '../platform.mjs';
import { closeOcuMcp } from '../ocu-mcp.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ACTIONS = Math.max(1, Number(process.env.USER_ACTIVE_ACTIONS) || 6);

// 候选目标应用：必须本来就在运行才允许读/点（审计 #1：绝不为这个任务自动启动应用）。
export const CANDIDATES = [
  { name: '计算器', bundleId: 'com.apple.calculator', appName: '计算器', processName: 'Calculator' },
  { name: '备忘录', bundleId: 'com.apple.Notes', appName: '备忘录', processName: 'Notes' },
  { name: '文本编辑', bundleId: 'com.apple.TextEdit', appName: '文本编辑', processName: 'TextEdit' },
];

/**
 * 逐个探测候选应用是否在运行（依赖注入 isRunning，便于单测 mock）。
 * 探测抛错按"没运行"处理：宁可跳过，也不冒险拉起/读取。
 *
 * @param {Array<object>} candidates
 * @param {(candidate: object) => boolean|Promise<boolean>} isRunning
 * @returns {Promise<Array<object>>} 保持原顺序的运行中候选
 */
export async function pickRunningCandidates(candidates, isRunning) {
  if (!Array.isArray(candidates) || typeof isRunning !== 'function') return [];
  const running = [];
  for (const candidate of candidates) {
    if (!candidate) continue;
    let ok = false;
    try {
      ok = Boolean(await isRunning(candidate));
    } catch {
      ok = false;
    }
    if (ok) running.push(candidate);
  }
  return running;
}

/** 所有候选都没运行（或没有候选）→ 环境跳过，不自动启动。 */
export function shouldSkipNotRunning(runningCandidates) {
  return !Array.isArray(runningCandidates) || runningCandidates.length === 0;
}

function displayValue(tree) {
  const m = /文本\s*[\u200e]?\s*(-?[\d.,]+)/.exec(tree || '');
  return m ? m[1] : '';
}

async function main() {
  if (await isScreenLocked()) { console.log(lockedSkipNotice('user-active-demo.mjs')); return; }
  if (await isScreenLocked()) {
    console.log('环境跳过：屏幕已锁，无法验证「用户在用 A 时后台控 B」，等解锁后再跑');
    return;
  }

  const userApp = await frontName();
  console.log('用户当前前台:', userApp);

  // P0（审计 #1）：候选应用必须本来就在运行；不自动启动，否则这个"验证不打扰"的任务自己先拉起窗口。
  const candidates = CANDIDATES.filter((c) => c.name !== userApp);
  const running = await pickRunningCandidates(candidates, (candidate) => isAppRunning({
    bundleId: candidate.bundleId,
    appName: candidate.appName,
    processName: candidate.processName,
  }));
  if (shouldSkipNotRunning(running)) {
    console.log('环境跳过：候选应用（计算器/备忘录/文本编辑）没有已运行且不同于用户前台的，不自动启动；请先手动打开一个候选应用再跑');
    return;
  }
  const target = running[0].name;
  console.log('后台目标:', target, '（用户前台是 ' + userApp + '；已运行候选: ' + running.map((c) => c.name).join('、') + '）');

  const beforeUserTree = await state(userApp).catch(() => '');
  const beforeTarget = displayValue(await state(target).catch(() => ''));

  const steps = [];
  let frontSteals = 0;
  const buttons = await find(target, { role: 'AXButton', limit: 40 }).catch(() => []);
  const digits = buttons.filter((b) => /^[1-9]$/.test(String(b.title || '')));
  if (!digits.length) {
    console.log('目标应用没有可点的数字按钮，改用读操作');
  }

  for (let i = 0; i < ACTIONS; i += 1) {
    const stepStart = await frontName();
    if (digits.length) {
      const b = digits[i % digits.length];
      const r = await click(target, b.index);
      if (!r.frontUnchanged) frontSteals += 1;
      steps.push({ i, action: 'click ' + b.title, ok: r.ok, front: r.front });
    } else {
      await state(target);
      steps.push({ i, action: 'read', ok: true, front: await frontName() });
    }
    if (stepStart !== await frontName()) frontSteals += 1;
    await sleep(150);
  }

  const afterUserTree = await state(userApp).catch(() => '');
  const afterTarget = displayValue(await state(target).catch(() => ''));
  const frontEnd = await frontName();

  // 如果"用户应用"就是 DSH 宿主本身，它的界面树会被本轮对话/日志持续改动，
  // 拿整棵树比对会把正常变化误判成"被我们改了"。这种情况只比对前台与目标应用。
  const userAppIsHost = /DeepSeek Harness/i.test(userApp);
  const userTreeChanged = userAppIsHost
    ? null
    : (beforeUserTree && afterUserTree ? beforeUserTree !== afterUserTree : null);
  const report = {
    ok: frontSteals === 0 && frontEnd === userApp && userTreeChanged !== true,
    userAppIsHost,
    userTreeNote: userAppIsHost ? '用户应用是 DSH 宿主，界面树由本轮对话驱动，跳过树比对' : '',
    userApp,
    target,
    targetWasRunning: true,
    runningCandidates: running.map((c) => c.name),
    actions: steps.length,
    frontSteals,
    frontStart: userApp,
    frontEnd,
    userTreeChanged,
    targetBefore: beforeTarget,
    targetAfter: afterTarget,
    targetChanged: beforeTarget && afterTarget ? beforeTarget !== afterTarget : null,
    steps,
  };
  // 失败原因要写成一眼能看懂的行：bg:verify 只摘第一行 ❌，含糊的"有项未通过"没法排障
  if (frontSteals > 0) {
    const bad = steps.filter((s) => s.front && s.front !== userApp).slice(0, 3);
    console.log('❌ 后台操作把前台抢走了 ' + frontSteals + ' 次，例如：' + JSON.stringify(bad));
  }
  if (frontEnd !== userApp) {
    console.log('❌ 结束时前台已从「' + userApp + '」变成「' + frontEnd + '」');
  }
  if (userTreeChanged === true) {
    console.log('❌ 用户应用「' + userApp + '」的界面树被改动了');
  }
  console.log('\n' + JSON.stringify(report, null, 2));
  await closeOcuMcp().catch(() => {});
  if (!report.ok) process.exitCode = 1;
}

const invokedDirectly = Boolean(process.argv[1]) && process.argv[1].endsWith('user-active-demo.mjs');
if (invokedDirectly) {
  main().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
}
