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
    stopTask: () => ({ stopped: true, task: 'demo' }),
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

test('其余路由：/ /sessions /windows /log /visible /expand /close /frame 都通', async () => {
  const seen = [];
  const { handlers } = stubHandlers({
    sessions: () => [{ id: 'default', visible: false }],
    windows: () => [{ windowId: 1, title: 'demo' }],
    onLog: (session, text) => { seen.push(['log', session, text]); return { text }; },
    onVisible: (session, visible) => { seen.push(['visible', session, visible]); return { visible }; },
    onExpand: (session) => { seen.push(['expand', session]); return { expanded: true }; },
    close: (session) => { seen.push(['close', session]); return session === 'default'; },
    onFrame: (session, dataUrl) => { seen.push(['frame', session, String(dataUrl).slice(0, 22)]); return { ok: true }; },
  });
  const srv = createOverlayServer({ host: '127.0.0.1', port: 0, handlers });
  const addr = await srv.listen();
  const base = 'http://' + addr.address + ':' + addr.port;
  try {
    assert.equal((await get(base, '/')).status, 200);
    const sessions = await get(base, '/sessions');
    assert.equal(sessions.status, 200);
    assert.equal(sessions.json.sessions.length, 1);
    const windows = await get(base, '/windows');
    assert.equal(windows.status, 200);
    assert.equal(windows.json.windows[0].windowId, 1);

    const log = await post(base, '/log', { session: 'alpha', text: '动作' });
    assert.equal(log.status, 200);
    assert.deepEqual(seen[0], ['log', 'alpha', '动作'], 'query/body 里的 session 要透传');

    const visible = await post(base, '/visible', { visible: true });
    assert.equal(visible.status, 200);
    assert.equal((await post(base, '/visible', { visible: 'true' })).status, 400, 'visible 必须是布尔');

    const expand = await post(base, '/expand', {});
    assert.equal(expand.status, 200);
    assert.equal(expand.json.expanded, true);

    const closed = await post(base, '/close', { session: 'default' });
    assert.equal(closed.status, 200);
    const missing = await post(base, '/close', { session: 'nope' });
    assert.equal(missing.status, 404, '不存在的会话 close 要 404');

    const frame = await post(base, '/frame', { dataUrl: 'data:image/png;base64,AAAA' });
    assert.equal(frame.status, 200);
    assert.equal(frame.json.ok, true);

    const wrong = await get(base, '/log');
    assert.equal(wrong.status, 405, '已知路由用了错方法要 405');
  } finally {
    await srv.close();
  }
});

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
    assert.equal(remote.status, 400);
    const svg = await post(base, '/frame', { dataUrl: 'data:image/svg+xml;base64,AAAA' });
    assert.equal(svg.status, 400, 'svg 不放行（可伪装界面）');
    const jsUrl = await post(base, '/frame', { dataUrl: 'javascript:alert(1)' });
    assert.equal(jsUrl.status, 400);
    assert.equal(remote.status, 400, '不能让它去抓外网/本地文件');

    const ok = await post(base, '/frame', { dataUrl: 'data:image/png;base64,AAAA', width: 600, height: 380 });
    assert.equal(ok.status, 200);
  });
});

test('停止任务接口可用，且登记在已知路由里', async () => {
  await withServer(async (base) => {
    const r = await post(base, '/stop-task', { session: 'demo' });
    assert.equal(r.status, 200);
    assert.equal(r.json.stopped, true);

    // GET 走错方法应回 405（说明该路由被登记），而不是 404
    const wrong = await get(base, '/stop-task');
    assert.equal(wrong.status, 405);
  });
});

test('未知接口 404', async () => {
  await withServer(async (base) => {
    const r = await get(base, '/nope');
    assert.equal(r.status, 404);
  });
});
test('安全边界：浏览器来源的请求一律拒绝（防网页读窗口标题/塞图）', async () => {
  await withServer(async (base) => {
    const res = await fetch(base + '/windows', { headers: { Origin: 'https://evil.example' } });
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.ok(body.error.includes('Origin'));
  });
});

test('安全边界：跨域预检直接拒绝', async () => {
  await withServer(async (base) => {
    const res = await fetch(base + '/status', {
      method: 'OPTIONS',
      headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' },
    });
    assert.equal(res.status, 403);
  });
});

test('安全边界：Host 不是本机回环时拒绝（防 DNS rebinding），带对 token 也一样', async () => {
  const http = await import('node:http');
  await withTokenServer(async (base) => {
    const port = new URL(base).port;
    const status = await new Promise((resolve) => {
      const req = http.request({
        host: '127.0.0.1',
        port,
        path: '/health',
        method: 'GET',
        headers: Object.assign({ Host: 'evil.example:' + port }, { 'X-Agent-Token': 'test-token-123' }),
      }, (res) => { res.resume(); resolve(res.statusCode); });
      req.on('error', () => resolve(0));
      req.end();
    });
    assert.equal(status, 403, 'evil.example 的 Host 必须拒绝，哪怕 token 正确');
  });
});

test('安全边界：POST 必须是 JSON，表单式跨站提交进不来', async () => {
  await withServer(async (base) => {
    const res = await fetch(base + '/frame', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ dataUrl: 'data:image/png;base64,AAAA' }),
    });
    assert.equal(res.status, 415);
    const ok = await fetch(base + '/status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: '正常写入' }),
    });
    assert.equal(ok.status, 200, '正常 JSON 客户端不受影响');
  });
});
async function withTokenServer(fn, token = 'test-token-123') {
  const { handlers, calls } = stubHandlers();
  const srv = createOverlayServer({ host: '127.0.0.1', port: 0, handlers, token });
  const addr = await srv.listen();
  const base = 'http://' + addr.address + ':' + addr.port;
  try { await fn(base, calls); } finally { await srv.close(); }
}

test('长文本字段在边界层截断：titleHint 120 / title 200 / frame note 200', async () => {
  const seen = {};
  const { handlers } = stubHandlers({
    onLog: (session, text, titleHint) => { seen.titleHint = titleHint; return { text }; },
    onWindow: (session, raw, title) => { seen.title = title; return String(raw) === '123' ? 123 : null; },
    onFrame: (session, dataUrl, note) => { seen.note = note; return { ok: true }; },
  });
  const srv = createOverlayServer({ host: '127.0.0.1', port: 0, handlers });
  const addr = await srv.listen();
  const base = 'http://' + addr.address + ':' + addr.port;
  try {
    await post(base, '/log', { text: 'x', titleHint: '标'.repeat(5000) });
    assert.ok(seen.titleHint.length <= 120, 'titleHint 应截到 120，实际 ' + seen.titleHint.length);
    await post(base, '/window', { windowId: 123, title: '标'.repeat(5000) });
    assert.ok(seen.title.length <= 200, 'title 应截到 200，实际 ' + seen.title.length);
    await post(base, '/frame', { dataUrl: 'data:image/png;base64,AAAA', note: '标'.repeat(5000) });
    assert.ok(seen.note.length <= 200, 'note 应截到 200，实际 ' + seen.note.length);
    const badTitle = await post(base, '/window', { windowId: 123, title: 123 });
    assert.equal(badTitle.status, 400, 'title 类型不对要 400');
  } finally {
    await srv.close();
  }
});

test('超大请求体给 413，而不是把连接掐成 ECONNRESET', async () => {
  await withTokenServer(async (base) => {
    const res = await fetch(base + '/frame', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Agent-Token': 'test-token-123' },
      body: 'x'.repeat(9 * 1024 * 1024),
    });
    assert.equal(res.status, 413);
  });
});

test('控制面票据：没带 token 的读写都拒绝', async () => {
  await withTokenServer(async (base) => {
    const get = await fetch(base + '/windows');
    assert.equal(get.status, 401);
    const write = await fetch(base + '/status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'x' }),
    });
    assert.equal(write.status, 401);
  });
});

test('控制面票据：带对 token 就正常；错的照样 401', async () => {
  await withTokenServer(async (base) => {
    const ok = await fetch(base + '/windows', { headers: { 'X-Agent-Token': 'test-token-123' } });
    assert.equal(ok.status, 200);
    const wrong = await fetch(base + '/windows', { headers: { 'X-Agent-Token': 'nope' } });
    assert.equal(wrong.status, 401);
  });
});

test('控制面票据：?token= 默认不认，显式开 AGENT_ALLOW_QUERY_TOKEN 才认', async () => {
  await withTokenServer(async (base) => {
    const byDefault = await fetch(base + '/health?token=test-token-123');
    assert.equal(byDefault.status, 401, '查询串会漏进 shell history/日志，默认必须拒绝');
    const prev = process.env.AGENT_ALLOW_QUERY_TOKEN;
    process.env.AGENT_ALLOW_QUERY_TOKEN = '1';
    try {
      const allowed = await fetch(base + '/health?token=test-token-123');
      assert.equal(allowed.status, 200, '明确打开开关后可以用查询串（给不好设 header 的客户端留路）');
    } finally {
      if (prev === undefined) delete process.env.AGENT_ALLOW_QUERY_TOKEN;
      else process.env.AGENT_ALLOW_QUERY_TOKEN = prev;
    }
  });
});
