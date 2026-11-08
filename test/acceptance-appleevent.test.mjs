'use strict';
// acceptance 的 AppleEvent 入口：预检授权后行为不变 / 未授权跳过 / unknown 仍尝试。
// 全部注入假 exec 与假 preflight，**不 spawn osascript、不发真实 AppleEvent**。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createAppleEventOps,
  noteAppleEventWarning,
  appleEventWarnings,
  appleEventWarningSection,
} from '../core/acceptance.mjs';

const OLD = {
  activateHost: 'tell application "System Events" to set frontmost of first process whose bundle identifier is "com.deepseek.dsh" to true',
  restoreBundle: (bundle) => 'tell application "System Events" to set frontmost of first process whose bundle identifier is ' + JSON.stringify(bundle) + ' to true',
  frontmostApp: 'tell application "System Events" to get name of first process whose frontmost is true',
  frontmostBundle: 'tell application "System Events" to get bundle identifier of first process whose frontmost is true',
  restoreUserFront: (name) => 'tell application "System Events" to set frontmost of first process whose name is ' + JSON.stringify(name) + ' to true',
};

const granted = async () => ({ allowed: true, status: 'granted' });
const denied = async () => ({ allowed: false, status: 'denied', warning: '自动化未授权（denied），已跳过该 AppleEvent' });
const unknown = async () => ({ allowed: true, status: 'unknown' });
const pickyExec = () => {
  const calls = [];
  const exec = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const script = args.join(' ');
    if (script.includes('get name of first process whose frontmost')) return 'Calculator\n';
    if (script.includes('get bundle identifier of first process whose frontmost')) return 'com.apple.calculator\n';
    return '';
  };
  return { calls, exec };
};

test('已授权：五个 AppleEvent 入口的 osascript 参数/超时与旧实现逐字一致', async () => {
  const { calls, exec } = pickyExec();
  const warnings = [];
  const ops = createAppleEventOps({ exec, platform: 'darwin', preflight: granted, onWarning: (w) => warnings.push(w) });

  assert.equal(await ops.activateHost(), true);
  assert.deepEqual(calls[0], { cmd: '/usr/bin/osascript', args: ['-e', OLD.activateHost], opts: { timeout: 5000 } });

  assert.equal(await ops.restoreBundle('com.apple.Safari'), undefined);
  assert.deepEqual(calls[1], { cmd: '/usr/bin/osascript', args: ['-e', OLD.restoreBundle('com.apple.Safari')], opts: { timeout: 5000 } });

  assert.equal(await ops.frontmostApp(), 'Calculator');
  assert.deepEqual(calls[2], { cmd: '/usr/bin/osascript', args: ['-e', OLD.frontmostApp], opts: { encoding: 'utf8', timeout: 4000 } });

  assert.equal(await ops.frontmostBundle(), 'com.apple.calculator');
  assert.deepEqual(calls[3], { cmd: '/usr/bin/osascript', args: ['-e', OLD.frontmostBundle], opts: { encoding: 'utf8', timeout: 3000 } });

  assert.equal(await ops.restoreUserFront('DeepSeek Harness'), true);
  assert.deepEqual(calls[4], { cmd: '/usr/bin/osascript', args: ['-e', OLD.frontmostApp], opts: { encoding: 'utf8', timeout: 4000 } });
  assert.deepEqual(calls[5], { cmd: '/usr/bin/osascript', args: ['-e', OLD.restoreUserFront('DeepSeek Harness')], opts: { timeout: 5000 } });
  assert.deepEqual(warnings, [], '已授权时不应产生任何 warning');
});

test('未授权：五个入口都跳过 AppleEvent，返回安全兜底并记 warning', async () => {
  const { calls, exec } = pickyExec();
  const warnings = [];
  const ops = createAppleEventOps({ exec, platform: 'darwin', preflight: denied, onWarning: (w) => warnings.push(w) });

  assert.equal(await ops.activateHost(), false);
  assert.equal(await ops.restoreBundle('com.apple.Safari'), undefined);
  assert.equal(await ops.frontmostApp(), '');
  assert.equal(await ops.frontmostBundle(), null);
  assert.equal(await ops.restoreUserFront('DeepSeek Harness'), false);
  assert.equal(calls.length, 0, '未授权时一条 osascript 都不许发');
  assert.ok(warnings.length >= 1);
  assert.ok(warnings.every((w) => /未授权/.test(w)));
});

test('预检 unknown / 抛错：仍然发 AppleEvent（探测抖动不能让还原失效）', async () => {
  const { calls, exec } = pickyExec();
  const opsUnknown = createAppleEventOps({ exec, platform: 'darwin', preflight: unknown });
  assert.equal(await opsUnknown.activateHost(), true);
  assert.equal(calls.length, 1);

  const { calls: calls2, exec: exec2 } = pickyExec();
  const opsThrow = createAppleEventOps({
    exec: exec2,
    platform: 'darwin',
    preflight: async () => { throw new Error('probe boom'); },
  });
  assert.equal(await opsThrow.activateHost(), true);
  assert.equal(calls2.length, 1, '预检自己抛错也要继续尝试');
});

test('非 macOS：Linux 平台不发 AppleEvent，返回原兜底', async () => {
  const { calls, exec } = pickyExec();
  const ops = createAppleEventOps({ exec, platform: 'linux', preflight: granted });
  assert.equal(await ops.activateHost(), false);
  assert.equal(await ops.restoreBundle('com.apple.Safari'), undefined);
  assert.equal(await ops.frontmostBundle(), null);
  assert.equal(calls.length, 0);
});

test('未授权 warning 会写进验收报告小节（去重）', () => {
  const before = appleEventWarnings().length;
  noteAppleEventWarning('激活宿主：自动化未授权（denied），已跳过该 AppleEvent');
  noteAppleEventWarning('激活宿主：自动化未授权（denied），已跳过该 AppleEvent');
  const warnings = appleEventWarnings();
  assert.equal(warnings.length, before + 1, '同一条 warning 只记一次');
  const section = appleEventWarningSection();
  assert.ok(section.includes('## 自动化授权告警'));
  assert.ok(section.some((line) => /未授权/.test(line)));
});
