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
import { frontName, state, find, click } from '../background.mjs';
import { isScreenLocked, lockedSkipNotice } from '../platform.mjs';
import { closeOcuMcp } from '../ocu-mcp.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ACTIONS = Math.max(1, Number(process.env.USER_ACTIVE_ACTIONS) || 6);

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

  // 选一个不同于用户前台的目标
  const candidates = ['计算器', '备忘录', '文本编辑'];
  const target = candidates.find((a) => a !== userApp) || '计算器';
  console.log('后台目标:', target, '（用户前台是 ' + userApp + '）');

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
  console.log('\n' + JSON.stringify(report, null, 2));
  await closeOcuMcp().catch(() => {});
  if (!report.ok) process.exitCode = 1;
}

main().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
