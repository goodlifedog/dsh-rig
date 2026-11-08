'use strict';
// CDP 通道：端口分配、target 挑选、连上后的读/点/写，纯逻辑与假 client 单测
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  debugPortFor,
  buildLaunchArgs,
  scorePageTarget,
  pickPageTarget,
  rankPageTargets,
  launchWithDebug,
  attachPage,
  verifyDebugPortOwner,
  sameExecutablePath,
  readPage,
  clickText,
  typeInto,
} from '../core/cdp-driver.mjs';

test('调试端口：同一个应用稳定、落在 9330-9389', () => {
  const a = debugPortFor('com.openai.codex');
  const b = debugPortFor('com.openai.codex');
  assert.equal(a, b);
  assert.ok(a >= 9330 && a < 9390, '端口越界：' + a);
  assert.notEqual(debugPortFor('com.other.app'), undefined);
});

test('启动参数就是 Chromium 认的那一个开关', () => {
  assert.deepEqual(buildLaunchArgs(9340), ['--remote-debugging-port=9340']);
});

test('页面打分：主界面高于 detached 空窗口，https 高于 app://', () => {
  const index = scorePageTarget({ url: 'app://-/index.html', title: 'ChatGPT' });
  const detached = scorePageTarget({ url: 'app://-/detached-window.html?initialRoute=%2F', title: 'ChatGPT' });
  assert.ok(index > detached, 'index 应该比 detached 分高');
  const web = scorePageTarget({ url: 'https://example.com/', title: 'Example' });
  assert.ok(web > index);
});

test('页面打分：match 命中直接压过其它规则', () => {
  const hit = scorePageTarget({ url: 'https://want.example/', title: 'x' }, { match: /want/ });
  const other = scorePageTarget({ url: 'https://example.com/', title: 'y' });
  assert.ok(hit > other);
});

test('挑页面：只认 page 类型且带 ws 地址的', () => {
  const targets = [
    { type: 'service_worker', url: 'chrome-extension://x', webSocketDebuggerUrl: 'ws://a' },
    { type: 'page', url: 'https://a/', title: 'A', webSocketDebuggerUrl: 'ws://b' },
    { type: 'page', url: 'app://-/detached-window.html', title: 'B', webSocketDebuggerUrl: 'ws://c' },
  ];
  const picked = pickPageTarget(targets);
  assert.equal(picked.url, 'https://a/');
  assert.equal(pickPageTarget([]), null);
  assert.equal(rankPageTargets(targets).length, 2);
});

test('launchWithDebug：open 带对参数，端口起来就返回', async () => {
  const calls = [];
  let probeCount = 0;
  const r = await launchWithDebug({ bundle: 'a.b', name: 'AppX' }, {
    port: 9333,
    waitMs: 2000,
    deps: {
      exec: async (bin, args) => { calls.push([bin, ...args].join(' ')); return { stdout: '' }; },
      probe: async () => { probeCount += 1; return probeCount >= 2 ? { ok: true, version: { Browser: 'Chrome/1' } } : { ok: false, error: 'refused' }; },
      sleep: async () => {},
      findPid: async () => 4242,
      portOwner: async () => 4242,
    },
  });
  assert.equal(r.ok, true);
  assert.equal(r.port, 9333);
  assert.equal(r.appPid, 4242, 'launch 要带出应用 pid，后面 attach 才有得比');
  assert.equal(r.trust, 'ok');
  assert.ok(calls[0].includes('/usr/bin/open'));
  assert.ok(calls[0].includes('--remote-debugging-port=9333'));
});

test('launchWithDebug：端口被别的进程占住（固定端口哈希会撞）→ 拒绝，不返回成功', async () => {
  const r = await launchWithDebug({ bundle: 'a.b', name: 'AppX' }, {
    port: 9333,
    waitMs: 1000,
    deps: {
      exec: async () => ({ stdout: '' }),
      probe: async () => ({ ok: true, version: { Browser: 'Chrome/1' } }),
      sleep: async () => {},
      findPid: async () => 4242,
      portOwner: async () => 9999,   // 冒充 CDP 的本地进程
    },
  });
  assert.equal(r.ok, false, '端口主人不是目标应用时必须失败');
  assert.equal(r.trust, 'mismatch');
  assert.ok(r.error.includes('校验未通过'));
});

test('launchWithDebug：查不到应用 pid 且没给可执行路径 → fail-closed，不按名字放行', async () => {
  const r = await launchWithDebug({ bundle: 'a.b', name: 'AppX' }, {
    port: 9333,
    waitMs: 1000,
    deps: {
      exec: async () => ({ stdout: '' }),
      probe: async () => ({ ok: true, version: { Browser: 'Chrome/1' } }),
      sleep: async () => {},
      findPid: async () => 0,
      portOwner: async () => 7777,
    },
  });
  assert.equal(r.ok, false, '没有 pid 时不能仅凭名字/路径包含就放行');
  assert.equal(r.trust, 'unverified');
  assert.ok(r.error.includes('expectedPid'), '错误里要告诉调用方补 expectedPid：' + r.error);
});

test('launchWithDebug：没有 pid 但显式给可执行路径时，严格整串相等才放行', async () => {
  const exe = '/Applications/AppX.app/Contents/MacOS/AppX';
  const baseDeps = {
    exec: async (cmd) => (cmd === '/bin/ps' ? { stdout: exe } : { stdout: '' }),
    probe: async () => ({ ok: true, version: { Browser: 'Chrome/1' } }),
    sleep: async () => {},
    findPid: async () => 0,
    portOwner: async () => 7777,
  };
  const bad = await launchWithDebug({ bundle: 'a.b', name: 'AppX', exePath: '/Applications/Other.app/Contents/MacOS/Other' },
    { port: 9333, waitMs: 1000, deps: baseDeps });
  assert.equal(bad.ok, false);
  assert.equal(bad.trust, 'path-mismatch');

  const good = await launchWithDebug({ bundle: 'a.b', name: 'AppX', exePath: exe },
    { port: 9333, waitMs: 1000, deps: baseDeps });
  assert.equal(good.ok, true);
  assert.equal(good.trust, 'path-exact');
  assert.equal(good.appPid, 0);
});

test('sameExecutablePath：只认整串相等，子串/前缀不放行', () => {
  const exe = '/Applications/AppX.app/Contents/MacOS/AppX';
  assert.equal(sameExecutablePath('/tmp/AppX', exe), false, '子串路径不能放行');
  assert.equal(sameExecutablePath('/Applications/AppX.app', exe), false, '前缀不能放行');
  assert.equal(sameExecutablePath(exe + '/', exe), true, '尾部斜杠归一化后相等');
  assert.equal(sameExecutablePath('', exe), false);
});

test('verifyDebugPortOwner：没有 expectedPid → unverified，argv 长得像目标应用也不放行', async () => {
  const r = await verifyDebugPortOwner({
    port: 9333,
    app: { appName: 'AppX', bundleId: 'a.b', processName: 'AppX' },
    portOwner: async () => 7001,
    deps: { exec: async () => ({ stdout: '/tmp/AppX' }) },
  });
  assert.equal(r.ok, false);
  assert.equal(r.trust, 'unverified');
  assert.ok(r.reason.includes('expectedPid'), '原因里要提示传 expectedPid：' + r.reason);
  assert.equal(r.command, undefined, '没有可执行路径判据时不该去信 ps 的路径');
});

test('verifyDebugPortOwner：expectedPid 相等才放行，不等/没监听都拒绝', async () => {
  const ok = await verifyDebugPortOwner({ port: 9333, expectedPid: 4242, portOwner: async () => 4242 });
  assert.equal(ok.ok, true);
  assert.equal(ok.trust, 'ok');

  const mismatch = await verifyDebugPortOwner({ port: 9333, expectedPid: 4242, portOwner: async () => 9999 });
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.trust, 'mismatch');
  assert.ok(mismatch.reason.includes('不一致'));

  const none = await verifyDebugPortOwner({ port: 9333, expectedPid: 4242, portOwner: async () => 0 });
  assert.equal(none.ok, false);
  assert.equal(none.trust, 'no-listener');
});

test('verifyDebugPortOwner：没有 pid 时只有整串可执行路径相等才放行', async () => {
  const exe = '/Applications/AppX.app/Contents/MacOS/AppX';
  const hit = await verifyDebugPortOwner({
    port: 9333,
    expectedExecutable: exe,
    portOwner: async () => 7001,
    deps: { exec: async (cmd) => ({ stdout: cmd === '/bin/ps' ? exe : '' }) },
  });
  assert.equal(hit.ok, true);
  assert.equal(hit.trust, 'path-exact');

  const near = await verifyDebugPortOwner({
    port: 9333,
    expectedExecutable: exe,
    portOwner: async () => 7001,
    deps: { exec: async () => ({ stdout: '/tmp/AppX' }) },
  });
  assert.equal(near.ok, false);
  assert.equal(near.trust, 'path-mismatch');
});

test('attachPage：没给 expectedPid/expectedExecutable → fail-closed，不去列 target', async () => {
  let listed = 0;
  const r = await attachPage({
    port: 9333,
    portOwner: async () => 7001,
    deps: {
      listTargets: async () => { listed += 1; return []; },
      sleep: async () => {},
    },
  });
  assert.equal(r.ok, false);
  assert.equal(r.trust, 'unverified');
  assert.equal(listed, 0, '校验没过就不该去列 target');
});

test('attachPage：expectedPid 对不上端口主人 → 拒绝连接', async () => {
  const r = await attachPage({
    port: 9333,
    expectedPid: 4242,
    timeoutMs: 300,
    deps: {
      portOwner: async () => 9999,
      listTargets: async () => { throw new Error('不该连上'); },
    },
  });
  assert.equal(r.ok, false);
  assert.equal(r.trust, 'mismatch');
});

test('launchWithDebug：端口一直不来要如实失败', async () => {
  const r = await launchWithDebug({ bundle: 'a.b', name: 'AppX' }, {
    port: 9333,
    waitMs: 0,
    deps: { exec: async () => ({}), probe: async () => ({ ok: false, error: 'refused' }), sleep: async () => {} },
  });
  assert.equal(r.ok, false);
  assert.ok(r.error.includes('refused'));
});

test('attachPage：跳过连上就断的空窗口，换下一个', async () => {
  let attempts = 0;
  const r = await attachPage({
    port: 9333,
    timeoutMs: 2000,
    expectedPid: 4242,
    deps: {
      portOwner: async () => 4242,
      listTargets: async () => [
        { type: 'page', id: 'a', url: 'app://-/detached-window.html', webSocketDebuggerUrl: 'ws://a' },
        { type: 'page', id: 'b', url: 'app://-/index.html', webSocketDebuggerUrl: 'ws://b' },
      ],
      attach: async ({ target }) => {
        attempts += 1;
        return {
          // 分高的那个（b = index.html）先试，它断了才轮到 detached 窗口
          evaluate: async () => { if (target === 'b') throw new Error('连接已关闭'); return 'complete'; },
          close: () => {},
        };
      },
      sleep: async () => {},
    },
  });
  assert.equal(r.ok, true);
  assert.equal(attempts, 2, '第一个窗口失败后要试第二个');
});

test('readPage：页面还没渲染时等一等，不要读个空就算', async () => {
  let calls = 0;
  const cdp = {
    evaluate: async () => {
      calls += 1;
      if (calls < 3) return { title: 'A', url: 'https://a/', ready: 'loading', text: '' };
      return { title: 'A', url: 'https://a/', ready: 'complete', text: '正文来了' };
    },
  };
  const page = await readPage(cdp, { timeoutMs: 1000, sleep: async () => {} });
  assert.equal(page.text, '正文来了');
  assert.equal(calls, 3);
});

test('clickText：把页面里点到了什么原样带回来', async () => {
  const cdp = { evaluate: async () => ({ clicked: true, matched: '提交', count: 1 }) };
  const r = await clickText(cdp, '提交');
  assert.equal(r.clicked, true);
  assert.equal(r.matched, '提交');
});

test('typeInto：聚焦成功才插字，并读回校验', async () => {
  const sent = [];
  const cdp = {
    evaluate: async (expr) => {
      if (expr.includes('document.activeElement')) return '后台写入';
      return { ok: true, tag: 'input' };
    },
    insertText: async (text) => { sent.push(text); },
    send: async () => ({}),
  };
  const r = await typeInto(cdp, { selector: '#name', text: '后台写入' });
  assert.equal(r.typed, true);
  assert.deepEqual(sent, ['后台写入']);
  assert.equal(r.verified, '后台写入');
});

test('typeInto：找不到输入框就如实说没写成', async () => {
  const cdp = { evaluate: async () => ({ ok: false, tag: '' }), insertText: async () => {} };
  const r = await typeInto(cdp, { selector: '#nope', text: 'x' });
  assert.equal(r.typed, false);
});
