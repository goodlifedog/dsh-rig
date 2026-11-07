'use strict';
// 安全边界：注入、端口劫持、pid 复用、预置可执行文件——这四类是真会出事的
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isSafeIdentifier,
  isSafeScriptLiteral,
  parseLsofPid,
  pidMatchesProcess,
  debugPortTrust,
  executableTrust,
} from '../core/safety.mjs';
import { windowCount, dialogs, quitApp } from '../core/background.mjs';
import { attachPage } from '../core/cdp-driver.mjs';
import { ensureHelper } from '../core/applescript-driver.mjs';

test('应用名白名单：常见名字放行，能破坏 AppleScript 的一律拒绝', () => {
  for (const ok of ['Finder', 'Google Chrome', '抖音', 'Keynote Creator Studio', '微信 (WeChat)', 'QQ']) {
    assert.equal(isSafeIdentifier(ok), true, ok + ' 应该放行');
  }
  for (const bad of ['a"b', 'a\\b', 'a\nb', '', '   ', 'x'.repeat(200), 'a;b', 'a\u0000b']) {
    assert.equal(isSafeIdentifier(bad), false, JSON.stringify(bad) + ' 应该拒绝');
  }
});

test('脚本字面量：控制字符/引号/反斜杠都不许进', () => {
  assert.equal(isSafeScriptLiteral('普通文字'), true);
  assert.equal(isSafeScriptLiteral('带"引号"'), false);
  assert.equal(isSafeScriptLiteral('带\\反斜杠'), false);
  assert.equal(isSafeScriptLiteral('带\n换行'), false);
});

test('解析 lsof 输出里的 pid', () => {
  const sample = [
    'COMMAND   PID USER   FD   TYPE   DEVICE SIZE/OFF NODE NAME',
    'node    12345 tester   23u  IPv4 0x123      0t0  TCP 127.0.0.1:9333 (LISTEN)',
  ].join('\n');
  assert.equal(parseLsofPid(sample), 12345);
  assert.equal(parseLsofPid(''), 0);
  assert.equal(parseLsofPid('乱七八糟没有表头'), 0);
});

test('pid 还是不是那个进程：路径形式取 basename 比', () => {
  assert.equal(pidMatchesProcess('/Applications/ChatGPT.app/Contents/MacOS/ChatGPT\n', 'ChatGPT'), true);
  assert.equal(pidMatchesProcess('ChatGPT', 'ChatGPT'), true);
  assert.equal(pidMatchesProcess('/usr/bin/bash', 'ChatGPT'), false);
  assert.equal(pidMatchesProcess('', 'ChatGPT'), false);
});

test('调试端口主人判定：没人监听/不是目标应用都要拒绝', () => {
  assert.equal(debugPortTrust({ ownerPid: 100, appPid: 100 }), 'ok');
  assert.equal(debugPortTrust({ ownerPid: 0, appPid: 100 }), 'no-listener');
  assert.equal(debugPortTrust({ ownerPid: 200, appPid: 100 }), 'mismatch');
  assert.equal(debugPortTrust({ ownerPid: 100, appPid: 0 }), 'unknown-app');
});

test('可执行文件信任：他主/任何人可写都不行', () => {
  assert.equal(executableTrust({ fileUid: 501, uid: 501, mode: 0o755 }), 'ok');
  assert.equal(executableTrust({ fileUid: 0, uid: 501, mode: 0o755 }), 'foreign-owner');
  assert.equal(executableTrust({ fileUid: 501, uid: 501, mode: 0o777 }), 'writable-by-others');
  assert.equal(executableTrust({ exists: false }), 'missing');
});

test('windowCount：名字能注入时不执行脚本，直接返回 -1', async () => {
  let called = 0;
  const n = await windowCount('a"b', {
    deps: { exec: async () => { called += 1; return { stdout: '5' }; } },
    altNames: ['x\\y'],
  });
  assert.equal(n, -1);
  assert.equal(called, 0, '危险名字不该进 osascript');
});

test('dialogs：名字能注入时直接返回空，不执行脚本', async () => {
  const list = await dialogs('a"b');
  assert.deepEqual(list, []);
});

test('quitApp：杀进程前发现 pid 已换人，就不杀', async () => {
  const calls = [];
  const r = await quitApp(
    { appName: 'ChatGPT', processName: 'ChatGPT' },
    {
      graceMs: 10,
      deps: {
        isAppRunning: async () => true,
        sleep: async () => {},
        dialogs: async () => [],
        exec: async (bin, args) => {
          calls.push(bin + ' ' + args.join(' '));
          if (bin.includes('pgrep')) return { stdout: '4242\n' };
          if (bin.includes('/bin/ps')) return { stdout: '/usr/bin/bash\n' };
          return { stdout: '' };
        },
      },
    },
  );
  assert.equal(r.quit, false);
  assert.equal(r.mode, 'pid-mismatch');
  assert.ok(!calls.some((c) => c.includes('-TERM')), 'pid 不是目标进程时绝不能 TERM');
});

test('quitApp：pid 确实是目标进程才 TERM', async () => {
  const calls = [];
  const r = await quitApp(
    { appName: 'ChatGPT', processName: 'ChatGPT' },
    {
      graceMs: 10,
      deps: {
        isAppRunning: (() => { let n = 0; return async () => { n += 1; return n < 3; }; })(),
        sleep: async () => {},
        dialogs: async () => [],
        exec: async (bin, args) => {
          calls.push(bin + ' ' + args.join(' '));
          if (bin.includes('pgrep')) return { stdout: '4242\n' };
          if (bin.includes('/bin/ps')) return { stdout: '/Applications/ChatGPT.app/Contents/MacOS/ChatGPT\n' };
          return { stdout: '' };
        },
      },
    },
  );
  assert.equal(r.quit, true);
  assert.equal(r.mode, 'term');
  assert.ok(calls.some((c) => c.includes('-TERM') && c.includes('4242')));
});

test('attachPage：端口主人不是目标应用时拒绝连接（防本地端口劫持）', async () => {
  let listed = 0;
  const r = await attachPage({
    port: 9333,
    expectedPid: 100,
    portOwner: async () => 999,
    deps: { listTargets: async () => { listed += 1; return []; }, sleep: async () => {} },
  });
  assert.equal(r.ok, false);
  assert.equal(r.trust, 'mismatch');
  assert.equal(listed, 0, '没通过校验就不该去列 target');
});

test('ensureHelper：文件被换成他主的，会重新编译覆盖', async () => {
  const written = [];
  const r = await ensureHelper({
    path: '/fake/bin/ae-permission',
    deps: {
      uid: 501,
      stat: async (p) => (p.endsWith('bin') ? { uid: 501, mode: 0o755 } : { uid: 0, mode: 0o755 }),
      chmod: async () => {},
      fs: {
        constants: { X_OK: 1 },
        promises: {
          mkdir: async () => {},
          writeFile: async (p) => { written.push(p); },
          rename: async () => {},
          rm: async () => {},
        },
      },
      exec: async () => ({}),
    },
  });
  assert.equal(r.ok, true);
  assert.equal(r.trust, 'recompiled');
  assert.ok(written.some((p) => p.endsWith('.c')));
});

test('ensureHelper：缓存目录被别人可写时，拒绝编译（fail closed）', async () => {
  const r = await ensureHelper({
    path: '/fake/bin/ae-permission',
    deps: {
      uid: 501,
      stat: async (p) => {
        if (p.endsWith('bin')) return { uid: 501, mode: 0o777 };
        throw new Error('文件不存在');
      },
      chmod: async () => {},
      fs: { constants: { X_OK: 1 }, promises: { mkdir: async () => {}, writeFile: async () => {}, rename: async () => {}, rm: async () => {} } },
      exec: async () => ({}),
    },
  });
  assert.equal(r.ok, false);
  assert.ok(r.error.includes('目录不可信'));
});
