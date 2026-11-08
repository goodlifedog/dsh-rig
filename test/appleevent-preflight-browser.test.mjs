'use strict';
// H2：browser.mjs / headless-demo.mjs 的 AppleEvent 入口先静默预检自动化授权。
// 全部用注入假探测/假 exec，绝不发真实 AppleEvent、不启动 Chrome。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  decideAutomationAllow as decideBrowserAllow,
  checkFrontQueryAutomation,
  queryFrontBundle,
} from '../core/browser.mjs';
import {
  decideAutomationAllow as decideDemoAllow,
  preflightSystemEvents,
  queryFrontPid,
  queryWindowCount,
} from '../core/tasks/headless-demo.mjs';

// 与旧实现完全一致的脚本/参数（granted 时必须一字不差）
const FRONT_BUNDLE_SCRIPT = 'tell application "System Events" to get bundle identifier of first process whose frontmost is true';
const FRONT_PID_SCRIPT = 'tell application "System Events" to get unix id of first process whose frontmost is true';
const windowScript = (pid) => 'tell application "System Events" to count windows of (first process whose unix id is ' + pid + ')';

const fakeCheck = (resultOrThrow) => async () => {
  if (resultOrThrow instanceof Error) throw resultOrThrow;
  return resultOrThrow;
};

// ---------- 纯函数：授权状态 → 允许/跳过 ----------

test('H2 授权判定：granted/unknown 允许尝试，denied/needs-consent 才跳过', () => {
  for (const decide of [decideBrowserAllow, decideDemoAllow]) {
    assert.equal(decide('granted').allow, true);
    assert.equal(decide('unknown').allow, true, '探测没结论按未知处理，仍要尝试');
    assert.equal(decide('app-not-running').allow, true);
    assert.equal(decide('timeout').allow, true);
    assert.equal(decide('').allow, true);
    for (const status of ['denied', 'needs-consent']) {
      const r = decide(status);
      assert.equal(r.allow, false, status);
      assert.equal(r.skipped, true, status);
      assert.match(r.reason, /未授权自动化/, status);
    }
  }
});

// ---------- 静默预检：granted/denied/unknown/抛错 四种 ----------

test('H2 checkFrontQueryAutomation：granted 放行、denied 跳过、unknown 仍尝试、抛错按未知仍尝试', async () => {
  assert.equal((await checkFrontQueryAutomation({ deps: { checkAutomationPermission: fakeCheck({ status: 'granted' }) } })).allow, true);
  assert.equal((await checkFrontQueryAutomation({ deps: { checkAutomationPermission: fakeCheck({ status: 'denied' }) } })).allow, false);
  const unknown = await checkFrontQueryAutomation({ deps: { checkAutomationPermission: fakeCheck({ status: 'unknown' }) } });
  assert.equal(unknown.allow, true);
  assert.equal(unknown.status, 'unknown');
  const thrown = await checkFrontQueryAutomation({ deps: { checkAutomationPermission: fakeCheck(new Error('probe boom')) } });
  assert.equal(thrown.allow, true, '探测抛错不能拦住原逻辑');
  assert.equal(thrown.status, 'unknown');
});

test('H2 preflightSystemEvents：denied 跳过、unknown/抛错仍尝试', async () => {
  assert.equal((await preflightSystemEvents({ deps: { checkAutomationPermission: fakeCheck({ status: 'denied' }) } })).skipped, true);
  assert.equal((await preflightSystemEvents({ deps: { checkAutomationPermission: fakeCheck({ status: 'unknown' }) } })).allow, true);
  assert.equal((await preflightSystemEvents({ deps: { checkAutomationPermission: fakeCheck(new Error('x')) } })).allow, true);
});

// ---------- browser.mjs：denied 时 0 次 osascript；granted 时参数与旧实现一致 ----------

test('H2 browser.queryFrontBundle：denied 时根本不发 AppleEvent（0 次 exec），返回结构化 skipped', () => {
  let calls = 0;
  const r = queryFrontBundle({
    gate: { allow: false, skipped: true, status: 'denied', reason: '未授权自动化' },
    deps: { execFileSync: () => { calls += 1; return 'com.apple.Safari'; } },
  });
  assert.equal(calls, 0, '未授权绝不能调 osascript（会弹授权框）');
  assert.equal(r.ok, false);
  assert.equal(r.skipped, true);
  assert.match(r.reason, /未授权自动化/);
});

test('H2 browser.queryFrontBundle：granted 时 osascript 参数与旧实现一致', () => {
  const calls = [];
  const r = queryFrontBundle({
    gate: { allow: true, skipped: false, status: 'granted', reason: '' },
    deps: { execFileSync: (cmd, args, opts) => { calls.push({ cmd, args, opts }); return ' com.apple.Safari\n'; } },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'osascript');
  assert.deepEqual(calls[0].args, ['-e', FRONT_BUNDLE_SCRIPT], '脚本必须与旧实现一字不差');
  assert.equal(calls[0].opts.encoding, 'utf8');
  assert.equal(r.ok, true);
  assert.equal(r.bundleId, 'com.apple.Safari');
});

test('H2 browser.queryFrontBundle：unknown（探测没结论）仍然尝试；传了 timeoutMs 时参数带 timeout', () => {
  let calls = 0;
  const r = queryFrontBundle({
    gate: { allow: true, skipped: false, status: 'unknown', reason: '' },
    timeoutMs: 4000,
    deps: { execFileSync: (cmd, args, opts) => { calls += 1; assert.equal(opts.timeout, 4000); return 'com.google.Chrome'; } },
  });
  assert.equal(calls, 1);
  assert.equal(r.bundleId, 'com.google.Chrome');
});

test('H2 browser.queryFrontBundle：exec 抛错时安全返回空，不当成跳过', () => {
  const r = queryFrontBundle({
    gate: { allow: true, skipped: false, status: 'granted', reason: '' },
    deps: { execFileSync: () => { throw new Error('osascript failed'); } },
  });
  assert.equal(r.ok, false);
  assert.equal(r.skipped, false);
  assert.equal(r.bundleId, '');
});

// ---------- headless-demo：前置预检 + 前台 pid / 窗口数降级 ----------

test('H2 headless.queryFrontPid：denied 时 0 次 osascript；granted 时参数与旧实现一致', () => {
  let deniedCalls = 0;
  const denied = queryFrontPid({
    gate: { allow: false, skipped: true, status: 'denied', reason: 'x' },
    deps: { execFileSync: () => { deniedCalls += 1; return '1'; } },
  });
  assert.equal(deniedCalls, 0);
  assert.equal(denied.ok, false);
  assert.equal(denied.skipped, true);

  const calls = [];
  const granted = queryFrontPid({
    gate: { allow: true, skipped: false, status: 'granted', reason: '' },
    deps: { execFileSync: (cmd, args, opts) => { calls.push({ cmd, args, opts }); return '4321'; } },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'osascript');
  assert.deepEqual(calls[0].args, ['-e', FRONT_PID_SCRIPT]);
  assert.equal(calls[0].opts.encoding, 'utf8');
  assert.equal(calls[0].opts.timeout, 10000);
  assert.equal(granted.pid, 4321);
});

test('H2 headless.queryWindowCount：denied 时返回安全兜底 null + warning，且不发 AppleEvent', () => {
  let calls = 0;
  const warnings = [];
  const r = queryWindowCount(1234, {
    gate: { allow: false, skipped: true, status: 'denied', reason: 'x' },
    deps: { execFileSync: () => { calls += 1; return '0'; } },
    warn: (text) => warnings.push(text),
  });
  assert.equal(calls, 0, '未授权不能发 AppleEvent');
  assert.equal(r, null, '窗口数降级为安全兜底值 null');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /未授权自动化/);
});

test('H2 headless.queryWindowCount：granted 时参数与旧实现一致并解析数字', () => {
  const calls = [];
  const r = queryWindowCount(999, {
    gate: { allow: true, skipped: false, status: 'granted', reason: '' },
    deps: { execFileSync: (cmd, args, opts) => { calls.push({ cmd, args, opts }); return '0\n'; } },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'osascript');
  assert.deepEqual(calls[0].args, ['-e', windowScript(999)]);
  assert.equal(calls[0].opts.encoding, 'utf8');
  assert.equal(calls[0].opts.timeout, 10000);
  assert.equal(r, 0);
});
