'use strict';
// 「目标应用没在跑就不要碰它」闸门的单测（P0 批次B）。
// 背景：ocu 对未运行的应用调用 snapshot/get_app_state/cua.getApp 会把它启动起来并顶到前台
// （默认对象是用户的 Chrome，还带登录 profile）。所以每个 Chrome/演示任务开跑前必须先确认在跑。
// 这里只测纯逻辑和注入探测，不启动任何应用、不碰屏幕。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  NOT_RUNNING_HINT,
  notRunningSkipMessage,
  decideAppPresence,
  probeArgsForApp,
  requireAppRunning,
  reportAppPresence,
  lookupAppAlias,
} from '../core/app-presence.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..');

// ---------- 文案 ----------

test('notRunningSkipMessage：说清「哪个应用 + 没在运行 + 不为了测试启动它」', () => {
  const msg = notRunningSkipMessage('Google Chrome');
  assert.match(msg, /^环境跳过：/);
  assert.match(msg, /Google Chrome 没在运行/);
  assert.match(msg, /不为了测试去启动/);
  assert.ok(msg.includes(NOT_RUNNING_HINT));
  // 名字缺失时也要能读
  assert.match(notRunningSkipMessage(''), /目标应用 没在运行/);
  assert.match(notRunningSkipMessage(null), /目标应用 没在运行/);
  assert.match(notRunningSkipMessage('   '), /目标应用 没在运行/);
});

// ---------- 判定（纯函数） ----------

test('decideAppPresence：确定在运行才放行', () => {
  assert.deepEqual(decideAppPresence({ app: 'Google Chrome', running: true }), {
    proceed: true, skipped: false, forced: false, message: '',
  });
});

test('decideAppPresence：没在运行 → 跳过，并给出可读原因', () => {
  const r = decideAppPresence({ app: 'Google Chrome', running: false });
  assert.equal(r.proceed, false);
  assert.equal(r.skipped, true);
  assert.equal(r.forced, false);
  assert.match(r.message, /环境跳过：Google Chrome 没在运行/);
});

test('decideAppPresence：拿不到运行状态（undefined/null/非 true）一律按没运行处理', () => {
  for (const running of [undefined, null, 0, '', 'true', 1]) {
    const r = decideAppPresence({ app: 'Chrome', running });
    assert.equal(r.proceed, false, 'running=' + JSON.stringify(running) + ' 不该放行');
    assert.equal(r.skipped, true);
  }
});

test('decideAppPresence：allowLaunch 只在显式 true 时放行，并标记 forced', () => {
  const r = decideAppPresence({ app: 'Google Chrome', running: false, allowLaunch: true });
  assert.equal(r.proceed, true);
  assert.equal(r.skipped, false);
  assert.equal(r.forced, true);
  assert.match(r.message, /allowLaunch/);
  // 已经在跑时不需要 forced
  assert.equal(decideAppPresence({ app: 'Chrome', running: true, allowLaunch: true }).forced, false);
  // allowLaunch 用假值不算
  assert.equal(decideAppPresence({ app: 'Chrome', running: false, allowLaunch: 1 }).proceed, false);
});

test('decideAppPresence：无参 / 空对象不崩，按跳过处理', () => {
  assert.equal(decideAppPresence().skipped, true);
  assert.equal(decideAppPresence({}).skipped, true);
  assert.equal(decideAppPresence(null).skipped, true);
});

// ---------- 探测参数：显示名 vs bundle id ----------

test('probeArgsForApp：显示名补全成 appName + bundleId + 英文进程名（别名表）', () => {
  // 只给本地化显示名时，单靠 pgrep -x 中文名 / AppleScript 问中文字符串都可能失败，
  // 会把「明明在跑」的应用判成没在运行 → 任务白白跳过。所以别名表补 bundle + process。
  assert.deepEqual(probeArgsForApp('文本编辑'), {
    appName: '文本编辑',
    bundleId: 'com.apple.TextEdit',
    processName: 'TextEdit',
  });
  assert.deepEqual(probeArgsForApp('计算器'), {
    appName: '计算器',
    bundleId: 'com.apple.calculator',
    processName: 'Calculator',
  });
  assert.deepEqual(probeArgsForApp('Google Chrome'), {
    appName: 'Google Chrome',
    bundleId: 'com.google.Chrome',
    processName: 'Google Chrome',
  });
  // bundle id 输入照旧只走 bundleId 分支
  assert.deepEqual(probeArgsForApp('com.openai.codex'), { bundleId: 'com.openai.codex', appName: 'com.openai.codex' });
  assert.deepEqual(probeArgsForApp('com.apple.TextEdit'), { bundleId: 'com.apple.TextEdit', appName: 'com.apple.TextEdit' });
});

test('probeArgsForApp：别名表里没有的应用按原样探测，不臆造 bundle', () => {
  assert.deepEqual(probeArgsForApp('SomeUnknownApp'), { appName: 'SomeUnknownApp', processName: 'SomeUnknownApp' });
  assert.deepEqual(probeArgsForApp(''), { appName: '', processName: '' });
  assert.deepEqual(probeArgsForApp(null), { appName: '', processName: '' });
});

test('lookupAppAlias：显示名 / bundle id / 进程名 三种写法都能命中，未知返回 null', () => {
  assert.equal(lookupAppAlias('文本编辑').processName, 'TextEdit');
  assert.equal(lookupAppAlias('com.apple.calculator').appName, '计算器');
  assert.equal(lookupAppAlias('TextEdit').bundleId, 'com.apple.TextEdit');
  assert.equal(lookupAppAlias('textedit').processName, 'TextEdit', '大小写不敏感');
  assert.equal(lookupAppAlias('文本 编辑').processName, 'TextEdit', '空格归一');
  assert.equal(lookupAppAlias('没装的应用'), null);
  assert.equal(lookupAppAlias(''), null);
  assert.equal(lookupAppAlias(null), null);
});

// ---------- 探测（注入，不碰真实应用） ----------

test('requireAppRunning：注入 isAppRunning 时传的是补全后的探测参数（含 bundle/进程名）', async () => {
  const seen = [];
  const r = await requireAppRunning('文本编辑', {
    isAppRunning: (args) => { seen.push(args); return true; },
  });
  assert.equal(r.ok, true);
  assert.deepEqual(seen, [{ appName: '文本编辑', bundleId: 'com.apple.TextEdit', processName: 'TextEdit' }]);
});

test('requireAppRunning：在运行 → ok，不再启动任何东西', async () => {
  const seen = [];
  const r = await requireAppRunning('Google Chrome', {
    isRunning: (name) => { seen.push(name); return true; },
  });
  assert.equal(r.ok, true);
  assert.equal(r.running, true);
  assert.equal(r.skipped, false);
  assert.equal(r.message, '');
  assert.deepEqual(seen, ['Google Chrome']);
});

test('requireAppRunning：没在运行 → ok:false + skipped，message 可读', async () => {
  const r = await requireAppRunning('Google Chrome', { isRunning: () => false });
  assert.equal(r.ok, false);
  assert.equal(r.running, false);
  assert.equal(r.skipped, true);
  assert.match(r.message, /环境跳过：Google Chrome 没在运行/);
});

test('requireAppRunning：探测抛错按「没在跑」处理（宁可跳过也不冒险拉起应用）', async () => {
  const r = await requireAppRunning('Google Chrome', { isRunning: () => { throw new Error('permission denied'); } });
  assert.equal(r.ok, false);
  assert.equal(r.skipped, true);
});

test('requireAppRunning：allowLaunch 放行未运行的应用，forced=true', async () => {
  const r = await requireAppRunning('Google Chrome', { isRunning: () => false, allowLaunch: true });
  assert.equal(r.ok, true);
  assert.equal(r.forced, true);
  assert.match(r.message, /allowLaunch/);
});

test('requireAppRunning：直接注入 background.isAppRunning 时，bundle id 走 bundleId 分支', async () => {
  const calls = [];
  const fake = (args) => { calls.push(args); return true; };
  const r = await requireAppRunning('com.google.Chrome', { isAppRunning: fake });
  assert.equal(r.ok, true);
  assert.deepEqual(calls[0], { bundleId: 'com.google.Chrome', appName: 'com.google.Chrome' });
});

test('requireAppRunning：没注入探测函数就直接报错（不允许静默放过）', async () => {
  await assert.rejects(() => requireAppRunning('Google Chrome', {}), /需要注入 isRunning 或 isAppRunning/);
  await assert.rejects(() => requireAppRunning('Google Chrome'), /需要注入 isRunning 或 isAppRunning/);
});

test('reportAppPresence：跳过时打印并返回 true；放行时打印警示但返回 false', () => {
  const logs = [];
  const skipped = reportAppPresence(
    { skipped: true, message: '环境跳过：Google Chrome 没在运行' },
    (line) => logs.push(line),
  );
  assert.equal(skipped, true);
  assert.deepEqual(logs, ['环境跳过：Google Chrome 没在运行']);

  logs.length = 0;
  const ok = reportAppPresence({ skipped: false, message: '注意：放行' }, (line) => logs.push(line));
  assert.equal(ok, false);
  assert.deepEqual(logs, ['注意：放行']);

  logs.length = 0;
  assert.equal(reportAppPresence({ skipped: false, message: '' }, (line) => logs.push(line)), false);
  assert.deepEqual(logs, [], '在运行时不该多打日志');
});

// ---------- 静态回归：闸门必须出现在第一次碰应用之前 ----------

const GUARDED = [
  { file: 'core/tasks/form-fill.mjs', firstTouch: 'ocu.frontmost()' },
  { file: 'core/tasks/mcp-demo.mjs', firstTouch: 'getOcuMcp()' },
  // 注意：这里找的是「调用点」不是函数定义（ocuState/spawnCli 的定义在文件前部）
  { file: 'core/tasks/platform-demo.mjs', firstTouch: 'await ocuState(target)' },
  { file: 'scripts/bench-ocu.mjs', firstTouch: 'await spawnCli(' },
];

for (const { file, firstTouch } of GUARDED) {
  test('闸门顺序：' + file + ' 在第一次碰应用（' + firstTouch + '）之前先查运行状态', () => {
    const source = fs.readFileSync(path.join(REPO, file), 'utf8');
    const guardAt = source.indexOf('requireAppRunning(');
    const touchAt = source.indexOf(firstTouch);
    assert.ok(guardAt >= 0, file + ' 没有调用 requireAppRunning');
    assert.ok(touchAt >= 0, file + ' 找不到预期触点 ' + firstTouch);
    assert.ok(guardAt < touchAt, file + ' 的运行检查必须在 ' + firstTouch + ' 之前');
    assert.match(source, /reportAppPresence\(/, file + ' 缺少统一的跳过处理（要 print + 退出 0）');
  });
}
