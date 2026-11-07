'use strict';
import test from 'node:test';
import assert from 'node:assert/strict';
import { startFrontWatch } from '../core/front-watch.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('前台被抢一次：还原并计数', async () => {
  let front = 'DSH';
  const restored = [];
  const w = startFrontWatch({
    expect: 'DSH',
    intervalMs: 20,
    getFront: async () => front,
    restore: async (name) => { restored.push(name); front = name; return true; },
  });
  await sleep(40);
  front = 'Calculator';           // 模拟被抢
  await sleep(120);
  const stats = w.stats();
  w.stop();
  assert.ok(stats.steals >= 1, '应记录到抢占');
  assert.ok(restored.includes('DSH'), '应尝试还原到用户原来的应用');
});

test('用户反复切同一个应用：放弃还原，认账为用户意图', async () => {
  let front = 'DSH';
  let restores = 0;
  const w = startFrontWatch({
    expect: 'DSH',
    intervalMs: 20,
    userIntentMs: 300,
    getFront: async () => front,
    restore: async (name) => { restores += 1; front = name; return true; },
  });
  await sleep(30);
  // 连续把它切走（模拟用户不停点 Calculator）
  for (let i = 0; i < 6; i += 1) { front = 'Calculator'; await sleep(60); }
  const stats = w.stats();
  w.stop();
  assert.equal(stats.expect, 'Calculator', '反复切换后应把期望前台更新为用户选择的应用');
  assert.ok(restores < 6, '不应无限次和用户抢（restores=' + restores + '）');
});

test('没有漂移就不做任何还原', async () => {
  const restored = [];
  const w = startFrontWatch({
    expect: 'DSH',
    intervalMs: 20,
    getFront: async () => 'DSH',
    restore: async (name) => { restored.push(name); return true; },
  });
  await sleep(100);
  const stats = w.stats();
  w.stop();
  assert.equal(stats.steals, 0);
  assert.equal(restored.length, 0);
});

test('还原失败不抛错、不卡死轮询', async () => {
  let front = 'DSH';
  const w = startFrontWatch({
    expect: 'DSH',
    intervalMs: 20,
    getFront: async () => front,
    restore: async () => { throw new Error('boom'); },
  });
  await sleep(30);
  front = 'Chrome';
  await sleep(100);
  const stats = w.stats();
  w.stop();
  assert.ok(stats.steals >= 1, '抢占应被记录');
  assert.equal(stats.restores, 0, '还原失败不计入成功次数');
});

test('看门狗停止后不再轮询', async () => {
  let calls = 0;
  const w = startFrontWatch({
    expect: 'DSH',
    intervalMs: 20,
    getFront: async () => { calls += 1; return 'DSH'; },
    restore: async () => true,
  });
  await sleep(60);
  w.stop();
  const seen = calls;
  await sleep(80);
  assert.equal(calls, seen, 'stop 之后不应该继续轮询');
});
