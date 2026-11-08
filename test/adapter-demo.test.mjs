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

test('pickClickTarget：精确优先、其次包含；找不到给出候选；pickTypeTarget 优先文本输入区', () => {
  const summary = summarizeTree(BUTTON_TREE);
  assert.deepEqual(pickClickTarget(summary, '提交'), { found: true, index: '2', label: '提交', match: 'exact' });
  assert.equal(pickClickTarget(summary, '交').match, 'contains');
  const missing = pickClickTarget(summary, '不存在');
  assert.equal(missing.found, false);
  assert.equal(missing.candidates.length, 2);

  const typed = pickTypeTarget(summary);
  assert.equal(typed.found, true);
  assert.equal(typed.index, '4');
  assert.equal(typed.kind, 'textArea');
  assert.equal(pickTypeTarget({ inputs: [] }).found, false);
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

test('流程：点击后界面树无变化 → 能力失败 exit1', async () => {
  const { deps } = fakeDeps({ readState: async () => BUTTON_TREE });
  const { exitCode, report } = await runAdapterDemo({ app: 'TextEdit', clickText: '提交' }, deps);
  assert.equal(exitCode, 1);
  const step = report.steps.find((s) => s.step === 'click-by-text');
  assert.equal(step.ok, false);
  assert.match(step.detail, /没有可观测变化/);
});

test('流程：前台被改变 → 能力失败 exit1', async () => {
  let frontCalls = 0;
  const { deps } = fakeDeps({
    frontName: async () => { frontCalls += 1; return frontCalls === 1 ? 'DeepSeek Harness' : 'Preview'; },
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
