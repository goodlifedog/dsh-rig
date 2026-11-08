'use strict';
// adapter-demo：纯函数 + 全注入假 deps 的流程单测。绝不启动/读取真实应用。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseArgs,
  processNameFor,
  decideRunGate,
  riskNamesFor,
  findRiskHit,
  summarizeTree,
  pickClickTarget,
  pickTypeTarget,
  hasStateChanged,
  extractValue,
  isSystemOverlay,
  frontForCompare,
  compareFront,
  sampleFrontBaseline,
  writeGuardDecision,
  runAdapterDemo,
} from '../core/tasks/adapter-demo.mjs';

const BUTTON_TREE = [
  'App=com.apple.TextEdit (pid 123)',
  'Window: "sample.txt", App: TextEdit.',
  '0 标准窗口 sample.txt',
  '	1 container',
  '		2 按钮 提交',
  '		3 按钮 取消',
  '		4 文本输入区 (settable, string) 正文 Value: ',
  '		5 文本栏 (settable, string) 标题 Value: ',
].join('\n');

const AFTER_CLICK_TREE = [
  'App=com.apple.TextEdit (pid 123)',
  'Window: "sample.txt", App: TextEdit.',
  '0 标准窗口 sample.txt',
  '	1 container',
  '		2 按钮 提交',
  '		3 按钮 取消',
  '		4 文本输入区 (settable, string) 正文 Value: 提交成功',
  '		5 文本栏 (settable, string) 标题 Value: ',
  '		6 文本 提交成功',
].join('\n');

const EMPTY_TREE = '(empty)';

function fakeDeps(overrides = {}) {
  const calls = { readState: 0, click: [], setValue: [], quit: [], open: [], rmDir: [], copy: [] };
  const base = {
    isScreenLocked: () => false,
    idleMs: async () => 60000,
    shouldDeferForActiveUser: () => ({ defer: false, reason: '' }),
    riskGate: () => ({ shouldSkip: () => false }),
    isAppRunning: async () => true,
    ensureAppRunning: async () => ({ launched: true, running: true }),
    quitApp: async (app) => { calls.quit.push(app); return { quit: true, mode: 'quit' }; },
    frontName: async () => 'DeepSeek Harness',
    readState: async () => {
      calls.readState += 1;
      return calls.readState === 1 ? BUTTON_TREE : AFTER_CLICK_TREE;
    },
    click: async (app, index) => { calls.click.push({ app, index }); return { ok: true }; },
    setValue: async (app, index, value) => {
      calls.setValue.push({ app, index, value });
      return { ok: true };
    },
    openBackground: async (app, file) => { calls.open.push({ app, file }); return { ok: true }; },
    echoScreenshot: async () => ({ ok: false, skipped: true, reason: '测试环境无窗口画面' }),
    sleep: async () => {},
    mkdtemp: () => '/tmp/adapter-demo-test-dir',
    copyFile: (src, dst) => { calls.copy.push({ src, dst }); },
    rmDir: (dir) => { calls.rmDir.push(dir); },
  };
  return { deps: Object.assign(base, overrides), calls };
}

// ---------- 纯函数 ----------

test('parseArgs：完整参数 / help / 未知参数 / 缺值 / 缺 --app', () => {
  const full = parseArgs(['--app', 'Preview', '--file', 'examples/adapters/sample.png', '--click-text', '按钮', '--type-text', 'y', '--allow-launch']);
  assert.deepEqual(full.errors, []);
  assert.equal(full.app, 'Preview');
  assert.equal(full.file, 'examples/adapters/sample.png');
  assert.equal(full.clickText, '按钮');
  assert.equal(full.typeText, 'y');
  assert.equal(full.allowLaunch, true);
  assert.equal(parseArgs(['--help']).help, true);
  assert.ok(parseArgs(['--nope']).errors.length > 0);
  assert.ok(parseArgs(['--app']).errors.some((e) => e.includes('缺少参数值')));
  assert.ok(parseArgs([]).errors.some((e) => e.includes('--app')));
});

test('processNameFor：候选应用给进程名提示，未知回退显示名', () => {
  assert.equal(processNameFor('Chrome'), 'Google Chrome');
  assert.equal(processNameFor('TextEdit'), 'TextEdit');
  assert.equal(processNameFor('QQ'), 'QQ');
  assert.equal(processNameFor('某未知应用'), '某未知应用');
});

test('riskNamesFor / findRiskHit：front-risk 名单里的本地化名/别名也能命中', () => {
  assert.ok(riskNamesFor('TextEdit').includes('文本编辑'), '英文显示名要能对上名单里的中文名');
  assert.ok(riskNamesFor('Chrome').includes('Google Chrome'));
  assert.ok(riskNamesFor('WPS').includes('WPS Office'));
  const gate = { shouldSkip: (name) => name === '文本编辑' || name === 'QQ' };
  assert.equal(findRiskHit(gate, 'TextEdit'), '文本编辑');
  assert.equal(findRiskHit(gate, 'QQ'), 'QQ');
  assert.equal(findRiskHit(gate, 'Safari'), '');
  assert.equal(findRiskHit(null, 'QQ'), '');
});

test('decideRunGate：守卫顺序（锁屏→用户活跃→front-risk→运行/启动）', () => {
  assert.equal(decideRunGate({ locked: true, userActive: true, risky: true, running: true, allowLaunch: true, app: 'A' }).mode, 'skip');
  assert.match(decideRunGate({ locked: true, app: 'A' }).reason, /锁屏/);

  const active = decideRunGate({ userActive: true, userActiveReason: '你在用电脑', running: true, app: 'A' });
  assert.equal(active.mode, 'skip');
  assert.equal(active.envSkip, true);
  assert.equal(active.reason, '你在用电脑');

  // front-risk 不允许 --allow-launch 绕过
  const risky = decideRunGate({ risky: true, running: false, allowLaunch: true, app: 'QQ' });
  assert.equal(risky.mode, 'skip');
  assert.equal(risky.envSkip, true);
  assert.match(risky.reason, /front-risk/);
  assert.match(risky.reason, /不允许 --allow-launch 绕过/);

  assert.equal(decideRunGate({ running: true, app: 'A' }).mode, 'run');
  const notRunning = decideRunGate({ running: false, allowLaunch: false, app: 'A' });
  assert.equal(notRunning.mode, 'skip');
  assert.match(notRunning.reason, /没在运行/);
  const launch = decideRunGate({ running: false, allowLaunch: true, app: 'A' });
  assert.equal(launch.mode, 'launch');
  assert.equal(launch.launch, true);
  assert.equal(launch.envSkip, false);
});

test('summarizeTree：节点数/标题/按钮/输入区；空树不可读', () => {
  const summary = summarizeTree(BUTTON_TREE);
  assert.equal(summary.readable, true);
  assert.equal(summary.nodes, 6);
  assert.equal(summary.windowTitle, 'sample.txt');
  assert.deepEqual(summary.buttons.map((b) => b.label), ['提交', '取消']);
  assert.equal(summary.inputs.length, 2);
  assert.equal(summary.inputs[0].kind, 'textArea');
  assert.equal(summarizeTree(EMPTY_TREE).readable, false);
  assert.equal(summarizeTree('').nodes, 0);
});

test('pickClickTarget：按文字 + 角色优先级；找不到给候选；pickTypeTarget 默认只写安全输入框', () => {
  const summary = summarizeTree(BUTTON_TREE);
  assert.deepEqual(pickClickTarget(summary, '提交'), { found: true, index: '2', label: '提交', role: 'button', kind: 'button', match: 'exact', priority: 1 });
  assert.equal(pickClickTarget(summary, '交').match, 'contains');
  const missing = pickClickTarget(summary, '不存在');
  assert.equal(missing.found, false);
  assert.equal(missing.candidates.length, 2);

  // 默认：只认 AXTextField/AXSearchField；只有 AXTextArea 时必须 --allow-write
  const typed = pickTypeTarget(summary);
  assert.equal(typed.found, false);
  assert.equal(typed.guard, 'text-area-needs-allow-write');
  const typedAllow = pickTypeTarget(summary, { allowWrite: true });
  assert.equal(typedAllow.found, true);
  assert.equal(typedAllow.index, '4');
  assert.equal(typedAllow.kind, 'textArea');
  assert.equal(pickTypeTarget({ inputs: [] }).found, false);

  // Finder 侧边栏是行/单元格：按文字找得到，且不会被当成按钮
  const finder = summarizeTree(['App=x', 'Window: "flow", App: 访达.',
    '4 row 文稿', '5 row (selected) 桌面',
    '32 按钮 新建备忘录 Help: 创',
    '40 文本栏 (settable, string) Value: tech',
  ].join('\n'));
  const row = pickClickTarget(finder, '文稿');
  assert.equal(row.found, true);
  assert.equal(row.index, '4');
  assert.equal(row.role, 'tableRow');
  const named = pickClickTarget(finder, '新建备忘录');
  assert.equal(named.role, 'button');
  // Finder 里其他「文本栏」是文件名（settable AXTextField），没有搜索特征 → 绝不能当写入目标
  const finderType = pickTypeTarget(finder);
  assert.equal(finderType.found, false, '文件名不能被当输入框写入');
});

test('writeGuardDecision：空目标允许；有内容默认拒绝，--allow-write 才允许（写后必须恢复）', () => {
  assert.equal(writeGuardDecision('', false).allow, true);
  assert.equal(writeGuardDecision(undefined, false).allow, true);
  const blocked = writeGuardDecision('用户正文', false);
  assert.equal(blocked.allow, false);
  assert.match(blocked.reason, /拒绝写入/);
  assert.equal(blocked.current, '用户正文');
  const allowed = writeGuardDecision('用户正文', true);
  assert.equal(allowed.allow, true);
  assert.match(allowed.reason, /写后恢复/);
});

test('hasStateChanged / extractValue：标题、节点数、新增行算变化；能按 index 读回 value', () => {
  const before = summarizeTree(BUTTON_TREE);
  const after = summarizeTree(AFTER_CLICK_TREE);
  const changed = hasStateChanged(before, after);
  assert.equal(changed.changed, true);
  assert.match(changed.detail, /新增/);
  assert.equal(hasStateChanged(before, before).changed, false);
  assert.equal(hasStateChanged(null, after).changed, false);
  assert.equal(extractValue(AFTER_CLICK_TREE, '4'), '提交成功');
  assert.equal(extractValue(AFTER_CLICK_TREE, '5'), '');
});

// ---------- 流程：全注入假 deps ----------

test('流程：锁屏 → 环境跳过 exit0，且一次界面树都不读', async () => {
  const { deps, calls } = fakeDeps({ isScreenLocked: () => true });
  const { exitCode, report } = await runAdapterDemo({ app: 'TextEdit' }, deps);
  assert.equal(exitCode, 0);
  assert.equal(report.envSkip, true);
  assert.match(report.reason, /锁屏/);
  assert.equal(calls.readState, 0);
  assert.equal(report.front.before, 'DeepSeek Harness');
});

test('流程：用户键鼠活跃 → 环境跳过 exit0（不读树）', async () => {
  const { deps, calls } = fakeDeps({ shouldDeferForActiveUser: () => ({ defer: true, reason: '你正在操作电脑' }) });
  const { exitCode, report } = await runAdapterDemo({ app: 'TextEdit' }, deps);
  assert.equal(exitCode, 0);
  assert.equal(report.envSkip, true);
  assert.equal(calls.readState, 0);
});

test('流程：front-risk 名单 → 环境跳过 exit0，即使带 --allow-launch 也不绕', async () => {
  const { deps } = fakeDeps({ riskGate: () => ({ shouldSkip: () => true }) });
  const { exitCode, report } = await runAdapterDemo({ app: 'QQ', allowLaunch: true }, deps);
  assert.equal(exitCode, 0);
  assert.equal(report.envSkip, true);
  assert.match(report.reason, /front-risk/);
});

test('流程：--app TextEdit 命中名单里的「文本编辑」→ 环境跳过 exit0', async () => {
  const { deps, calls } = fakeDeps({ riskGate: () => ({ shouldSkip: (name) => name === '文本编辑' }) });
  const { exitCode, report } = await runAdapterDemo({ app: 'TextEdit' }, deps);
  assert.equal(exitCode, 0);
  assert.equal(report.envSkip, true);
  assert.match(report.reason, /名单命中：文本编辑/);
  assert.equal(calls.readState, 0);
});

test('流程：未运行且没 --allow-launch → 环境跳过 exit0，不启动、不读树', async () => {
  let ensureCalls = 0;
  const { deps, calls } = fakeDeps({
    isAppRunning: async () => false,
    ensureAppRunning: async () => { ensureCalls += 1; return { launched: true, running: true }; },
  });
  const { exitCode, report } = await runAdapterDemo({ app: 'Preview' }, deps);
  assert.equal(exitCode, 0);
  assert.equal(report.envSkip, true);
  assert.match(report.reason, /没在运行/);
  assert.equal(ensureCalls, 0);
  assert.equal(calls.readState, 0);
});

test('流程：--allow-launch 成功 → 启动、跑完只关自己拉起的应用', async () => {
  let ensureArgs = null;
  const { deps, calls } = fakeDeps({
    isAppRunning: async () => false,
    ensureAppRunning: async (app) => { ensureArgs = app; return { launched: true, running: true }; },
  });
  const { exitCode, report } = await runAdapterDemo({
    app: 'Preview',
    allowLaunch: true,
    clickText: '提交',
  }, deps);
  assert.equal(exitCode, 0, JSON.stringify(report.steps));
  assert.equal(report.launched, true);
  assert.equal(ensureArgs.appName, 'Preview');
  assert.equal(calls.quit.length, 1, '只能关本次拉起的应用');
  assert.equal(calls.quit[0].appName, 'Preview');
  assert.equal(report.readable, true);
  assert.equal(report.front.unchanged, true);
  assert.equal(calls.click.length, 1);
});

test('流程：--allow-launch 启动失败 → 环境跳过 exit0（不读树）', async () => {
  const { deps, calls } = fakeDeps({
    isAppRunning: async () => false,
    ensureAppRunning: async () => ({ launched: false, running: false, error: 'open 失败' }),
  });
  const { exitCode, report } = await runAdapterDemo({ app: 'WPS', allowLaunch: true }, deps);
  assert.equal(exitCode, 0);
  assert.equal(report.envSkip, true);
  assert.match(report.reason, /无法启动/);
  assert.equal(calls.readState, 0);
});

test('流程：读树为空 → 能力失败 exit1，readable=false', async () => {
  const { deps } = fakeDeps({ readState: async () => EMPTY_TREE });
  const { exitCode, report } = await runAdapterDemo({ app: 'Ghostty' }, deps);
  assert.equal(exitCode, 1);
  assert.equal(report.readable, false);
  assert.ok(report.steps.some((s) => s.step === 'read-tree' && s.ok === false));
  assert.equal(report.envSkip, false);
});

test('流程：找不到按钮 → 能力失败 exit1（不点击）', async () => {
  const { deps, calls } = fakeDeps();
  const { exitCode, report } = await runAdapterDemo({ app: 'TextEdit', clickText: '[AGENT-TEST] 不存在' }, deps);
  assert.equal(exitCode, 1);
  assert.equal(calls.click.length, 0);
  const step = report.steps.find((s) => s.step === 'click-by-text');
  assert.equal(step.ok, false);
});

test('流程：工具点失败且界面树无变化 → 能力失败 exit1（clickOk/changed 都记录）', async () => {
  const { deps } = fakeDeps({ readState: async () => BUTTON_TREE, click: async () => ({ ok: false, text: 'AXPress 不支持' }) });
  const { exitCode, report } = await runAdapterDemo({ app: 'TextEdit', clickText: '提交' }, deps);
  assert.equal(exitCode, 1);
  const step = report.steps.find((s) => s.step === 'click-by-text');
  assert.equal(step.ok, false);
  assert.equal(step.clickOk, false);
  assert.equal(step.changed, false);
  assert.match(step.detail, /没有可观测变化/);
});

test('流程：工具 ok 但界面树没变化 → 算成功（Calculator 场景：状态已变但 click 工具报错也不误判）', async () => {
  const { deps } = fakeDeps({ readState: async () => BUTTON_TREE, click: async () => ({ ok: true }) });
  const { exitCode, report } = await runAdapterDemo({ app: 'Calculator', clickText: '提交' }, deps);
  assert.equal(exitCode, 0, JSON.stringify(report.steps));
  const step = report.steps.find((s) => s.step === 'click-by-text');
  assert.equal(step.ok, true);
  assert.equal(step.clickOk, true);
  assert.equal(step.changed, false);
});

test('流程：前台被改变 → 能力失败 exit1', async () => {
  let frontCalls = 0;
  const { deps } = fakeDeps({
    // 第 1 次 = 初始上下文，第 2/3 次 = 动作前基线（两次一致），第 4 次 = 动作后（被抢到 Preview）
    frontName: async () => { frontCalls += 1; return frontCalls <= 3 ? 'DeepSeek Harness' : 'Preview'; },
  });
  const { exitCode, report } = await runAdapterDemo({ app: 'TextEdit' }, deps);
  assert.equal(exitCode, 1);
  assert.equal(report.front.unchanged, false);
  assert.match(report.reason, /前台应用被改变/);
});

test('流程：--file 先复制到 0700 临时目录再打开，结束后删临时目录（仓库样例不动）', async () => {
  const { deps, calls } = fakeDeps();
  const { exitCode, report } = await runAdapterDemo({ app: 'TextEdit', file: 'examples/adapters/sample.txt' }, deps);
  assert.equal(exitCode, 0, JSON.stringify(report.steps));
  assert.equal(calls.copy.length, 1);
  assert.match(calls.copy[0].src, /examples\/adapters\/sample\.txt$/);
  assert.match(calls.copy[0].dst, /^\/tmp\/adapter-demo-test-dir\//, '目标是临时目录里的副本');
  assert.equal(calls.open.length, 1);
  assert.equal(calls.open[0].file, calls.copy[0].dst, 'open 的必须是临时副本，不是仓库样例');
  assert.equal(calls.rmDir.length, 1);
  assert.equal(calls.rmDir[0], '/tmp/adapter-demo-test-dir');
  assert.equal(report.tempDir, '', '报告里不残留临时目录');
});

// ---------- task-92：系统浮层忽略 + 前台基线稳定性 ----------

test('isSystemOverlay：通知中心/控制中心/Window Server/Dock/Spotlight/loginwindow/输入法候选（中英文、大小写）', () => {
  for (const name of ['NotificationCenter', 'notificationcenter', 'Notification Center', '通知中心',
    'ControlCenter', '控制中心', 'Window Server', 'windowserver', 'loginwindow', 'Dock', 'docker'.replace('docker', 'Dock'),
    'Spotlight', '输入法候选窗口', 'Candidate Window']) {
    assert.equal(isSystemOverlay(name), true, name);
  }
  for (const name of ['Safari', 'Google Chrome', 'TextEdit', 'Docker Desktop', 'Dockyard', '', null]) {
    assert.equal(isSystemOverlay(name), false, String(name));
  }
  assert.equal(frontForCompare('NotificationCenter'), '');
  assert.equal(frontForCompare(' Safari '), 'Safari');
});

test('compareFront：通知横幅中途出现 → 忽略，仍算前台未变；真实抢前台 → 判失败', () => {
  const banner = compareFront('Safari', 'NotificationCenter');
  assert.equal(banner.unchanged, true, '横幅划过不算被抢');
  assert.deepEqual(banner.ignoredOverlays, ['NotificationCenter']);

  const bothBanner = compareFront('ControlCenter', '通知中心');
  assert.equal(bothBanner.unchanged, true);
  assert.deepEqual(bothBanner.ignoredOverlays.sort(), ['ControlCenter', '通知中心'].sort());

  const stolen = compareFront('Safari', 'Google Chrome');
  assert.equal(stolen.unchanged, false);
  assert.equal(stolen.ignoredOverlays.length, 0);

  const unknownAfter = compareFront('Safari', '');
  assert.equal(unknownAfter.unchanged, true, '结束值读不到时不做「被抢」判定');
});

test('sampleFrontBaseline：横幅作基线（第一帧横幅、第二帧真实前台）→ 稳定且基线取真实前台', async () => {
  let i = 0;
  const reads = ['NotificationCenter', 'Safari'];
  const deps = { frontName: async () => reads[i++] || 'Safari', sleep: async () => {} };
  const baseline = await sampleFrontBaseline(deps);
  assert.equal(baseline.stable, true);
  assert.equal(baseline.baseline, 'Safari');
  assert.equal(baseline.raw, 'NotificationCenter', '真实前台记录不被改写');
  assert.equal(baseline.attempts, 1);
  assert.ok(baseline.ignoredOverlays.includes('NotificationCenter'));
});

test('sampleFrontBaseline：基线不稳 → 重试 3 次；仍不稳返回 stable=false（调用方按 envSkip）', async () => {
  let i = 0;
  const seq = ['Safari', 'Google Chrome', 'Safari', 'TextEdit', 'Finder', 'Preview'];
  const deps = { frontName: async () => seq[i++] || 'X', sleep: async () => {} };
  const baseline = await sampleFrontBaseline(deps);
  assert.equal(baseline.stable, false);
  assert.equal(baseline.attempts, 3);
  assert.equal(i, 6, '每次尝试采样 2 次，3 次共 6 次');
  assert.match(baseline.reason, /基线不稳定/);
});

test('sampleFrontBaseline：第 2 次尝试稳定 → 立即返回（不带病重试）', async () => {
  let i = 0;
  const seq = ['Safari', 'Google Chrome', 'Safari', 'Safari'];
  const deps = { frontName: async () => seq[i++] || 'Safari', sleep: async () => {} };
  const baseline = await sampleFrontBaseline(deps);
  assert.equal(baseline.stable, true);
  assert.equal(baseline.baseline, 'Safari');
  assert.equal(baseline.attempts, 2);
});

test('流程：动作后出现通知横幅 → exit0，unchanged=true，输出 ignoredOverlays', async () => {
  const seq = ['Safari', 'Safari', 'Safari', 'NotificationCenter'];
  let i = 0;
  const { deps } = fakeDeps({
    frontName: async () => seq[i++] || 'Safari',
    readState: async () => BUTTON_TREE,
  });
  const { exitCode, report } = await runAdapterDemo({ app: 'Safari' }, deps);
  assert.equal(exitCode, 0, JSON.stringify(report.steps));
  assert.equal(report.front.unchanged, true);
  assert.equal(report.front.before, 'Safari');
  assert.equal(report.front.after, 'NotificationCenter');
  assert.deepEqual(report.ignoredOverlays, ['NotificationCenter']);
  assert.ok(report.steps.some((s) => s.step === 'front-baseline' && s.ok === true));
  const frontStep = report.steps.find((s) => s.step === 'front-unchanged');
  assert.match(frontStep.detail, /忽略系统浮层/);
});

test('流程：基线不稳（连续采样不一致）→ 环境跳过 exit0，不判 FAIL', async () => {
  const seq = ['Safari', 'Google Chrome', 'Safari', 'TextEdit', 'Finder', 'Preview', 'Safari'];
  let i = 0;
  const { deps, calls } = fakeDeps({ frontName: async () => seq[i++] || 'Safari' });
  const { exitCode, report } = await runAdapterDemo({ app: 'Safari' }, deps);
  assert.equal(exitCode, 0, '环境问题不能判 FAIL');
  assert.equal(report.envSkip, true);
  assert.match(report.reason, /基线不稳定/);
  assert.equal(calls.readState, 0, '基线不稳就不该继续读界面树');
  assert.ok(report.steps.some((s) => s.step === 'front-baseline' && s.ok === false));
});

test('流程：横幅作基线 + 动作后真实前台一致 → exit0（不改真实前台记录）', async () => {
  const seq = ['Safari', 'NotificationCenter', 'Safari', 'Safari'];
  let i = 0;
  const { deps } = fakeDeps({ frontName: async () => seq[i++] || 'Safari' });
  const { exitCode, report } = await runAdapterDemo({ app: 'Safari' }, deps);
  assert.equal(exitCode, 0, JSON.stringify(report.steps));
  assert.equal(report.front.baseline, 'Safari');
  assert.equal(report.front.before, 'NotificationCenter', 'front.before 记录真实（可能是浮层）');
  assert.equal(report.front.unchanged, true);
  assert.ok(report.ignoredOverlays.includes('NotificationCenter'));
});

// ---------- task-94：行/单元格点击、写守卫、用户回来即停 ----------

test('流程：按文字点 Finder 侧边栏行（role=tableRow）→ 树变即成功', async () => {
  const finderBefore = ['App=x', 'Window: "flow", App: 访达.', '4 row 文稿', '5 row 桌面'].join('\n');
  const finderAfter = ['App=x', 'Window: "文稿", App: 访达.', '4 row 文稿', '5 row 桌面', '9 row 我的文件'].join('\n');
  let reads = 0;
  const { deps, calls } = fakeDeps({
    readState: async () => { reads += 1; return reads === 1 ? finderBefore : finderAfter; },
    click: async (app, index) => { calls.click.push({ app, index }); return { ok: false }; },
  });
  const { exitCode, report } = await runAdapterDemo({ app: 'Finder', clickText: '文稿' }, deps);
  assert.equal(exitCode, 0, JSON.stringify(report.steps));
  const step = report.steps.find((s) => s.step === 'click-by-text');
  assert.equal(step.role, 'tableRow');
  assert.equal(step.index, '4');
  assert.equal(step.clickOk, false);
  assert.equal(step.changed, true);
});

test('流程：只有 AXTextArea 且没 --allow-write → 环境跳过 exit0（不写）', async () => {
  const tree = ['App=x', 'Window: "备忘录", App: 备忘录.', '26 文本输入区 (settable, string) ID: body, Value: '].join('\n');
  const { deps, calls } = fakeDeps({ readState: async () => tree });
  const { exitCode, report } = await runAdapterDemo({ app: 'Notes', typeText: '[AGENT-TEST] x' }, deps);
  assert.equal(exitCode, 0);
  assert.equal(report.envSkip, true);
  assert.match(report.reason, /AXTextArea/);
  assert.equal(calls.setValue.length, 0, '没 --allow-write 不能写正文区');
});

test('流程：--allow-write + 空 AXTextArea → 写入并读回、写后恢复原值', async () => {
  const empty = ['App=x', 'Window: "备忘录", App: 备忘录.', '26 文本输入区 (settable, string) ID: body, Value: '].join('\n');
  const typed = ['App=x', 'Window: "备忘录", App: 备忘录.', '26 文本输入区 (settable, string) ID: body, Value: [AGENT-TEST] x'].join('\n');
  const seq = [empty, empty, typed, empty]; // read-tree → 写前 latest(空) → 写后读回(typed) → 恢复后读回(空)
  let reads = 0;
  const { deps, calls } = fakeDeps({
    readState: async () => { const v = seq[Math.min(reads, seq.length - 1)]; reads += 1; return v; },
  });
  const { exitCode, report } = await runAdapterDemo({ app: 'Notes', typeText: '[AGENT-TEST] x', allowWrite: true }, deps);
  assert.equal(exitCode, 0, JSON.stringify(report.steps));
  assert.equal(calls.setValue.length, 1, '空 AXTextArea 只写入一次，不回填空串（留给 cleanup 清理）');
  assert.equal(calls.setValue[0].value, '[AGENT-TEST] x');
  assert.ok(report.steps.some((s) => s.step === 'type-text' && s.ok === true));
  const restore = report.steps.find((s) => s.step === 'restore');
  assert.equal(restore.ok, true);
  assert.match(restore.detail, /保留本次.*写入/);
});

test('流程：写守卫拒绝覆盖已有内容（无 --allow-write）→ 不写、exit0', async () => {
  const tree = ['App=x', 'Window: "w", App: 某.', '40 搜索框 (settable, string) Value: 已有内容'].join('\n');
  const { deps, calls } = fakeDeps({ readState: async () => tree });
  const { exitCode, report } = await runAdapterDemo({ app: 'Finder', typeText: 'x' }, deps);
  assert.equal(exitCode, 0);
  assert.equal(calls.setValue.length, 0);
  const guard = report.steps.find((s) => s.step === 'type-guard');
  assert.equal(guard.ok, true);
  assert.match(guard.detail, /拒绝写入/);
});

test('流程：用户中途回来（空闲 <20s）→ 立即环境跳过，不点击', async () => {
  const idleSeq = [60000, 1000]; // 第 1 次=守卫阶段（用户离开），第 2 次=动作前检查（用户已回来）
  let i = 0;
  const { deps, calls } = fakeDeps({
    idleMs: async () => idleSeq[Math.min(i++, idleSeq.length - 1)],
    readState: async () => BUTTON_TREE,
  });
  const { exitCode, report } = await runAdapterDemo({ app: 'Finder', clickText: '提交' }, deps);
  assert.equal(exitCode, 0);
  assert.equal(report.envSkip, true);
  assert.match(report.reason, /回到电脑前/);
  assert.equal(calls.click.length, 0, '用户回来了就不能点');
});

test('流程：默认键鼠空闲阈值 180s 会传给守卫（--min-idle 可配）', async () => {
  const seen = [];
  const { deps } = fakeDeps({
    shouldDeferForActiveUser: (idle, options) => { seen.push(options && options.thresholdMs); return { defer: false, reason: '' }; },
  });
  await runAdapterDemo({ app: 'Finder' }, deps);
  assert.equal(seen[0], 180000, '默认要求用户离开 180s');
  seen.length = 0;
  await runAdapterDemo({ app: 'Finder', minIdleMs: 5000 }, deps);
  assert.equal(seen[0], 5000, '--min-idle 可覆盖');
});

test('本地化显示名能映射到真实进程名（--app 计算器 不应误报没运行）', () => {
  const pairs = [['计算器', 'Calculator'], ['备忘录', 'Notes'], ['访达', 'Finder'], ['预览', 'Preview'], ['微信', 'WeChat']];
  for (const [name, proc] of pairs) assert.equal(processNameFor(name), proc);
});
