'use strict';
// 验收期间的「意外应用」兜底：只收「验收开始后新出现」的测试应用，用户原有的一律不动。
// 现场回放：2026-11-08 16:09 验收，multi-app 把原本没在运行的计算器拉起来留在后台。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  toNameSet,
  normalizeAppName,
  diffNewlyRunning,
  isAppRunning,
  sampleRunningApps,
  shouldRunCleanup,
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
  assert.deepEqual([...result.apps], ['Calculator']);
  assert.equal(result.trusted, true, '正常采样应当可信');
  assert.deepEqual(probed, TEST_APPS, '只对名单里的应用逐个探测');
});

test('sampleRunningApps：isRunning 抛错当成「没在跑」，不影响其它应用', () => {
  const result = sampleRunningApps(['Calculator', 'Notes'], {
    isRunning: (name) => { if (name === 'Calculator') throw new Error('boom'); return true; },
  });
  assert.deepEqual([...result.apps], ['Notes']);
  assert.equal(result.errors, 1, '失败的探测要计数');
  assert.equal(result.trusted, true, '部分失败但采到了结果，仍算可信');
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
  assert.deepEqual([...result.apps], ['Calculator']);
  assert.equal(calls[0][0], '/usr/bin/pgrep');
  assert.deepEqual(calls[0][1], ['-x', 'Calculator']);
});

test('isAppRunning：空名字不发命令', () => {
  let called = 0;
  assert.equal(isAppRunning('', { execFileSync: () => { called += 1; } }), false);
  assert.equal(isAppRunning('   ', { execFileSync: () => { called += 1; } }), false);
  assert.equal(called, 0);
});

test('sampleRunningApps：非 macOS 不跑 pgrep，返回空集且标记不可信', () => {
  let called = 0;
  const result = sampleRunningApps(TEST_APPS, {
    platform: 'linux',
    execFileSync: () => { called += 1; },
  });
  assert.equal(result.apps.size, 0);
  assert.equal(result.trusted, false, '非 macOS 的空集不能当成「真没在跑」');
  assert.match(result.reason, /非 macOS/);
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

// ---------- P2：应用标识归一（大小写 / 空白 / 分隔符不敏感） ----------
// 复现 risk：同一个应用换种写法就被当成「任务新拉起的」，于是去退出用户本来开着的应用。

test('P2 归一：大小写不同不算「新拉起」', () => {
  assert.deepEqual(diffNewlyRunning(['Calculator'], ['calculator'], TEST_APPS), []);
  assert.deepEqual(diffNewlyRunning(['calculator'], ['Calculator'], TEST_APPS), []);
  assert.deepEqual(diffNewlyRunning(['CALCULATOR'], ['Calculator'], TEST_APPS), []);
  assert.deepEqual(diffNewlyRunning(['TextEdit'], ['textedit'], TEST_APPS), []);
});

test('P2 归一：首尾空白 / 分隔符不同不算「新拉起」', () => {
  assert.deepEqual(diffNewlyRunning(['  Calculator '], ['Calculator'], TEST_APPS), []);
  assert.deepEqual(diffNewlyRunning(['DeepSeek-Harness'], ['DeepSeek Harness'], TEST_APPS), []);
  assert.deepEqual(diffNewlyRunning(['deepseek_harness'], ['DeepSeekHarness'], TEST_APPS), []);
});

test('P2 归一：输出统一用名单里的规范写法', () => {
  assert.deepEqual(diffNewlyRunning([], ['  calculator '], TEST_APPS), ['Calculator']);
  assert.deepEqual(diffNewlyRunning([], ['TEXTEDIT'], TEST_APPS), ['TextEdit']);
  assert.deepEqual(diffNewlyRunning([], ['deepseek harness'], TEST_APPS), ['DeepSeek Harness']);
});

test('P2 归一：不在名单里的写法不会被认成测试应用（宁可不收也不误收）', () => {
  // 应用身份以 TEST_APPS 里的进程名为准；本地化显示名不在名单里 → 不归我们管
  assert.deepEqual(diffNewlyRunning([], ['计算器'], TEST_APPS), []);
  assert.deepEqual(diffNewlyRunning([], ['Safari'], TEST_APPS), []);
  assert.deepEqual(diffNewlyRunning([], ['Google Chrome'], TEST_APPS), []);
});

test('P2 归一：normalizeAppName 与前台还原共用同一套规则', () => {
  assert.equal(normalizeAppName('  Clash Verge '), 'clashverge');
  assert.equal(normalizeAppName('clash-verge'), 'clashverge');
  assert.equal(normalizeAppName('WPS Office'), 'wpsoffice');
  assert.equal(normalizeAppName(null), '');
  assert.equal(normalizeAppName('   '), '');
});

// ---------- P3：基线可信度（不可信时只报告、不退出应用） ----------

test('P3：非 macOS → 采样不可信，绝不能当成「真没在跑」', () => {
  const sample = sampleRunningApps(TEST_APPS, { platform: 'linux' });
  assert.equal(sample.trusted, false);
  assert.equal(sample.apps.size, 0);
  assert.match(sample.reason, /非 macOS/);
});

test('P3：全部探测失败 → 不可信', () => {
  const sample = sampleRunningApps(['Calculator', 'Notes'], {
    isRunning: () => { throw new Error('pgrep 挂了'); },
  });
  assert.equal(sample.apps.size, 0);
  assert.equal(sample.errors, 2);
  assert.equal(sample.trusted, false);
  assert.match(sample.reason, /全部探测失败/);
});

test('P3：有的探测失败但采到了应用 → 仍可信（不能因为一个失败就完全不收尾）', () => {
  const sample = sampleRunningApps(['Calculator', 'Notes'], {
    isRunning: (name) => { if (name === 'Calculator') throw new Error('boom'); return true; },
  });
  assert.equal(sample.trusted, true);
  assert.deepEqual([...sample.apps], ['Notes']);
});

test('P3：有探测失败且一个都没采到 → 不可信（分不清是真没开还是全挂了）', () => {
  const sample = sampleRunningApps(['Calculator', 'Notes'], {
    isRunning: (name) => { if (name === 'Calculator') return false; throw new Error('boom'); },
  });
  assert.equal(sample.apps.size, 0);
  assert.equal(sample.trusted, false);
  assert.match(sample.reason, /一个应用都没采到/);
});

test('P3：空名单不探测，视为可信（没有应用需要保护，也不会有误收）', () => {
  let called = 0;
  const sample = sampleRunningApps([], { isRunning: () => { called += 1; return true; } });
  assert.equal(called, 0);
  assert.equal(sample.trusted, true);
  assert.equal(sample.apps.size, 0);
});

test('P3 shouldRunCleanup：基线不可信 → 不执行收尾', () => {
  const sample = sampleRunningApps(['Calculator'], { isRunning: (n) => n === 'Calculator' });
  const decision = shouldRunCleanup(false, sample);
  assert.equal(decision.run, false);
  assert.match(decision.reason, /基线不可信/);
});

test('P3 shouldRunCleanup：本次采样不可信 → 这一轮不动手', () => {
  const bad = sampleRunningApps(TEST_APPS, { platform: 'linux' });
  const decision = shouldRunCleanup(true, bad);
  assert.equal(decision.run, false);
  assert.match(decision.reason, /非 macOS/);
});

test('P3 shouldRunCleanup：基线可信 + 采样可信 → 正常收', () => {
  const good = sampleRunningApps(['Calculator'], { isRunning: (n) => n === 'Calculator' });
  const decision = shouldRunCleanup(true, good);
  assert.equal(decision.run, true);
  assert.equal(decision.reason, '');
  // 只检查基线（还没采样）时也应当允许继续
  assert.equal(shouldRunCleanup(true, null).run, true);
});
