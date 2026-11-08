'use strict';
// P1 回归 + 新功能：background.mjs 的「可选运行门禁」。
// 全程只用注入的假 isAppRunning / 假 mcp / 假 frontName，绝不碰真实应用（不启动、不读取）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  state,
  find,
  click,
  setValue,
  typeText,
  readSafe,
  findSafe,
  NOT_RUNNING_REASON,
} from '../core/background.mjs';

function fakeMcp(calls) {
  return {
    async callTool(tool, args) {
      calls.push({ tool, args });
      return {
        text: 'FAKE_TREE',
        json: { matches: [{ index: 7, title: 'OK' }] },
        isError: false,
      };
    },
  };
}

function trackProbe(running) {
  const calls = [];
  const probe = async (target) => {
    calls.push(target);
    return running;
  };
  probe.calls = calls;
  return probe;
}

test('state：requireRunning=true 且未运行 → skipped，不调用 mcp', async () => {
  const mcpCalls = [];
  const probe = trackProbe(false);
  const result = await state('Ghostty', {
    requireRunning: true,
    deps: { mcp: async () => fakeMcp(mcpCalls), isAppRunning: probe },
  });
  assert.equal(result.skipped, 'not-running');
  assert.equal(result.running, false);
  assert.equal(result.reason, NOT_RUNNING_REASON);
  assert.match(result.reason, /没在运行/);
  assert.equal(result.text, '');
  assert.equal(mcpCalls.length, 0, '未运行不应进入底层 mcp');
  // 探测参数由 core/app-presence.mjs 的 probeArgsForApp 决定（显示名可能被解析成 bundle/进程名），
  // 这里只断言"确实按应用名探测了、且带了可用于精确判定的字段"，不锁死具体字段组合。
  assert.equal(probe.calls.length, 1);
  assert.equal(probe.calls[0].appName, 'Ghostty');
  assert.ok(probe.calls[0].processName || probe.calls[0].bundleId, '应带进程名或 bundle id');
});

test('state：requireRunning=true 且在运行 → 正常读界面树', async () => {
  const mcpCalls = [];
  const probe = trackProbe(true);
  const result = await state('Ghostty', {
    requireRunning: true,
    deps: { mcp: async () => fakeMcp(mcpCalls), isAppRunning: probe },
  });
  assert.equal(result, 'FAKE_TREE');
  assert.equal(mcpCalls.length, 1);
  assert.equal(mcpCalls[0].tool, 'get_app_state');
  assert.equal(mcpCalls[0].args.app, 'Ghostty');
});

test('state：不传 requireRunning 时行为不变（未运行也不拦、不探测）', async () => {
  const mcpCalls = [];
  const probe = trackProbe(false);
  const result = await state('Ghostty', {
    deps: { mcp: async () => fakeMcp(mcpCalls), isAppRunning: probe },
  });
  assert.equal(result, 'FAKE_TREE');
  assert.equal(mcpCalls.length, 1);
  assert.equal(probe.calls.length, 0, '默认路径不应触发运行探测');
});

test('find：requireRunning=true 未运行 → skipped 且不调用 query；默认路径仍返回数组', async () => {
  const mcpCalls = [];
  const screened = await find('Ghostty', {
    role: 'AXTextArea',
    requireRunning: true,
    deps: { mcp: async () => fakeMcp(mcpCalls), isAppRunning: trackProbe(false) },
  });
  assert.equal(screened.skipped, 'not-running');
  assert.deepEqual(screened.matches, []);
  assert.equal(mcpCalls.length, 0);

  const normal = await find('Ghostty', {
    role: 'AXTextArea',
    deps: { mcp: async () => fakeMcp(mcpCalls), isAppRunning: trackProbe(false) },
  });
  assert.deepEqual(normal, [{ index: 7, title: 'OK' }]);
  assert.equal(mcpCalls.length, 1);
  assert.equal(mcpCalls[0].tool, 'query');
});

test('click / setValue / typeText：requireRunning=true 未运行 → skipped 且不调用 mcp；默认路径保持原结构', async () => {
  const cases = [
    ['click', () => click('Calculator', 3, { requireRunning: true, deps: { mcp: async () => fakeMcp(mcpCalls), isAppRunning: trackProbe(false) } })],
    ['setValue', () => setValue('Calculator', 3, 'x', { requireRunning: true, deps: { mcp: async () => fakeMcp(mcpCalls), isAppRunning: trackProbe(false) } })],
    ['typeText', () => typeText('Calculator', '7', { requireRunning: true, deps: { mcp: async () => fakeMcp(mcpCalls), isAppRunning: trackProbe(false) } })],
  ];
  const mcpCalls = [];
  for (const [name, run] of cases) {
    const result = await run();
    assert.equal(result.ok, false, name + ' 未运行应 ok:false');
    assert.equal(result.skipped, 'not-running', name + ' 应标记 skipped');
    assert.equal(result.running, false);
    assert.equal(result.reason, NOT_RUNNING_REASON);
    assert.equal(result.frontUnchanged, true, name + ' 没动作，前台当然没变');
  }
  assert.equal(mcpCalls.length, 0, '三个入口都不该调用 mcp');

  // 默认路径：行为与历史一致（会调用 mcp 并返回原有结构）
  const normalMcp = [];
  const deps = { mcp: async () => fakeMcp(normalMcp), frontName: async () => 'Front', isAppRunning: trackProbe(false) };
  const normalClick = await click('Calculator', 3, { deps });
  assert.equal(normalClick.ok, true);
  assert.equal(normalClick.front, 'Front');
  assert.equal(normalClick.frontUnchanged, true);
  assert.equal(normalMcp[0].tool, 'click');
  const normalType = await typeText('Calculator', '7', { deps });
  assert.equal(normalType.ok, true);
  assert.equal(normalMcp[1].tool, 'type_text');
  const normalSet = await setValue('Calculator', 3, 'x', { deps });
  assert.equal(normalSet.ok, true);
  assert.equal(normalMcp[2].tool, 'set_value');
});

test('readSafe：requireRunning=true 未运行 → skipped，不进入 state；默认路径行为不变', async () => {
  let stateCalls = 0;
  let frontCalls = 0;
  const baseDeps = () => ({
    frontName: async () => { frontCalls += 1; return 'Front'; },
    state: async () => { stateCalls += 1; return 'SAFE_TREE'; },
    restoreFront: async () => {},
  });
  const screened = await readSafe('Ghostty', {
    risk: false,
    restore: false,
    requireRunning: true,
    deps: Object.assign(baseDeps(), { isAppRunning: trackProbe(false) }),
  });
  assert.equal(screened.skipped, 'not-running');
  assert.equal(screened.running, false);
  assert.equal(screened.text, '');
  assert.equal(screened.reason, NOT_RUNNING_REASON);
  assert.equal(stateCalls, 0, '未运行不应调用 state');
  assert.equal(frontCalls, 0, '门禁应发生在读前台之前');

  const normal = await readSafe('Ghostty', {
    risk: false,
    restore: false,
    deps: Object.assign(baseDeps(), { isAppRunning: trackProbe(false) }),
  });
  assert.equal(normal.text, 'SAFE_TREE');
  assert.equal(normal.skipped, undefined, '默认路径不应带 skipped 标记');
  assert.equal(stateCalls, 1);
});

test('findSafe：requireRunning=true 未运行 → skipped，不进入 find；默认路径行为不变', async () => {
  let findCalls = 0;
  const baseDeps = () => ({
    frontName: async () => 'Front',
    find: async () => { findCalls += 1; return [{ index: 1 }]; },
    restoreFront: async () => {},
  });
  const screened = await findSafe('Ghostty', { role: 'AXButton' }, {
    risk: false,
    restore: false,
    requireRunning: true,
    deps: Object.assign(baseDeps(), { isAppRunning: trackProbe(false) }),
  });
  assert.equal(screened.skipped, 'not-running');
  assert.deepEqual(screened.matches, []);
  assert.equal(findCalls, 0);

  const normal = await findSafe('Ghostty', { role: 'AXButton' }, {
    risk: false,
    restore: false,
    deps: Object.assign(baseDeps(), { isAppRunning: trackProbe(false) }),
  });
  assert.deepEqual(normal.matches, [{ index: 1 }]);
  assert.equal(normal.skipped, undefined);
  assert.equal(findCalls, 1);
});

test('运行门禁支持显式 appName/processName/bundleId', async () => {
  const probe = trackProbe(false);
  await state('ignored', {
    requireRunning: true,
    appName: 'Calculator',
    processName: 'Calculator',
    bundleId: 'com.apple.calculator',
    deps: { mcp: async () => fakeMcp([]), isAppRunning: probe },
  });
  assert.deepEqual(probe.calls, [{ bundleId: 'com.apple.calculator', appName: 'Calculator', processName: 'Calculator' }]);
});

test('isAppRunning 抛错时按未运行处理（宁可跳过，不冒进）', async () => {
  const mcpCalls = [];
  const result = await state('Ghostty', {
    requireRunning: true,
    deps: {
      mcp: async () => fakeMcp(mcpCalls),
      isAppRunning: async () => { throw new Error('probe failed'); },
    },
  });
  assert.equal(result.skipped, 'not-running');
  assert.equal(result.running, false);
  assert.equal(mcpCalls.length, 0);
});
