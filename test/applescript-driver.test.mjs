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
  classifySafariJsError,
  checkSafariJavaScript,
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
      uid: 501,
      stat: async () => ({ uid: 501, mode: 0o755 }),
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
      uid: 501,
      stat: async (p) => {
        if (p.endsWith('/bin')) return { uid: 501, mode: 0o755 };
        throw new Error('缺文件');
      },
      chmod: async () => {},
      fs: {
        constants: { X_OK: 1 },
        promises: {
          access: async () => { throw new Error('缺文件'); },
          mkdir: async () => {},
          writeFile: async (p) => { written.push(p); },
          rename: async () => {},
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
      uid: 501,
      stat: async (p) => {
        if (p.endsWith('/bin')) return { uid: 501, mode: 0o755 };
        throw new Error('缺文件');
      },
      chmod: async () => {},
      fs: { constants: { X_OK: 1 }, promises: { access: async () => { throw new Error('缺文件'); }, mkdir: async () => {}, writeFile: async () => {}, rename: async () => {}, rm: async () => {} } },
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
test('Safari JS 通道错误分类：设置没开要说清楚，不能笼统报错', () => {
  assert.equal(classifySafariJsError("You must enable 'Allow JavaScript from Apple Events' in the Developer section of Safari Settings"), 'disabled');
  assert.equal(classifySafariJsError('execution error: Safari got an error: document does not contain a JavaScript context'), 'no-document');
  assert.equal(classifySafariJsError('execution error: 不能获得 application "Safari" (-600)'), 'not-running');
  assert.equal(classifySafariJsError('execution error: 不允许发送 Apple 事件 (-1743)'), 'denied');
  assert.equal(classifySafariJsError('weird'), 'error');
});

test('Safari JS 通道探测：可用时返回结果，不可用时带分类', async () => {
  const ok = await checkSafariJavaScript({ running: true, permission: 'granted', exec: async () => ({ stdout: '2\n' }) });
  assert.equal(ok.available, true);
  assert.equal(ok.result, '2');

  const err = new Error('Command failed');
  err.stderr = "You must enable 'Allow JavaScript from Apple Events' in the Developer section of Safari Settings";
  const disabled = await checkSafariJavaScript({ running: true, permission: 'granted', exec: async () => { throw err; } });
  assert.equal(disabled.available, false);
  assert.equal(disabled.reason, 'disabled');
  assert.ok(/Apple Events/.test(disabled.detail));
});

test('Safari JS 探针：Safari 没在运行 → not-running 跳过，绝不执行 osascript（H3）', async () => {
  const probes = [];
  let execCalls = 0;
  const r = await checkSafariJavaScript({
    deps: {
      isAppRunning: async (app) => { probes.push(app); return false; },
      checkAutomationPermission: async () => { throw new Error('不该查授权'); },
      exec: async () => { execCalls += 1; return { stdout: '2' }; },
    },
  });
  assert.equal(r.available, false);
  assert.equal(r.reason, 'not-running');
  assert.equal(r.skipped, true);
  assert.equal(r.running, false);
  assert.equal(execCalls, 0, 'Safari 没在运行就不许发 AppleEvent（tell 会启动它）');
  assert.deepEqual(probes, [{ appName: 'Safari', bundleId: 'com.apple.Safari' }]);
});

test('Safari JS 探针：未授权 → not-authorized 跳过，绝不执行 osascript（H3）', async () => {
  let execCalls = 0;
  const r = await checkSafariJavaScript({
    deps: {
      isAppRunning: async () => true,
      checkAutomationPermission: async () => ({ status: 'needs-consent', code: -1744 }),
      exec: async () => { execCalls += 1; return { stdout: '2' }; },
    },
  });
  assert.equal(r.available, false);
  assert.equal(r.reason, 'not-authorized');
  assert.equal(r.skipped, true);
  assert.equal(r.permission, 'needs-consent');
  assert.equal(execCalls, 0, '没授权就不许发 AppleEvent（会弹 TCC 授权框）');
  assert.match(r.message, /自动化/);
  assert.match(r.message, /隐私与安全性/);
});

test('Safari JS 探针：已运行且已授权才执行 osascript', async () => {
  let execCalls = 0;
  const r = await checkSafariJavaScript({
    deps: {
      isAppRunning: async () => true,
      checkAutomationPermission: async () => ({ status: 'granted', code: 0 }),
      exec: async (bin, args) => {
        execCalls += 1;
        assert.ok(bin.includes('osascript'));
        assert.ok(args.join(' ').includes('Safari'));
        return { stdout: '2\n' };
      },
    },
  });
  assert.equal(r.available, true);
  assert.equal(r.result, '2');
  assert.equal(execCalls, 1);
});

test('Safari JS 探针：运行探测抛错时按未运行处理（不冒进）', async () => {
  let execCalls = 0;
  const r = await checkSafariJavaScript({
    deps: {
      isAppRunning: async () => { throw new Error('probe failed'); },
      exec: async () => { execCalls += 1; return { stdout: '2' }; },
    },
  });
  assert.equal(r.available, false);
  assert.equal(r.reason, 'not-running');
  assert.equal(execCalls, 0);
});
