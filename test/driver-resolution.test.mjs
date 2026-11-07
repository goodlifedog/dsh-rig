'use strict';
// 通道协商：按运行时默认链 + 每条通道的前提，排出实际可用顺序
import test from 'node:test';
import assert from 'node:assert/strict';
import { choosePlan, driverLabel, negotiateChannels } from '../core/driver-resolution.mjs';

test('choosePlan：保留默认顺序，跳过不可用的并记原因', () => {
  const r = choosePlan(['ax', 'cdp', 'visual'], { ax: true, cdp: false, visual: true });
  assert.deepEqual(r.plan, ['ax', 'visual']);
  assert.equal(r.skipped.length, 1);
  assert.equal(r.skipped[0].driver, 'cdp');
});

test('choosePlan：一条都不通时返回空计划并给原因，不返回 null', () => {
  const r = choosePlan(['ax', 'visual'], { ax: false, visual: false });
  assert.deepEqual(r.plan, []);
  assert.ok(r.reason.includes('所有通道'));
});

test('choosePlan：默认链为空时退回 ax → visual', () => {
  const r = choosePlan([], { ax: true, visual: true });
  assert.deepEqual(r.plan, ['ax', 'visual']);
});

test('driverLabel：认识的给中文，不认识的返回原名', () => {
  assert.ok(driverLabel('ax').includes('Accessibility'));
  assert.equal(driverLabel('unknown-driver'), 'unknown-driver');
});

function fakeDeps(overrides = {}) {
  return Object.assign({
    isRunning: async () => true,
    readSafe: async () => ({ text: 'x'.repeat(200) }),
    windowCount: async () => 1,
    probeCdp: async () => ({ ok: false, error: 'refused' }),
    sdefCommands: async () => 0,
    automationPermission: async () => ({ status: 'needs-consent' }),
    debugPortFor: () => 9333,
    overlayWindows: async () => 1,
  }, overrides);
}

test('协商：原生应用有树、有字典、有窗口 → ax → applescript → 画面', async () => {
  const r = await negotiateChannels(
    { appName: 'Finder', bundleId: 'com.apple.finder', runtime: 'native' },
    { deps: fakeDeps({ sdefCommands: async () => 25, automationPermission: async () => ({ status: 'granted' }) }) },
  );
  assert.equal(r.usable, true);
  assert.deepEqual(r.plan, ['ax', 'applescript', 'visual']);
  assert.equal(r.channels.find((c) => c.driver === 'cdp').available, false);
});

test('协商：Electron 应用 + CDP 端口开着 → ax → cdp → 画面', async () => {
  const r = await negotiateChannels(
    { appName: 'ChatGPT', bundleId: 'com.openai.codex', runtime: 'electron' },
    { deps: fakeDeps({ probeCdp: async () => ({ ok: true }) }) },
  );
  assert.deepEqual(r.plan, ['ax', 'cdp', 'visual']);
});

test('协商：界面树是空的 → 只剩画面通道', async () => {
  const r = await negotiateChannels(
    { appName: 'Keynote Creator Studio', bundleId: 'com.apple.Keynote', runtime: 'native' },
    { deps: fakeDeps({ readSafe: async () => ({ text: '' }), windowCount: async () => 0, overlayWindows: async () => 1 }) },
  );
  assert.deepEqual(r.plan, ['visual']);
  assert.ok(r.channels.find((c) => c.driver === 'ax').reason.includes('为空'));
});

test('协商：应用没运行 → 一条都用不了，并写清原因', async () => {
  const r = await negotiateChannels(
    { appName: 'Steam', bundleId: 'com.valvesoftware.steam', runtime: 'native' },
    { deps: fakeDeps({ isRunning: async () => false, overlayWindows: async () => 0 }) },
  );
  assert.equal(r.usable, false);
  assert.ok(r.channels.filter((c) => !c.available).every((c) => c.reason.length > 0));
});

test('协商：没授权 AppleScript 时不会把这条通道排进计划', async () => {
  const r = await negotiateChannels(
    { appName: 'Safari', bundleId: 'com.apple.Safari', runtime: 'native' },
    { deps: fakeDeps({ sdefCommands: async () => 10, automationPermission: async () => ({ status: 'needs-consent' }) }) },
  );
  assert.ok(!r.plan.includes('applescript'));
  assert.ok(r.channels.find((c) => c.driver === 'applescript').reason.includes('needs-consent'));
});

test('协商：probeAx=false 时跳过 AX 探测（避免不必要地读前台应用）', async () => {
  let read = 0;
  const r = await negotiateChannels(
    { appName: 'X', bundleId: 'x.y', runtime: 'native' },
    { probeAx: false, deps: fakeDeps({ readSafe: async () => { read += 1; return { text: 'x'.repeat(200) }; } }) },
  );
  assert.equal(read, 0);
  assert.ok(!r.plan.includes('ax'));
});

test('协商结果里四条通道都要出现，方便排障时看清为什么没走', async () => {
  const r = await negotiateChannels(
    { appName: 'Finder', bundleId: 'com.apple.finder', runtime: 'native' },
    { deps: fakeDeps() },
  );
  const drivers = r.channels.map((c) => c.driver).sort();
  assert.deepEqual(drivers, ['applescript', 'ax', 'cdp', 'visual']);
});
