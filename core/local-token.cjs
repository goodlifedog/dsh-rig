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

function chmodSafe(target, mode) {
  try { fs.chmodSync(target, mode); } catch {}
}

/**
 * 收紧数据目录权限（幂等）。
 *
 * 坑：mkdirSync 的 mode 只在“新建”时生效，目录已存在（比如早期版本以 755 建的）就完全不修正，
 * 于是文档里“目录 700”的保证是假的——本机别的用户能列目录、能读 644 的 profile 文件
 * （浏览器 profile 里可能有登录态 cookie）。所以每次启动都要显式 chmod 一遍。
 *
 * @param {string} [dir] 数据目录，默认 ~/.desktop-agent
 * @returns {string} 实际处理的目录
 */
function hardenDataDir(dir) {
  const base = dir || path.dirname(tokenPath());
  chmodSafe(base, 0o700);
  // 已知的敏感子目录（浏览器 profile 可能带登录态）；不存在就跳过，不报错
  for (const name of ['bin', 'smoke', 'chrome-profile', 'headless-profile', 'headless-profile-p1', 'headless-profile-p2']) {
    chmodSafe(path.join(base, name), 0o700);
  }
  chmodSafe(path.join(base, 'api-token'), 0o600);
  return base;
}

/** 已有就复用，没有就生成一个写进 600 文件（每次都会顺手把目录/文件权限修正到 700/600） */
function ensureTokenSync(target) {
  const file = target || tokenPath();
  const dir = path.dirname(file);
  try { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch {}
  chmodSafe(dir, 0o700);   // 已存在时上面的 mode 不生效，必须显式补
  if (path.resolve(file) === path.resolve(tokenPath())) hardenDataDir(dir);
  try {
    const existing = String(fs.readFileSync(file, 'utf8')).trim();
    if (/^[0-9a-f]{32,}$/i.test(existing)) {
      chmodSafe(file, 0o600);   // 被备份/恢复成 644 时也要纠正回来
      return existing;
    }
  } catch {}
  const token = newToken();
  fs.writeFileSync(file, token + '\n', { mode: 0o600 });
  chmodSafe(file, 0o600);
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

module.exports = { TOKEN_HEADER, tokenPath, newToken, ensureTokenSync, readTokenSync, withTokenHeaders, isAuthorized, hardenDataDir };
