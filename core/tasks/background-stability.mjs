#!/usr/bin/env node
/**
 * 后台操作稳定性：连续多轮在多个应用上做读/点，每轮都检查前台有没有被抢。
 *
 *   node core/tasks/background-stability.mjs
 *
 * 输出：轮数、失败步数、前台被抢次数、单轮耗时分布。
 */
import { frontName, state, find, click } from '../background.mjs';
import { isScreenLocked, lockedSkipNotice } from '../platform.mjs';
import { closeOcuMcp } from '../ocu-mcp.mjs';

const ROUNDS = Math.max(1, Number(process.env.STABLE_ROUNDS) || 15);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  if (await isScreenLocked()) { console.log(lockedSkipNotice('background-stability.mjs')); return; }
  if (await isScreenLocked()) {
    console.log('环境跳过：屏幕已锁，后台操作链路不可用，等解锁后再跑 npm run stability');
    return;
  }
  const frontStart = await frontName();
  const durations = [];
  let steals = 0;
  let failures = 0;
  const steps = [];

  // 预热：让目标应用的索引进入可用状态
  await state('计算器').catch(() => {});
  await state('备忘录').catch(() => {});

  for (let i = 0; i < ROUNDS; i += 1) {
    const t0 = Date.now();
    const before = await frontName();

    // 1) 读备忘录
    try {
      const tree = await state('备忘录');
      if (!tree || tree.length < 40) failures += 1;
    } catch { failures += 1; }

    // 2) 读文本编辑
    try {
      const tree = await state('文本编辑');
      if (!tree || tree.length < 40) failures += 1;
    } catch { failures += 1; }

    // 3) 点一次计算器数字（可观察到的真实操作）
    try {
      const buttons = await find('计算器', { role: 'AXButton', limit: 40 });
      const digit = buttons.find((b) => /^(7|8|9)$/.test(String(b.title || '')));
      if (digit) {
        const r = await click('计算器', digit.index);
        if (!r.ok) failures += 1;
        if (!r.frontUnchanged) { steals += 1; steps.push({ round: i, step: 'click', front: r.front }); }
      } else {
        failures += 1;
      }
    } catch { failures += 1; }

    const after = await frontName();
    if (after !== before) { steals += 1; steps.push({ round: i, step: 'round', before, after }); }
    durations.push(Date.now() - t0);
    await sleep(120);
  }

  const frontEnd = await frontName();
  const sorted = durations.slice().sort((a, b) => a - b);
  const report = {
    ok: steals === 0 && failures === 0,
    rounds: ROUNDS,
    failures,
    focusSteals: steals,
    frontStart,
    frontEnd,
    frontUnchangedAll: frontStart === frontEnd && steals === 0,
    roundMs: { min: sorted[0], median: sorted[Math.floor(sorted.length / 2)], max: sorted[sorted.length - 1] },
    stealDetails: steps.slice(0, 5),
  };
  console.log(JSON.stringify(report, null, 2));
  await closeOcuMcp().catch(() => {});
  if (!report.ok) process.exitCode = 1;
}

main().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
