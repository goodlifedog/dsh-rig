'use strict';

/**
 * overlay 的本地 HTTP 接口，零依赖（只用 node:http）。
 *
 * 多会话：每个请求都可以带 session（请求体里的 session 字段，或 ?session= 查询参数），
 * 缺省为 "default"，保持旧客户端（不带 session）完全兼容。
 *
 * 路由：
 *   GET  /health?session=x   某个会话的状态快照（会话不存在时返回 exists:false，不会创建窗口）
 *   GET  /sessions           当前所有会话的摘要
 *   GET  /windows            可截图的窗口列表（由主进程通过 desktopCapturer 提供，全局共用）
 *   POST /log      { session, text, titleHint }      追加一条动作日志（titleHint=会话标题提示）
 *   POST /status   { session, text, state, titleHint } 更新状态胶囊（titleHint=会话标题提示）
 *   POST /window   { session, windowId }             切换该会话的缩略图目标窗口
 *   POST /visible  { session, visible }              手动显示/隐藏该会话浮窗（true 时固定显示）
 *   POST /expand   { session }                       切换该会话的放大（4:3）
 *   POST /frame    { session, dataUrl, note, cursor } 外部推送画面
 *   POST /close    { session }                       关掉某个会话的窗口（不影响其它会话）
 */

const http = require('node:http');

// 外部推帧是 base64 dataURL，单帧通常 50–200KB，给足空间
// headless/CDP 截图可能是较大的 PNG/JPEG，给到 8MB
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const MAX_TEXT_CHARS = 1000;
const MAX_STATUS_CHARS = 300;
const DEFAULT_SESSION = 'default';
const SESSION_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function json(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  }, CORS_HEADERS));
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;

    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(httpError(413, '请求体超过 ' + MAX_BODY_BYTES + ' 字节'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', (error) => reject(httpError(400, '读取请求体失败：' + error.message)));
  });
}

async function readJsonBody(req) {
  const raw = (await readBody(req)).trim();
  if (!raw) return {};

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw httpError(400, '请求体不是合法 JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw httpError(400, '请求体必须是 JSON 对象');
  }
  return parsed;
}

// /frame 可选的画面像素尺寸（有它就不用主进程解析图片头）
function readDimension(value, field) {
  if (value === undefined || value === null) return undefined;
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0 || number > 10000) {
    throw httpError(400, field + ' 必须是 1–10000 的整数');
  }
  return number;
}

function requireText(value, field, maxChars) {
  if (typeof value !== 'string') throw httpError(400, field + ' 必须是字符串');
  const text = value.replace(/\s+/g, ' ').trim();
  if (!text) throw httpError(400, field + ' 不能为空');
  return text.length > maxChars ? text.slice(0, maxChars) + '…' : text;
}

// session 只允许 1–64 位安全字符，避免被当成路径/日志注入
function normalizeSession(raw) {
  if (raw === undefined || raw === null) return DEFAULT_SESSION;
  if (typeof raw !== 'string') throw httpError(400, 'session 必须是字符串');
  const id = raw.trim();
  if (!id) return DEFAULT_SESSION;
  if (!SESSION_PATTERN.test(id)) {
    throw httpError(400, 'session 只能是 1–64 位字母/数字/点/下划线/连字符');
  }
  return id;
}

// 优先级：请求体 session > 请求体 sessionId > 查询参数 session > default
// titleHint：会话标题提示，用来判断当前 DSH 前台会话是不是它自己的（见 main.js 的标题门控）
function readTitleHint(body) {
  if (!body || body.titleHint === undefined) return undefined;
  if (typeof body.titleHint !== 'string') throw httpError(400, 'titleHint 必须是字符串');
  return body.titleHint;
}

function sessionFrom(url, body) {
  if (body && body.session !== undefined) return normalizeSession(body.session);
  if (body && body.sessionId !== undefined) return normalizeSession(body.sessionId);
  if (url && url.searchParams.has('session')) return normalizeSession(url.searchParams.get('session'));
  return DEFAULT_SESSION;
}

function createOverlayServer(options) {
  const opts = options || {};
  const host = opts.host || '127.0.0.1';
  const port = opts.port === undefined ? 7788 : opts.port;
  const handlers = opts.handlers || {};

  async function route(req, res) {
    const url = new URL(req.url || '/', 'http://' + (req.headers.host || '127.0.0.1'));
    const pathname = url.pathname.replace(/\/+$/, '') || '/';
    const method = req.method || 'GET';

    if (method === 'OPTIONS') {
      res.writeHead(204, CORS_HEADERS);
      res.end();
      return;
    }

    if (pathname === '/' && method === 'GET') {
      return json(res, 200, {
        ok: true,
        service: 'desktop-agent-overlay',
        sessions: true,
        endpoints: [
          'GET /health?session=',
          'GET /sessions',
          'GET /windows',
          'POST /log',
          'POST /status',
          'POST /window',
          'POST /visible',
          'POST /expand',
          'POST /frame',
          'POST /close',
        ],
      });
    }

    if (pathname === '/health' && method === 'GET') {
      const session = sessionFrom(url, null);
      const health = typeof handlers.health === 'function' ? await handlers.health(session) : {};
      return json(res, 200, Object.assign({ ok: true }, health));
    }

    // 推帧方按这个尺寸出图：小窗收起时只要 ~600px，放大时才要 1920px，
    // 避免一直推 2560px 的图（解码内存和局域传输都白费）
    if (pathname === '/frame-target' && method === 'GET') {
      if (typeof handlers.frameTarget !== 'function') {
        return json(res, 501, { ok: false, error: '推帧尺寸接口未启用' });
      }
      const session = sessionFrom(url, null);
      const target = await handlers.frameTarget(session);
      return json(res, 200, Object.assign({ ok: true }, target));
    }

    if (pathname === '/sessions' && method === 'GET') {
      if (typeof handlers.sessions !== 'function') {
        return json(res, 501, { ok: false, error: '会话列表接口未启用' });
      }
      const sessions = await handlers.sessions();
      return json(res, 200, { ok: true, count: sessions ? sessions.length : 0, sessions: sessions || [] });
    }

    if (pathname === '/windows' && method === 'GET') {
      if (typeof handlers.windows !== 'function') {
        return json(res, 501, { ok: false, error: '当前环境不支持窗口列表' });
      }
      const windows = await handlers.windows();
      return json(res, 200, { ok: true, windows: windows || [] });
    }

    if (pathname === '/log' && method === 'POST') {
      if (typeof handlers.onLog !== 'function') {
        return json(res, 501, { ok: false, error: '日志接口未启用' });
      }
      const body = await readJsonBody(req);
      const session = sessionFrom(url, body);
      const text = requireText(body.text, 'text', MAX_TEXT_CHARS);
      const titleHint = readTitleHint(body);
      const entry = await handlers.onLog(session, text, titleHint);
      return json(res, 200, { ok: true, session: session, entry: entry || { text: text } });
    }

    if (pathname === '/status' && method === 'POST') {
      if (typeof handlers.onStatus !== 'function') {
        return json(res, 501, { ok: false, error: '状态接口未启用' });
      }
      const body = await readJsonBody(req);
      const session = sessionFrom(url, body);
      // clear:true 是显式复位入口（测试脚本收尾用）：把状态清回「待命」。
      // 普通写入仍然拒绝空字符串，免得误把状态栏清空当成正常渲染。
      const text = body.clear === true ? '' : requireText(body.text, 'text', MAX_STATUS_CHARS);
      const requestedState = typeof body.state === 'string' ? body.state : undefined;
      const titleHint = readTitleHint(body);
      const status = await handlers.onStatus(session, text, requestedState, titleHint);
      return json(res, 200, Object.assign(
        { ok: true, session: session, text: text },
        status && typeof status === 'object' ? status : {}
      ));
    }

    if (pathname === '/window' && method === 'POST') {
      if (typeof handlers.onWindow !== 'function') {
        return json(res, 501, { ok: false, error: '窗口切换接口未启用' });
      }
      const body = await readJsonBody(req);
      const session = sessionFrom(url, body);
      if (body.windowId === undefined && body.id === undefined) {
        return json(res, 400, { ok: false, error: '缺少 windowId（要解绑请显式传 null）' });
      }
      const raw = body.windowId !== undefined ? body.windowId : body.id;
      // null / 空串 = 显式解绑：任务结束时靠它停掉抓帧循环、清掉旧错误
      const explicitUnbind = raw === null || raw === '';
      const windowId = await handlers.onWindow(session, raw, body.title);
      if (explicitUnbind && !windowId) {
        return json(res, 200, { ok: true, session: session, windowId: null, unbound: true });
      }
      if (!windowId) {
        return json(res, 400, { ok: false, error: 'windowId 无效，示例：68544 或 "window:68544:0"' });
      }
      return json(res, 200, { ok: true, session: session, windowId: windowId });
    }

    if (pathname === '/visible' && method === 'POST') {
      if (typeof handlers.onVisible !== 'function') {
        return json(res, 501, { ok: false, error: '显隐接口未启用' });
      }
      const body = await readJsonBody(req);
      const session = sessionFrom(url, body);
      if (typeof body.visible !== 'boolean') {
        return json(res, 400, { ok: false, error: 'visible 必须是布尔值 true/false' });
      }
      const result = await handlers.onVisible(session, body.visible);
      return json(res, 200, Object.assign(
        { ok: true, session: session },
        result || { visible: body.visible }
      ));
    }

    if (pathname === '/expand' && method === 'POST') {
      if (typeof handlers.onExpand !== 'function') {
        return json(res, 501, { ok: false, error: '放大接口未启用' });
      }
      const body = await readJsonBody(req);
      const session = sessionFrom(url, body);
      const result = await handlers.onExpand(session);
      return json(res, 200, Object.assign({ ok: true, session: session }, result || {}));
    }

    if (pathname === '/frame' && method === 'POST') {
      if (typeof handlers.onFrame !== 'function') {
        return json(res, 501, { ok: false, error: '画面推送接口未启用' });
      }
      const body = await readJsonBody(req);
      const session = sessionFrom(url, body);
      if (typeof body.dataUrl !== 'string' || body.dataUrl.indexOf('data:image/') !== 0) {
        return json(res, 400, { ok: false, error: 'dataUrl 必须是 data:image/... 开头的字符串' });
      }
      const width = readDimension(body.width, 'width');
      const height = readDimension(body.height, 'height');
      await handlers.onFrame(session, body.dataUrl, body.note, body.cursor, width, height);
      return json(res, 200, {
        ok: true,
        session: session,
        bytes: body.dataUrl.length,
        width: width || null,
        height: height || null,
      });
    }

    if (pathname === '/stop-task' && method === 'POST') {
      if (typeof handlers.stopTask !== 'function') {
        return json(res, 501, { ok: false, error: '停止任务接口未启用' });
      }
      const body = await readJsonBody(req);
      const session = sessionFrom(url, body);
      const result = await handlers.stopTask(session);
      return json(res, 200, Object.assign({ ok: true, session: session }, result || {}));
    }

    if (pathname === '/close' && method === 'POST') {
      if (typeof handlers.close !== 'function') {
        return json(res, 501, { ok: false, error: '关闭接口未启用' });
      }
      const body = await readJsonBody(req);
      const session = sessionFrom(url, body);
      const closed = await handlers.close(session);
      if (!closed) {
        return json(res, 404, { ok: false, session: session, error: '会话不存在：' + session });
      }
      return json(res, 200, { ok: true, session: session, closed: true });
    }

    const known = ['/', '/health', '/sessions', '/windows', '/frame-target', '/log', '/status', '/window', '/visible', '/frame', '/expand', '/stop-task', '/close'];
    if (known.indexOf(pathname) !== -1) {
      return json(res, 405, { ok: false, error: method + ' 不被支持，请使用对应的方法' });
    }

    return json(res, 404, { ok: false, error: '未知接口：' + pathname });
  }

  const server = http.createServer((req, res) => {
    route(req, res).catch((error) => {
      const statusCode = Number(error && error.statusCode) || 500;
      if (res.headersSent) {
        res.end();
        return;
      }
      json(res, statusCode, { ok: false, error: String((error && error.message) || error) });
    });
  });

  return {
    server: server,
    get address() {
      return server.address();
    },
    listen() {
      return new Promise((resolve, reject) => {
        const onError = (error) => {
          server.removeListener('listening', onListening);
          reject(error);
        };
        const onListening = () => {
          server.removeListener('error', onError);
          resolve(server.address());
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, host);
      });
    },
    close() {
      return new Promise((resolve) => {
        if (!server.listening) {
          resolve();
          return;
        }
        server.close(() => resolve());
        if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
        if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      });
    },
  };
}

module.exports = { createOverlayServer, normalizeSession, DEFAULT_SESSION, SESSION_PATTERN };