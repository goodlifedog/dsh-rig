'use strict';
// 任务被中途杀死时，必须把自己拉起的应用关掉，不能留给用户
import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmergencyAppCleanup } from '../core/task-emergency-cleanup.mjs';

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
