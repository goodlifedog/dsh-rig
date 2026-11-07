'use strict';
/**
 * 本地控制面的共享票据（token）。
 *
 * 为什么需要：daemon / overlay 只监听 127.0.0.1，但同一台机器上的其它进程（包括别的用户）也能连 127.0.0.1。
 * 只靠"本机"当防线不够——任何本地进程都能 POST /run 让守护进程跑任务（任务里有打字、退出应用这类动作）。
 *
 * 做法：服务端启动时生成随机 token，写到权限 600 的文件里；客户端从同一个文件读出来带上请求头。
 * 这样：别的用户读不到（home 目录权限 + 文件 600）；浏览器来源另有 Origin 拦截。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const TOKEN_HEADER = 'x-agent-token';

export function tokenPath() {
  return path.join(os.homedir(), '.desktop-agent', 'api-token');
}

/** 生成一个新的随机 token（64 位十六进制） */
export function newToken() {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * 确保 token 文件存在，返回现有或新建的 token。
 * @param {{path?:string, deps?:object}} [options]
 * @returns {Promise<string>}
 */
export async function ensureToken(options = {}) {
  const opts = options || {};
  const target = opts.path || tokenPath();
  const deps = Object.assign({ fs }, opts.deps || {});
  try {
    const existing = String(await deps.fs.promises.readFile(target, 'utf8')).trim();
    if (/^[0-9a-f]{32,}$/i.test(existing)) return existing;
  } catch {}
  const token = newToken();
  await deps.fs.promises.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await deps.fs.promises.writeFile(target, token + '\n', { mode: 0o600 });
  try { await deps.fs.promises.chmod(target, 0o600); } catch {}
  return token;
}

/**
 * 读 token；没有就返回空字符串（客户端在服务端还没起来时会读不到）。
 * @param {{path?:string}} [options]
 * @returns {Promise<string>}
 */
export async function readToken(options = {}) {
  const opts = options || {};
  const target = opts.path || tokenPath();
  try {
    return String(await fs.promises.readFile(target, 'utf8')).trim();
  } catch {
    return '';
  }
}

/**
 * 给请求头加上 token（没有 token 时就返回原样，让服务端按未授权处理）。
 * @param {Record<string,string>} [extra]
 * @param {string} token
 */
export function withTokenHeaders(token, extra = {}) {
  const headers = Object.assign({}, extra || {});
  if (token) headers['X-Agent-Token'] = token;
  return headers;
}

/**
 * 判断请求是否带了正确 token（纯函数）。
 * @param {Record<string,string>} headers
 * @param {string} token
 * @param {{allowQueryToken?:string}} [options]
 */
export function isAuthorized(headers, token, options = {}) {
  const opts = options || {};
  if (!token) return false;
  const header = String((headers && (headers[TOKEN_HEADER] || headers['X-Agent-Token'])) || '').trim();
  if (header && header === token) return true;
  if (opts.allowQueryToken && opts.allowQueryToken === token) return true;
  return false;
}
