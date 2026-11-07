'use strict';
// AppleScript 通道：权限状态解析、错误分类、URL 脱敏、授权门禁
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseAeStatus,
  classifyOsascriptError,
  redactUrl,
  ensureHelper,
  checkAutomationPermission,
  runAppScript,
} from '../core/applescript-driver.mjs';

test('权限状态码解析', () => {
  assert.equal(parseAeStatus(0), 'granted');
  assert.equal(parseAeStatus(-1744), 'needs-consent');
  assert.equal(parseAeStatus(-1743), 'denied');
  assert.equal(parseAeStatus(-600), 'app-not-running');
  assert.equal(parseAeStatus(-99999), 'unknown');
  assert.equal(parseAeStatus('0'), 'granted');
});

test('osascript 报错分类', () => {
  assert.equal(classifyOsascriptError('execution error: 不允许发送 Apple 事件 (-1743)'), 'denied');
  assert.equal(classifyOsascriptError('execution error: AppleEvent已超时 (-1712)'), 'timeout');
  assert.equal(classifyOsascriptError('execution error: 不能获得 application "X" (-600)'), 'app-not-running');
  assert.equal(classifyOsascriptError('some other failure'), 'error');
  assert.equal(classifyOsascriptError(''), 'error');
});

test('URL 脱敏：只留协议和域名', () => {
  assert.equal(redactUrl('https://opencode.ai/console/org_abc?x=1'), 'https://opencode.ai/…');
  assert.equal(redactUrl('file:///Users/x/secret.txt'), 'file:///…');
  assert.equal(redactUrl(''), '');
  assert.equal(redactUrl('not a url'), 'not a url');
});

test('ensureHelper：已经有可执行文件就直接用', async () => {
  const r = await ensureHelper({
    path: '/fake/ae-permission',
    deps: {
      fs: { constants: { X_OK: 1 }, promises: { access: async () => {}, mkdir: async () => {}, writeFile: async () => {}, rm: async () => {} } },
      exec: async () => ({}),
    },
  });
  assert.equal(r.ok, true);
  assert.equal(r.path, '/fake/ae-permission');
});

test('ensureHelper：没有就编译一次；编译失败要如实报错', async () => {
  const written = [];
  const r = await ensureHelper({
    path: '/fake/bin/ae-permission',
    deps: {
      fs: {
        constants: { X_OK: 1 },
        promises: {
          access: async () => { throw new Error('缺文件'); },
          mkdir: async () => {},
          writeFile: async (p) => { written.push(p); },
          rm: async () => {},
        },
      },
      exec: async (bin, args) => { assert.ok(bin.includes('clang')); return {}; },
    },
  });
  assert.equal(r.ok, true);
  assert.ok(written[0].endsWith('.c'));
  const failed = await ensureHelper({
    path: '/fake/bin/ae-permission',
    deps: {
      fs: { constants: { X_OK: 1 }, promises: { access: async () => { throw new Error('缺文件'); }, mkdir: async () => {}, writeFile: async () => {}, rm: async () => {} } },
      exec: async () => { throw new Error('没有 clang'); },
    },
  });
  assert.equal(failed.ok, false);
  assert.ok(failed.error.includes('没有 clang'));
});

test('权限查询：按小程序输出解析', async () => {
  const mk = (stdout) => ({
    checkAutomationPermission: null,
    deps: { ensureHelper: async () => ({ ok: true, path: '/x' }), exec: async () => ({ stdout }) },
  });
  const granted = await checkAutomationPermission({ bundleId: 'a.b' }, { deps: mk('0\n').deps });
  assert.equal(granted.status, 'granted');
  const denied = await checkAutomationPermission({ bundleId: 'a.b' }, { deps: mk('-1743\n').deps });
  assert.equal(denied.status, 'denied');
  const broken = await checkAutomationPermission({ bundleId: 'a.b' }, { deps: { ensureHelper: async () => ({ ok: true, path: '/x' }), exec: async () => { throw new Error('boom'); } } });
  assert.equal(broken.status, 'unknown');
});

test('未授权时不发送 Apple 事件（这是防弹窗的关键）', async () => {
  let calls = 0;
  const r = await runAppScript({
    appName: 'Safari',
    bundleId: 'com.apple.Safari',
    script: 'tell application "Safari" to get name',
    deps: {
      checkAutomationPermission: async () => ({ status: 'needs-consent' }),
      exec: async () => { calls += 1; return { stdout: '' }; },
    },
  });
  assert.equal(r.ok, false);
  assert.equal(r.status, 'needs-consent');
  assert.equal(calls, 0, '没授权就不许发 Apple 事件');
});

test('已授权时执行脚本并把输出带回来', async () => {
  const r = await runAppScript({
    appName: 'Finder',
    bundleId: 'com.apple.finder',
    script: 'tell application "Finder" to get name of home',
    deps: {
      checkAutomationPermission: async () => ({ status: 'granted' }),
      exec: async (bin) => { assert.ok(bin.includes('osascript'), '要用 osascript 执行'); return { stdout: 'tester\n' }; },
    },
  });
  assert.equal(r.ok, true);
  assert.equal(r.output, 'tester');
});

test('执行超时要标成 timeout，不能当成功', async () => {
  const err = new Error('Command failed');
  err.stderr = 'execution error: AppleEvent已超时 (-1712)';
  const r = await runAppScript({
    appName: 'Notes',
    bundleId: 'com.apple.Notes',
    script: 'tell application "Notes" to count notes',
    deps: {
      checkAutomationPermission: async () => ({ status: 'granted' }),
      exec: async () => { throw err; },
    },
  });
  assert.equal(r.ok, false);
  assert.equal(r.status, 'timeout');
});

test('没给 bundleId 时不做授权检查（自己人调用/测试用）', async () => {
  let checked = 0;
  const r = await runAppScript({
    appName: 'Finder',
    script: 'get name',
    deps: {
      checkAutomationPermission: async () => { checked += 1; return { status: 'denied' }; },
      exec: async () => ({ stdout: 'ok' }),
    },
  });
  assert.equal(r.ok, true);
  assert.equal(checked, 0);
});
