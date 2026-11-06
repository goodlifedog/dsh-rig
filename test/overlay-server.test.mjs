'use strict';
// 小窗 HTTP 接口的回归测试：最近修的几个 bug 都在这层（解绑被拒、状态清不掉、尺寸接口漏登记）
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createOverlayServer } = require('../overlay/server.js');

function stubHandlers(overrides = {}) {
  const calls = [];
  const base = {
    onLog: (session, text) => { calls.push(['log', session, text]); return { text }; },
    onStatus: (session, text, state) => { calls.push(['status', session, text, state]); return { text: text || '待命', activity: state || 'idle' }; },
    onWindow: (session, raw) => {
      calls.push(['window', session, raw]);
      if (raw === null || raw === '') return null;                 // 解绑
      if (String(raw) === '123') return 123;                        // 合法
      return null;                                                  // 非法
    },
    onVisible: (session, visible) => ({ visible }),
    onExpand: () => ({ expanded: true }),
    onFrame: () => ({ ok: true }),
    close: () => true,
    health: (session) => ({ session, exists: true, pid: 1 }),
    sessions: () => [],
    frameTarget: () => ({ width: 600, height: 380, expanded: false }),
    windows: () => [],
  };
  return { handlers: { ...base, ...overrides }, calls };
}

async function withServer(fn, overrides) {
  const { handlers, calls } = stubHandlers(overrides);
  const srv = createOverlayServer({ host: '127.0.0.1', port: 0, handlers });
  const addr = await srv.listen();
  const base = 'http://' + addr.address + ':' + addr.port;
  try {
    await fn(base, calls);
  } finally {
    await srv.close();
  }
}

const post = (base, path, body) => fetch(base + path, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body || {}),
}).then(async (r) => ({ status: r.status, json: await r.json() }));
const get = (base, path) => fetch(base + path).then(async (r) => ({ status: r.status, json: await r.json() }));

test('状态接口：普通写入、空文字拒绝、clear 复位', async () => {
  await withServer(async (base) => {
    const ok = await post(base, '/status', { text: '后台任务：x' });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.text, '后台任务：x');

    const empty = await post(base, '/status', { text: '   ' });
    assert.equal(empty.status, 400);

    const cleared = await post(base, '/status', { clear: true });
    assert.equal(cleared.status, 200);
    assert.equal(cleared.json.text, '待命');
    assert.equal(cleared.json.activity, 'idle');
  });
});

test('窗口接口：null 是解绑，非法值仍是 400，缺字段也要 400', async () => {
  await withServer(async (base) => {
    const unbound = await post(base, '/window', { windowId: null });
    assert.equal(unbound.status, 200);
    assert.equal(unbound.json.unbound, true);
    assert.equal(unbound.json.windowId, null);

    const invalid = await post(base, '/window', { windowId: 'abc' });
    assert.equal(invalid.status, 400);

    const missing = await post(base, '/window', {});
    assert.equal(missing.status, 400);

    const ok = await post(base, '/window', { windowId: 123 });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.windowId, 123);
  });
});

test('推帧尺寸接口可用，且错误方法返回 405 而不是 404', async () => {
  await withServer(async (base) => {
    const target = await get(base, '/frame-target?session=demo');
    assert.equal(target.status, 200);
    assert.equal(target.json.width, 600);
    assert.equal(target.json.height, 380);

    const wrongMethod = await post(base, '/frame-target', {});
    assert.equal(wrongMethod.status, 405);
  });
});

test('会话字段做了白名单校验', async () => {
  await withServer(async (base) => {
    const bad = await post(base, '/status', { session: '../etc/passwd', text: 'x' });
    assert.equal(bad.status, 400);
    const good = await post(base, '/status', { session: 'lead-01', text: 'x' });
    assert.equal(good.status, 200);
  });
});

test('推帧只接受 data:image/ 开头，挡住外部 URL', async () => {
  await withServer(async (base) => {
    const missing = await post(base, '/frame', {});
    assert.equal(missing.status, 400);

    const remote = await post(base, '/frame', { dataUrl: 'https://example.com/a.jpg' });
    assert.equal(remote.status, 400, '不能让它去抓外网/本地文件');

    const ok = await post(base, '/frame', { dataUrl: 'data:image/png;base64,AAAA', width: 600, height: 380 });
    assert.equal(ok.status, 200);
  });
});

test('未知接口 404', async () => {
  await withServer(async (base) => {
    const r = await get(base, '/nope');
    assert.equal(r.status, 404);
  });
});
