'use strict';
/**
 * 本地控制面票据（CommonJS 版）：daemon、overlay 都是 CJS/Electron 主进程，
 * 统一放在这里生成/读取，ESM 那边由 local-token.mjs 包一层，避免两份实现漂移。
 *
 * 为什么需要：服务只监听 127.0.0.1，但同机任意进程（包括别的用户）都能连 127.0.0.1。
 * token 文件权限 600、home 目录 700，别的用户读不到，就挡在门外。
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TOKEN_HEADER = 'x-agent-token';

function tokenPath() {
  return path.join(os.homedir(), '.desktop-agent', 'api-token');
}

function newToken() {
  return crypto.randomBytes(32).toString('hex');
}

/** 已有就复用，没有就生成一个写进 600 文件 */
function ensureTokenSync(target) {
  const file = target || tokenPath();
  try {
    const existing = String(fs.readFileSync(file, 'utf8')).trim();
    if (/^[0-9a-f]{32,}$/i.test(existing)) return existing;
  } catch {}
  const token = newToken();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, token + '\n', { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch {}
  return token;
}

/** 读不到返回空字符串（服务端没起来时客户端会读不到） */
function readTokenSync(target) {
  try {
    return String(fs.readFileSync(target || tokenPath(), 'utf8')).trim();
  } catch {
    return '';
  }
}

/** 给请求头补上 token（纯函数式，便于测试） */
function withTokenHeaders(token, extra) {
  const headers = Object.assign({}, extra || {});
  if (token) headers['X-Agent-Token'] = token;
  return headers;
}

/** 定长比较：长度不同直接 false，避免 timingSafeEqual 抛错、也避免长度差泄露信息 */
function safeEqual(a, b) {
  const left = Buffer.from(String(a || ''), 'utf8');
  const right = Buffer.from(String(b || ''), 'utf8');
  if (!left.length || left.length !== right.length) return false;
  try {
    return crypto.timingSafeEqual(left, right);
  } catch {
    return false;
  }
}

/**
 * 校验请求是否带对 token。
 *
 * 默认只认请求头。查询参数 ?token= 会进 shell history、进程列表和访问日志，
 * 属于「方便但会漏」的用法，所以必须显式打开（settings.allowQuery === true）才认。
 *
 * @param {object} headers
 * @param {string} token 服务端持有的 token
 * @param {string} [queryToken] 查询参数里的 token
 * @param {{allowQuery?: boolean}} [settings]
 */
function isAuthorized(headers, token, queryToken, settings = {}) {
  if (!token) return false;
  const header = String((headers && (headers[TOKEN_HEADER] || headers['X-Agent-Token'])) || '').trim();
  if (header && safeEqual(header, token)) return true;
  const allowQuery = Boolean(settings && settings.allowQuery);
  return allowQuery && Boolean(queryToken) && safeEqual(queryToken, token);
}

module.exports = { TOKEN_HEADER, tokenPath, newToken, ensureTokenSync, readTokenSync, withTokenHeaders, isAuthorized };
