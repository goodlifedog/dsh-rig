#!/usr/bin/env node
/**
 * 后台操作稳定性：连续多轮在多个应用上做读/点，每轮都检查前台有没有被抢。
 *
 *   node core/tasks/background-stability.mjs
 *
 * 输出：轮数、失败步数、前台被抢次数、单轮耗时分布。
 */
import { frontName, state, find, click, ensureAppWindow, quitApp } from '../background.mjs';
import { isScreenLocked } from '../platform.mjs';
import { closeOcuMcp } from '../ocu-mcp.mjs';

const ROUNDS = Math.max(1, Number(process.env.STABLE_ROUNDS) || 15);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  if (await isScreenLocked()) {
    console.log('环境跳过：屏幕已锁，后台操作链路不可用，等解锁后再跑 npm run stability');
    return;
  }
  // 目标应用没开就自己拉起来（清理脚本会把测试应用关掉，任务不能假设它们已经开着）
  const APPS = [
    { bundleId: 'com.apple.calculator', appName: '计算器', processName: 'Calculator', name: '计算器' },
    { bundleId: 'com.apple.Notes', appName: '备忘录', processName: 'Notes', name: '备忘录' },
    { bundleId: 'com.apple.TextEdit', appName: '文本编辑', processName: 'TextEdit', name: '文本编辑' },
  ];
  const launchedByUs = [];
  const prevHidden = process.env.AGENT_LAUNCH_HIDDEN;
  process.env.AGENT_LAUNCH_HIDDEN = '0';   // 窗口要真的建出来，AX 才有东西可读
  try {
    for (const app of APPS) {
      // 应用可能「进程在、窗口没了」（用户关了最后一个文档/之前的测试关掉了窗口），
      // 这种情况要让它把窗口建回来，不能误判成「应用没启动」而整项跳过。
      // 第二判据用真的 AX 界面树：文本编辑会出现「系统窗口数 0、但 ocu 能读到窗口」的状态。
      const probe = async () => {
        try {
          const tree = await state(app.name);
          return tree.length > 200;
        } catch { return false; }
      };
      const r = await ensureAppWindow(app, { waitMs: 8000, windowMs: 12000, probe });
      if (r.viaProbe) console.log('[stability] ' + app.name + '：系统窗口计数为 0，但 AX 界面树可读，按就绪处理');
      if (r.launched) launchedByUs.push(app);
      if (!r.window) {
        console.error('环境跳过：目标应用没能启动（' + app.name + '）：' + (r.error || '没有可读窗口'));
        return;
      }
    }
  } finally {
    if (prevHidden === undefined) delete process.env.AGENT_LAUNCH_HIDDEN;
    else process.env.AGENT_LAUNCH_HIDDEN = prevHidden;
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
  // 只关自己拉起来的应用，用户本来开着的不要动
  for (const app of launchedByUs) {
    await quitApp({ bundleId: app.bundleId, appName: app.name, processName: app.processName }).catch(() => {});
  }
  await closeOcuMcp().catch(() => {});
  if (!report.ok) process.exitCode = 1;
}

main().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });