'use strict';
// 验收期间的「意外应用」兜底：只收「验收开始后新出现」的测试应用，用户原有的一律不动。
// 现场回放：2026-11-08 16:09 验收，multi-app 把原本没在运行的计算器拉起来留在后台。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  toNameSet,
  diffNewlyRunning,
  isAppRunning,
  sampleRunningApps,
  cleanupMessages,
} from '../core/acceptance-cleanup.mjs';

const TEST_APPS = ['Calculator', 'Notes', 'TextEdit', 'FastZip', 'Keynote', 'DeepSeek Harness'];

test('diffNewlyRunning：新出现的应用才算「意外拉起」', () => {
  const before = new Set(['DeepSeek Harness']);
  const after = new Set(['DeepSeek Harness', 'Calculator']);
  assert.deepEqual(diffNewlyRunning(before, after, TEST_APPS), ['Calculator']);
});

test('diffNewlyRunning：现场回放（16:09 计算器被多拉起）', () => {
  // 验收开始：用户开着 DSH 和备忘录，计算器没开
  const before = new Set(['DeepSeek Harness', 'Notes']);
  // multi-app 之后：计算器被拉起并留在后台
  const after = new Set(['DeepSeek Harness', 'Notes', 'Calculator']);
  assert.deepEqual(diffNewlyRunning(before, after, TEST_APPS), ['Calculator']);
});

test('diffNewlyRunning：没有新增（相同集合）→ 空', () => {
  const same = ['DeepSeek Harness', 'Notes'];
  assert.deepEqual(diffNewlyRunning(same, same, TEST_APPS), []);
  assert.deepEqual(diffNewlyRunning(new Set(same), new Set(same), TEST_APPS), []);
});

test('diffNewlyRunning：应用变少（任务关掉了应用）不算新增', () => {
  assert.deepEqual(diffNewlyRunning(['Notes', 'Calculator'], ['Notes'], TEST_APPS), []);
  assert.deepEqual(diffNewlyRunning(['Notes', 'Calculator'], [], TEST_APPS), []);
});

test('diffNewlyRunning：空输入不抛，返回空', () => {
  assert.deepEqual(diffNewlyRunning(), []);
  assert.deepEqual(diffNewlyRunning(null, null), []);
  assert.deepEqual(diffNewlyRunning([], [], TEST_APPS), []);
  assert.deepEqual(diffNewlyRunning(new Set(), new Set(), TEST_APPS), []);
});

test('diffNewlyRunning：只认测试应用名单，用户其它新程序不碰', () => {
  const before = [];
  const after = ['Calculator', 'Safari', 'Terminal', 'SomeRandomApp'];
  assert.deepEqual(diffNewlyRunning(before, after, TEST_APPS), ['Calculator']);
  // 不传 testApps 时不限制（调用方要求全量对比的场景）
  assert.deepEqual(diffNewlyRunning(before, after), ['Calculator', 'Safari', 'Terminal', 'SomeRandomApp']);
});

test('diffNewlyRunning：接受 Set / 数组 / 字符串，结果按 after 顺序', () => {
  assert.deepEqual(diffNewlyRunning(new Set(['A']), new Set(['A', 'B', 'C']), new Set(['B', 'C'])), ['B', 'C']);
  assert.deepEqual(diffNewlyRunning(['A'], ['A', 'C', 'B'], ['B', 'C']), ['C', 'B']);
  assert.deepEqual(diffNewlyRunning(['A'], ['A', 'B'], null), ['B']);
  // 单个字符串按「一个应用名」理解，不按逗号拆
  assert.deepEqual(diffNewlyRunning('A', 'B', null), ['B']);
  assert.deepEqual(diffNewlyRunning('A', 'A', null), []);
});

test('toNameSet：空值/空白/非字符串都能安全规整', () => {
  assert.deepEqual([...toNameSet(null)], []);
  assert.deepEqual([...toNameSet(undefined)], []);
  assert.deepEqual([...toNameSet('  Notes  ')], ['Notes']);
  assert.deepEqual([...toNameSet(['  Notes ', '', null, undefined, 'TextEdit'])], ['Notes', 'TextEdit']);
  assert.deepEqual([...toNameSet(42)], []);
});

test('sampleRunningApps：注入 isRunning，只采名单内的应用', () => {
  const runningNow = ['Calculator', 'Safari'];
  let probed = [];
  const result = sampleRunningApps(TEST_APPS, {
    isRunning: (name) => { probed.push(name); return runningNow.includes(name); },
  });
  assert.deepEqual([...result], ['Calculator']);
  assert.deepEqual(probed, TEST_APPS, '只对名单里的应用逐个探测');
});

test('sampleRunningApps：isRunning 抛错当成「没在跑」，不影响其它应用', () => {
  const result = sampleRunningApps(['Calculator', 'Notes'], {
    isRunning: (name) => { if (name === 'Calculator') throw new Error('boom'); return true; },
  });
  assert.deepEqual([...result], ['Notes']);
});

test('sampleRunningApps：注入 execFileSync（pgrep 成功=在跑，抛错=没跑）', () => {
  const calls = [];
  const result = sampleRunningApps(['Calculator', 'Notes'], {
    execFileSync: (cmd, args) => {
      calls.push([cmd, args]);
      if (args[1] === 'Calculator') return Buffer.from('123');
      const err = new Error('exit 1');
      throw err;
    },
  });
  assert.deepEqual([...result], ['Calculator']);
  assert.equal(calls[0][0], '/usr/bin/pgrep');
  assert.deepEqual(calls[0][1], ['-x', 'Calculator']);
});

test('isAppRunning：空名字不发命令', () => {
  let called = 0;
  assert.equal(isAppRunning('', { execFileSync: () => { called += 1; } }), false);
  assert.equal(isAppRunning('   ', { execFileSync: () => { called += 1; } }), false);
  assert.equal(called, 0);
});

test('sampleRunningApps：非 macOS 不跑 pgrep，直接返回空集', () => {
  let called = 0;
  const result = sampleRunningApps(TEST_APPS, {
    platform: 'linux',
    execFileSync: () => { called += 1; },
  });
  assert.equal(result.size, 0);
  assert.equal(called, 0);
});

test('cleanupMessages：报告里那句话写清楚「收掉 + 哪个应用 + 哪个阶段」', () => {
  assert.deepEqual(cleanupMessages(['Calculator'], '任务 multi-app 之后'), [
    '收掉验收期间被拉起的 Calculator（任务 multi-app 之后）',
  ]);
  assert.deepEqual(cleanupMessages(['Calculator', 'Notes']), [
    '收掉验收期间被拉起的 Calculator',
    '收掉验收期间被拉起的 Notes',
  ]);
  assert.deepEqual(cleanupMessages([]), []);
});
