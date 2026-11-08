'use strict';
// 任务被中途杀死时，必须把自己拉起的应用关掉，不能留给用户
import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmergencyAppCleanup } from '../core/task-emergency-cleanup.mjs';
import { canAttemptQuit, remainingBudgetMs, quitAppSync } from '../core/sync-quit.mjs';

test('按清单逐个关掉应用，再退出 143', async () => {
  const quit = [];
  const exits = [];
  const cleanup = createEmergencyAppCleanup({
    list: () => [{ appName: '计算器' }, { appName: '备忘录' }],
    quit: async (app) => { quit.push(app.appName); return { quit: true }; },
    onExit: (code) => exits.push(code),
  });
  await cleanup('SIGTERM');
  assert.deepEqual(quit, ['计算器', '备忘录']);
  assert.deepEqual(exits, [143]);
});

test('SIGINT 退出码 130；重复调用只执行一次', async () => {
  let n = 0;
  const exits = [];
  const cleanup = createEmergencyAppCleanup({
    list: () => [{ appName: 'Calculator' }],
    quit: async () => { n += 1; return { quit: true }; },
    onExit: (code) => exits.push(code),
  });
  await cleanup('SIGINT');
  await cleanup('SIGINT');
  assert.equal(n, 1);
  assert.deepEqual(exits, [130]);
});

test('单个应用关失败不影响其它应用，也不抛错', async () => {
  const quit = [];
  const exits = [];
  const cleanup = createEmergencyAppCleanup({
    list: () => ['A', 'B'],
    quit: async (app) => { quit.push(app); if (app === 'A') throw new Error('boom'); return { quit: true }; },
    onExit: (code) => exits.push(code),
  });
  await cleanup();
  assert.deepEqual(quit, ['A', 'B']);
  assert.deepEqual(exits, [143]);
});

test('清单读不出来也不崩', async () => {
  const exits = [];
  const cleanup = createEmergencyAppCleanup({
    list: () => { throw new Error('no list'); },
    quit: async () => null,
    onExit: (code) => exits.push(code),
  });
  await cleanup();
  assert.deepEqual(exits, [143]);
});
test('有 quitSync 时走同步路径：在其它退出钩子之前就把应用关掉', () => {
  const order = [];
  const cleanup = createEmergencyAppCleanup({
    list: () => ['Calculator'],
    quitSync: (app) => { order.push('quitSync:' + app); return { quit: true }; },
    onExit: (code) => order.push('exit:' + code),
  });
  cleanup.cleanupSync('SIGTERM');
  assert.deepEqual(order, ['quitSync:Calculator', 'exit:143']);
});

test('同步路径只执行一次；SIGINT 退出 130', () => {
  const order = [];
  const cleanup = createEmergencyAppCleanup({
    list: () => ['A'],
    quitSync: () => { order.push('quit'); return { quit: true }; },
    onExit: (code) => order.push('exit:' + code),
  });
  cleanup.cleanupSync('SIGINT');
  cleanup.cleanupSync('SIGINT');
  assert.deepEqual(order, ['quit', 'exit:130']);
});

// ---------- M-2：清理预算（deadline/budget） ----------

test('quitAppSync 预算判定：剩余不足 500ms 不再尝试 AppleScript', () => {
  assert.deepEqual(canAttemptQuit(Number.POSITIVE_INFINITY, 1000), { attempt: true, remainingMs: Infinity });
  assert.deepEqual(canAttemptQuit(1400, 1000), { attempt: false, remainingMs: 400 });
  assert.deepEqual(canAttemptQuit(1500, 1000), { attempt: true, remainingMs: 500 });
  assert.equal(remainingBudgetMs(900, 1000), 0);
  assert.equal(remainingBudgetMs(Number.POSITIVE_INFINITY, 1000), Infinity);
});

test('应急清理总预算耗尽后不再调用后续应用（同步路径）', () => {
  let clock = 1000;
  const calls = [];
  const logs = [];
  const cleanup = createEmergencyAppCleanup({
    list: () => ['A', 'B', 'C'],
    quitSync: (app, opts) => {
      calls.push({ app, budgetMs: opts && opts.budgetMs, deadlineAt: opts && opts.deadlineAt });
      clock += 3000; // 第一个应用把预算用光
      return { quit: true, mode: 'quit' };
    },
    onExit: (code) => { logs.push(['exit', code]); },
    log: (app, result) => { logs.push([app, result]); },
    now: () => clock,
    budgetMs: 2500,
  });
  cleanup.cleanupSync('SIGTERM');
  assert.deepEqual(calls.map((c) => c.app), ['A']);
  assert.equal(calls[0].deadlineAt, 3500);
  assert.equal(calls[0].budgetMs, 2500);
  assert.deepEqual(logs[0], ['A', { quit: true, mode: 'quit' }]);
  assert.deepEqual(logs[1], ['B', { quit: false, mode: 'budget-exhausted', remainingMs: 0 }]);
  assert.deepEqual(logs[2], ['C', { quit: false, mode: 'budget-exhausted', remainingMs: 0 }]);
  assert.deepEqual(logs[3], ['exit', 143]);
});

test('应急清理总预算耗尽后不再调用后续应用（异步路径）', async () => {
  let clock = 0;
  const calls = [];
  const cleanup = createEmergencyAppCleanup({
    list: () => ['A', 'B'],
    quit: async (app) => { calls.push(app); clock += 5000; return { quit: true }; },
    onExit: () => {},
    now: () => clock,
    budgetMs: 1000,
  });
  await cleanup('SIGTERM');
  assert.deepEqual(calls, ['A']);
});

test('不传 budgetMs 时默认总预算 2500ms，并逐应用传剩余预算', () => {
  let clock = 0;
  let seen = null;
  const cleanup = createEmergencyAppCleanup({
    list: () => ['A'],
    quitSync: (app, opts) => { seen = opts; return { quit: true }; },
    onExit: () => {},
    now: () => clock,
  });
  cleanup.cleanupSync('SIGTERM');
  assert.equal(cleanup.budgetMs, 2500);
  assert.equal(seen.deadlineAt, 2500);
  assert.equal(seen.budgetMs, 2500);
});
test('quitAppSync 预算不足时直接返回 budget-exhausted（不启动 AppleScript）', () => {
  const started = Date.now();
  const byBudget = quitAppSync({ appName: 'Calculator' }, { budgetMs: 0 });
  assert.equal(byBudget.quit, false);
  assert.equal(byBudget.mode, 'budget-exhausted');
  assert.equal(byBudget.remainingMs, 0);

  const byDeadline = quitAppSync({ appName: 'Calculator' }, { deadlineAt: Date.now() - 10 });
  assert.equal(byDeadline.mode, 'budget-exhausted');
  // 纯判定路径，不应该真的去调 osascript/pgrep（本机没有 Calculator 也不会被卡住）
  assert.ok(Date.now() - started < 500);
});
