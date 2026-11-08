'use strict';
// 验收「残留应用清理」的边界用例（task-38 首版；task-40 按 P2/P3 修复后更新）。
// 主体逻辑在 core/acceptance-cleanup.mjs：验收开始采样基线 → 每跑完一个任务再采样 →
// 只收「基线上没有、现在有」的测试应用。这里专门压边界：空集合、大小写/空白归一、
// 中文/英文名、重复、非测试应用、基线不可信，以及和 acceptance.mjs 实际调用顺序一致的组合场景。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  toNameSet,
  normalizeAppName,
  diffNewlyRunning,
  sampleRunningApps,
  shouldRunCleanup,
  cleanupMessages,
} from '../core/acceptance-cleanup.mjs';
import { TEST_APPS } from '../core/acceptance.mjs';

test('before 为空：验收开始时一个测试应用都没开，之后出现的全算新增', () => {
  assert.deepEqual(
    diffNewlyRunning([], ['Calculator', 'Notes', 'TextEdit'], TEST_APPS),
    ['Calculator', 'Notes', 'TextEdit'],
  );
  assert.deepEqual(diffNewlyRunning(new Set(), new Set(['FastZip']), TEST_APPS), ['FastZip']);
});

test('after 为空 / 两边都为空：没有新增，也不能崩', () => {
  assert.deepEqual(diffNewlyRunning(['Calculator', 'Notes'], [], TEST_APPS), []);
  assert.deepEqual(diffNewlyRunning([], [], TEST_APPS), []);
  assert.deepEqual(diffNewlyRunning(new Set(['Calculator']), new Set(), TEST_APPS), []);
});

test('多个新增：结果顺序跟 after 的遍历顺序一致', () => {
  assert.deepEqual(
    diffNewlyRunning(['Calculator'], ['TextEdit', 'Notes', 'Calculator'], TEST_APPS),
    ['TextEdit', 'Notes'],
  );
});

test('重复名字不重复返回（after 里同一个应用出现多次）', () => {
  assert.deepEqual(diffNewlyRunning([], ['Calculator', 'Calculator', 'Calculator'], TEST_APPS), ['Calculator']);
  assert.deepEqual(diffNewlyRunning(new Set(), ['Notes', 'Calculator', 'Notes'], TEST_APPS), ['Notes', 'Calculator']);
  // before 里重复也不影响判定
  assert.deepEqual(diffNewlyRunning(['Notes', 'Notes'], ['Notes', 'Calculator'], TEST_APPS), ['Calculator']);
});

test('名字前后空白会被规整掉（pgrep/AX 偶尔会带空格）', () => {
  assert.deepEqual(diffNewlyRunning([], ['  Calculator  '], TEST_APPS), ['Calculator']);
  assert.deepEqual(diffNewlyRunning([' Calculator '], ['Calculator'], TEST_APPS), []);
});

test('非测试应用一律过滤：用户新开的浏览器/终端不归验收管', () => {
  assert.deepEqual(
    diffNewlyRunning([], ['Calculator', 'Safari', 'Terminal', 'iTerm2', 'Google Chrome'], TEST_APPS),
    ['Calculator'],
  );
});

test('testApps 是空集合：谁都不归我们管', () => {
  assert.deepEqual(diffNewlyRunning([], ['Calculator', 'Notes'], []), []);
  assert.deepEqual(diffNewlyRunning([], ['Calculator'], new Set()), []);
});

// ---- P2：标识归一。原来的「已知边界：大小写敏感」已修 ----

test('P2 已修：大小写不同不再被误判成「新拉起」（原边界用例）', () => {
  // 旧行为：'Calculator' 与 'calculator' 是两个字符串 → 有时候会被当成新增，进而退出用户应用
  assert.deepEqual(diffNewlyRunning(['Calculator'], ['calculator'], ['Calculator']), []);
  // 名单里同时写了两种大小写，也仍然归一到同一个应用，不再报「新增」
  assert.deepEqual(diffNewlyRunning(['Calculator'], ['calculator'], ['Calculator', 'calculator']), []);
  assert.deepEqual(diffNewlyRunning(['CALCULATOR'], ['  Calculator  '], TEST_APPS), []);
});

test('P2 已修：归一后输出统一用名单里的规范写法', () => {
  assert.deepEqual(diffNewlyRunning([], ['calculator'], ['Calculator']), ['Calculator']);
  assert.deepEqual(diffNewlyRunning([], ['text-edit'], TEST_APPS), ['TextEdit']);
});

test('P2：分隔符/空白归一（空格、连字符、下划线、点）', () => {
  for (const variant of ['DeepSeek-Harness', 'DeepSeek_Harness', 'deepseek harness', 'DeepSeekHarness']) {
    assert.deepEqual(diffNewlyRunning([variant], ['DeepSeek Harness'], TEST_APPS), [], variant + ' 应视为同一个应用');
  }
  assert.equal(normalizeAppName('Clash Verge'), normalizeAppName('clash-verge'));
});

test('P2：身份只用 TEST_APPS 的进程名——本地化显示名不归我们管', () => {
  // 修法不是「中英文互译」，而是「采样与比较都用 TEST_APPS 的进程名」：
  // 本地化名（如「计算器」）不在名单里 → 直接过滤，永远不会被当成待收应用。
  assert.deepEqual(diffNewlyRunning([], ['计算器'], TEST_APPS), []);
  assert.deepEqual(diffNewlyRunning([], ['备忘录', '文本编辑'], TEST_APPS), []);
});

test('P2：TEST_APPS 必须只用进程名（ASCII），且归一后不能有重复', () => {
  // 结构约束：只要名单里只有进程名、采样只回名单里的名字，就不会出现「中文 vs 英文」两套标识。
  for (const name of TEST_APPS) {
    assert.match(name, /^[A-Za-z][A-Za-z0-9 ._-]*$/, name + ' 应当是进程名（不要写本地化显示名）');
    assert.ok(name.trim(), '名单里不能有空名字');
  }
  const keys = TEST_APPS.map((name) => normalizeAppName(name));
  assert.equal(new Set(keys).size, keys.length, 'TEST_APPS 归一后不能重复，否则同一个应用会有两个标识');
});

test('现场回放（16:09）：baseline 里有用户自己的备忘录，只收任务多拉起的计算器', () => {
  const baseline = new Set(['DeepSeek Harness', 'Notes']);       // 验收开始时用户开着 DSH + 备忘录
  const afterTask = new Set(['DeepSeek Harness', 'Notes', 'Calculator']); // multi-app 把计算器拉起来没关
  const unexpected = diffNewlyRunning(baseline, afterTask, TEST_APPS);
  assert.deepEqual(unexpected, ['Calculator']);
  assert.equal(unexpected.includes('Notes'), false, '用户自己的备忘录绝不能出现在待收名单里');
  assert.equal(unexpected.includes('DeepSeek Harness'), false, '宿主不能被当成残留应用');
  // 报告里的那句话
  assert.deepEqual(cleanupMessages(unexpected, '任务 multi-app 之后'), [
    '收掉验收期间被拉起的 Calculator（任务 multi-app 之后）',
  ]);
});

test('幂等：收掉之后集合回到基线，再跑一次 diff 不会重复收', () => {
  const baseline = new Set(['DeepSeek Harness', 'Notes']);
  const afterTask = new Set(['DeepSeek Harness', 'Notes', 'Calculator']);
  assert.deepEqual(diffNewlyRunning(baseline, afterTask, TEST_APPS), ['Calculator']);
  const afterCleanup = new Set(afterTask);
  afterCleanup.delete('Calculator');
  assert.deepEqual(diffNewlyRunning(baseline, afterCleanup, TEST_APPS), []);
});

test('组合场景：注入采样器模拟「任务跑完 → 采样 → diff → 收掉」全过程', () => {
  // 用可注入的 isRunning 模拟系统进程表，不碰真实应用（只跑单测，不动屏幕）
  const state = { running: new Set(['DeepSeek Harness', 'Notes']) };
  const isRunning = (name) => state.running.has(name);

  const baseline = sampleRunningApps(TEST_APPS, { isRunning });
  assert.equal(baseline.trusted, true);
  // 采样顺序跟 TEST_APPS 走，不是跟注入集合走
  assert.deepEqual([...baseline.apps].sort(), ['DeepSeek Harness', 'Notes']);

  state.running.add('Calculator');          // 任务偷偷拉起计算器
  state.running.add('Safari');              // 用户自己开了浏览器（不在名单）
  const after = sampleRunningApps(TEST_APPS, { isRunning });
  assert.equal(shouldRunCleanup(baseline.trusted, after).run, true);
  const unexpected = diffNewlyRunning(baseline.apps, after.apps, TEST_APPS);
  assert.deepEqual(unexpected, ['Calculator'], '只收名单内的新增，Safari 不碰');

  state.running.delete('Calculator');       // 清理成功
  const settled = sampleRunningApps(TEST_APPS, { isRunning });
  assert.deepEqual(diffNewlyRunning(baseline.apps, settled.apps, TEST_APPS), []);
});

test('组合场景（P3 已修）：基线采样失败 → 判不可信，调用方不执行收尾', () => {
  // 旧行为：空基线 + 之后采样到 Notes → 把用户自己的 Notes 当成「新增」去退掉。
  const baseline = sampleRunningApps(TEST_APPS, { platform: 'linux' }); // 非 macOS → 空集且不可信
  assert.equal(baseline.apps.size, 0);
  assert.equal(baseline.trusted, false);

  const nowRunning = sampleRunningApps(TEST_APPS, { isRunning: (n) => n === 'Notes' });
  assert.equal(nowRunning.trusted, true);
  // diff 本身看不出区别（这就是为什么需要可信度）……
  assert.deepEqual(diffNewlyRunning(baseline.apps, nowRunning.apps, TEST_APPS), ['Notes']);
  // ……但决策层会拒绝执行，一个应用都不退。
  const decision = shouldRunCleanup(baseline.trusted, nowRunning);
  assert.equal(decision.run, false);
  assert.match(decision.reason, /基线不可信/);
});

test('P3：本次采样不可信时，即使基线可信也不动手', () => {
  const goodBaseline = { apps: new Set(['Notes']), trusted: true, reason: '' };
  const badSample = sampleRunningApps(TEST_APPS, { isRunning: () => { throw new Error('pgrep 挂了'); } });
  assert.equal(badSample.trusted, false);
  const decision = shouldRunCleanup(goodBaseline.trusted, badSample);
  assert.equal(decision.run, false);
  assert.match(decision.reason, /全部探测失败/);
});

test('toNameSet 与 diffNewlyRunning 对奇怪输入保持一致：不抛异常', () => {
  for (const weird of [null, undefined, 0, 42, '', '  ', {}, [], new Set()]) {
    assert.doesNotThrow(() => toNameSet(weird));
    assert.doesNotThrow(() => normalizeAppName(weird));
    assert.doesNotThrow(() => diffNewlyRunning(weird, weird, TEST_APPS));
  }
  assert.deepEqual(diffNewlyRunning(undefined, ['Calculator'], TEST_APPS), ['Calculator']);
});
