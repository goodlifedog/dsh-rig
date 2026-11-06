'use strict';

/**
 * 不依赖 Electron 的接口层自检（多会话版）：
 * 起一个临时端口的 overlay HTTP 服务，逐条断言 /health /sessions /log /status /window /visible
 * /expand /frame /close 以及 session 参数、错误分支。
 * 运行：npm run smoke
 */

const assert = require('node:assert/strict');
const { createOverlayServer, normalizeSession, DEFAULT_SESSION } = require('./server.js');
const { normalizeWindowId, resolveWindowId } = require('./window-id.js');

function checkWindowIdHelpers() {
  assert.equal(normalizeWindowId(68544), 68544);
  assert.equal(normalizeWindowId('68544'), 68544);
  assert.equal(normalizeWindowId('  1234  '), 1234);
  assert.equal(normalizeWindowId('window:68544:0'), 68544);
  assert.equal(normalizeWindowId('window:68544'), 68544);
  assert.equal(normalizeWindowId(0), null);
  assert.equal(normalizeWindowId(-3), null);
  assert.equal(normalizeWindowId('abc'), null);
  assert.equal(normalizeWindowId(''), null);
  assert.equal(normalizeWindowId(null), null);
  assert.equal(normalizeWindowId(3.14), null);

  assert.equal(resolveWindowId([], { OVERLAY_WINDOW_ID: 'window:42:0' }), 42);
  assert.equal(resolveWindowId(['electron', '.'], { WINDOW_ID: '43' }), 43);
  assert.equal(resolveWindowId(['electron', '.', '--window-id=777'], {}), 777);
  assert.equal(resolveWindowId(['electron', '.', '--window-id', '888'], {}), 888);
  assert.equal(resolveWindowId(['electron', '.', '999'], {}), 999);
  // 环境变量优先于命令行
  assert.equal(resolveWindowId(['--window-id=111'], { OVERLAY_WINDOW_ID: '222' }), 222);
  assert.equal(resolveWindowId(['electron', '.', '--port=7788'], {}), null);

  console.log('PASS window-id helpers');
}

function checkSessionHelpers() {
  assert.equal(normalizeSession(undefined), DEFAULT_SESSION);
  assert.equal(normalizeSession(null), DEFAULT_SESSION);
  assert.equal(normalizeSession(''), DEFAULT_SESSION);
  assert.equal(normalizeSession('   '), DEFAULT_SESSION);
  assert.equal(normalizeSession('alpha'), 'alpha');
  assert.equal(normalizeSession('  session-1.2_3  '), 'session-1.2_3');
  assert.equal(normalizeSession('abc-123_XY.Z'), 'abc-123_XY.Z');
  assert.throws(() => normalizeSession('a b'), /1–64/);
  assert.throws(() => normalizeSession('a/b'), /1–64/);
  assert.throws(() => normalizeSession('x'.repeat(65)), /1–64/);
  assert.throws(() => normalizeSession(42), /字符串/);

  console.log('PASS session helpers');
}

async function checkHttpServer() {
  const received = {
    logs: new Map(),
    statuses: new Map(),
    visible: new Map(),
    frames: [],
    closed: [],
  };

  const listOf = (map, key) => {
    if (!map.has(key)) map.set(key, []);
    return map.get(key);
  };

  const server = createOverlayServer({
    host: '127.0.0.1',
    port: 0,
    handlers: {
      onLog: (session, text, titleHint) => {
        const entry = { id: listOf(received.logs, session).length + 1, ts: Date.now(), text: text, kind: 'action', session: session };
        listOf(received.logs, session).push(entry);
        received.lastLogHint = titleHint;
        return entry;
      },
      onStatus: (session, text, state, titleHint) => {
        listOf(received.statuses, session).push(text);
        received.lastStatus = { session: session, text: text };
        received.lastStatusHint = titleHint;
        return { text: text, activity: state || 'running' };
      },
      onWindow: (session, raw) => normalizeWindowId(raw),
      onVisible: (session, visible) => {
        received.visible.set(session, visible);
        return { visible: visible, pinned: visible };
      },
      onExpand: (session) => ({ expanded: true, session: session }),
      onFrame: (session, dataUrl, note, cursor, width, height) => {
        received.frames.push({ session: session, bytes: dataUrl.length, note: note, cursor: cursor, width: width, height: height });
      },
      close: (session) => {
        received.closed.push(session);
        return session === 'beta';
      },
      sessions: () => [
        { session: 'default', visible: true },
        { session: 'alpha', visible: false },
      ],
      health: (session) => ({
        session: session,
        exists: session !== 'missing',
        status: (received.statuses.get(session) || [null]).slice(-1)[0],
        activity: 'idle',
        visible: received.visible.get(session) !== false,
        idleMs: 5000,
        pinned: Boolean(received.visible.get(session)),
        logs: (received.logs.get(session) || []).length,
      }),
      windows: async () => [{ windowId: 68544, title: 'demo window' }],
    },
  });

  const address = await server.listen();
  const base = 'http://127.0.0.1:' + address.port;

  const get = async (path) => {
    const response = await fetch(base + path);
    return { status: response.status, body: await response.json() };
  };
  const post = async (path, payload) => {
    const response = await fetch(base + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return { status: response.status, body: await response.json() };
  };

  try {
    // 向后兼容：不带 session = default
    let result = await get('/health');
    assert.equal(result.status, 200);
    assert.equal(result.body.ok, true);
    assert.equal(result.body.session, 'default');
    assert.equal(result.body.exists, true);

    result = await post('/log', { text: '点击搜索框' });
    assert.equal(result.status, 200);
    assert.equal(result.body.session, 'default');
    assert.equal(result.body.entry.text, '点击搜索框');
    assert.equal(listOf(received.logs, 'default').length, 1);

    result = await post('/status', { text: '正在筛选职位' });
    assert.equal(result.status, 200);
    assert.equal(result.body.text, '正在筛选职位');
    assert.equal(result.body.activity, 'running');
    assert.equal(result.body.session, 'default');

    result = await post('/status', { text: '读取失败', state: 'error' });
    assert.equal(result.status, 200);
    assert.equal(result.body.activity, 'error');

    result = await post('/status', { text: '待命', state: 'idle' });
    assert.equal(result.status, 200);
    assert.equal(result.body.activity, 'idle');

    // 两个会话互不影响
    result = await post('/status', { session: 'alpha', text: 'A：正在点按钮' });
    assert.equal(result.status, 200);
    assert.equal(result.body.session, 'alpha');
    assert.equal(received.lastStatus.session, 'alpha');

    result = await post('/log', { session: 'alpha', text: 'A 的动作' });
    assert.equal(result.status, 200);
    assert.equal(result.body.session, 'alpha');

    result = await get('/health?session=alpha');
    assert.equal(result.body.session, 'alpha');
    assert.equal(result.body.status, 'A：正在点按钮');
    assert.equal(result.body.logs, 1);

    result = await get('/health?session=default');
    assert.equal(result.body.status, '待命');
    assert.equal(result.body.logs, 1);

    // POST 用查询参数指定 session 也可以
    result = await post('/log?session=gamma', { text: '来自查询参数' });
    assert.equal(result.status, 200);
    assert.equal(result.body.session, 'gamma');
    assert.equal(listOf(received.logs, 'gamma').length, 1);

    // titleHint 透传给 handler；非法类型 400
    result = await post('/status', { session: 'alpha', text: '带标题提示', titleHint: '规划布局探讨' });
    assert.equal(result.status, 200);
    assert.equal(received.lastStatusHint, '规划布局探讨');
    result = await post('/log', { session: 'alpha', text: '日志带标题提示', titleHint: '规划布局探讨' });
    assert.equal(result.status, 200);
    assert.equal(received.lastLogHint, '规划布局探讨');
    result = await post('/status', { session: 'alpha', text: 'x', titleHint: 123 });
    assert.equal(result.status, 400);
    result = await post('/log', { session: 'alpha', text: 'x', titleHint: {} });
    assert.equal(result.status, 400);
    result = await post('/status', { session: 'alpha', text: '带空标题', titleHint: '' });
    assert.equal(result.status, 200);
    assert.equal(received.lastStatusHint, '');

    // 非法 session
    result = await post('/log', { session: 'bad id', text: 'x' });
    assert.equal(result.status, 400);
    result = await get('/health?session=a%2Fb');
    assert.equal(result.status, 400);
    result = await post('/log', { session: 123, text: 'x' });
    assert.equal(result.status, 400);

    // /sessions
    result = await get('/sessions');
    assert.equal(result.status, 200);
    assert.equal(result.body.count, 2);
    assert.equal(result.body.sessions[0].session, 'default');

    // 不存在的会话：health 明确 exists:false，不报错
    result = await get('/health?session=missing');
    assert.equal(result.status, 200);
    assert.equal(result.body.exists, false);

    // /close
    result = await post('/close', { session: 'alpha' });
    assert.equal(result.status, 404);
    result = await post('/close', { session: 'beta' });
    assert.equal(result.status, 200);
    assert.equal(result.body.closed, true);
    assert.deepEqual(received.closed, ['alpha', 'beta']);

    // /expand
    result = await post('/expand', { session: 'alpha' });
    assert.equal(result.status, 200);
    assert.equal(result.body.expanded, true);
    assert.equal(result.body.session, 'alpha');

    // /frame（2MB 以内的大 dataURL 也要能过）
    const bigFrame = 'data:image/png;base64,' + 'A'.repeat(200000);
    result = await post('/frame', { session: 'alpha', dataUrl: bigFrame, cursor: { x: 1, y: 2 }, width: 1280, height: 800 });
    assert.equal(result.status, 200);
    assert.equal(result.body.session, 'alpha');
    assert.equal(result.body.width, 1280);
    assert.equal(result.body.height, 800);
    assert.equal(received.frames.length, 1);
    assert.equal(received.frames[0].session, 'alpha');
    assert.equal(received.frames[0].width, 1280);
    assert.equal(received.frames[0].height, 800);
    assert.deepEqual(received.frames[0].cursor, { x: 1, y: 2 });

    result = await post('/frame', { session: 'alpha', dataUrl: bigFrame, width: 0, height: 10 });
    assert.equal(result.status, 400);
    result = await post('/frame', { session: 'alpha', dataUrl: bigFrame, width: 'x' });
    assert.equal(result.status, 400);

    result = await post('/frame', { session: 'alpha', dataUrl: 'not-an-image' });
    assert.equal(result.status, 400);

    // /visible 按会话
    result = await post('/visible', { session: 'alpha', visible: false });
    assert.equal(result.status, 200);
    assert.equal(result.body.session, 'alpha');
    assert.equal(received.visible.get('alpha'), false);
    result = await get('/health?session=alpha');
    assert.equal(result.body.visible, false);
    result = await post('/visible', { session: 'alpha', visible: 'yes' });
    assert.equal(result.status, 400);

    // /window 全局窗口列表 + 按会话绑定
    result = await post('/window', { windowId: 'window:68544:0' });
    assert.equal(result.status, 200);
    assert.equal(result.body.windowId, 68544);
    assert.equal(result.body.session, 'default');

    result = await post('/window', { session: 'alpha', windowId: 'not-a-window' });
    assert.equal(result.status, 400);

    result = await post('/log', {});
    assert.equal(result.status, 400);

    result = await post('/status', { text: '   ' });
    assert.equal(result.status, 400);

    result = await get('/windows');
    assert.equal(result.status, 200);
    assert.equal(result.body.windows.length, 1);
    assert.equal(result.body.windows[0].windowId, 68544);

    result = await get('/log');
    assert.equal(result.status, 405);

    result = await get('/nope');
    assert.equal(result.status, 404);

    result = await get('/');
    assert.equal(result.status, 200);
    assert.ok(Array.isArray(result.body.endpoints));
    assert.ok(result.body.endpoints.includes('GET /sessions'));

    console.log('PASS http server (multi-session)');
  } finally {
    await server.close();
  }
}

async function main() {
  checkWindowIdHelpers();
  checkSessionHelpers();
  await checkHttpServer();
  console.log('ALL PASS');
}

main().catch((error) => {
  console.error('FAIL', error);
  process.exitCode = 1;
});