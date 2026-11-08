'use strict';
/**
 * 本地控制面票据（ESM 外观）：真正实现放在 local-token.cjs，
 * daemon/overlay 是 CJS，命令行脚本是 ESM，两边共用同一份逻辑。
 *
 * 为什么需要：服务只监听 127.0.0.1，但同机任意进程（包括别的用户）都能连 127.0.0.1。
 * token 文件权限 600、home 目录 700，别的用户读不到，就挡在门外。
 */
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const token = require('./local-token.cjs');

export const TOKEN_HEADER = token.TOKEN_HEADER;
export const tokenPath = token.tokenPath;
export const newToken = token.newToken;
export const withTokenHeaders = token.withTokenHeaders;
export const hardenDataDir = token.hardenDataDir;

/** 确保 token 文件存在（服务端启动时调用） */
export async function ensureToken(options = {}) {
  const file = (options && options.path) || token.tokenPath();
  return token.ensureTokenSync(file);
}

/** 读 token（客户端调用；服务端没起来时返回空串） */
export async function readToken(options = {}) {
  return token.readTokenSync((options && options.path) || token.tokenPath());
}

/** 同步读（脚本里方便，读不到返回空串） */
export function readTokenSync(options = {}) {
  return token.readTokenSync((options && options.path) || token.tokenPath());
}

/**
 * 判断请求是否带对 token。
 * @param {object} headers
 * @param {string} expected 服务端 token
 * @param {{queryToken?: string, allowQuery?: boolean}} [options]
 *   queryToken 是请求里的 ?token= 值；默认不认查询参数，必须 allowQuery:true 才生效。
 */
export function isAuthorized(headers, expected, options = {}) {
  const opts = options || {};
  return token.isAuthorized(headers, expected, opts.queryToken || '', { allowQuery: opts.allowQuery === true });
}

/**
 * 本地接口请求头：无条件带 token。**只适用于已经确定目标就是本机回环的调用**。
 * 目标 URL 可能来自 OVERLAY_URL / AGENTD_URL 的自定义值时，请改用 tokenHeadersFor(url)。
 */
export function localHeaders(extra = {}) {
  const value = token.readTokenSync();
  return token.withTokenHeaders(value, extra || {});
}

// ---------- 按目标 URL 决定要不要带 token（M-5） ----------
export const REMOTE_TOKEN_ENV = token.REMOTE_TOKEN_ENV;
export const isLoopbackHost = token.isLoopbackHost;
export const isLoopbackUrl = token.isLoopbackUrl;
export const shouldSendToken = token.shouldSendToken;

/**
 * 按 URL 生成请求头：目标是回环才附带 token；非回环默认不带，
 * 除非显式 AGENT_ALLOW_REMOTE_TOKEN=1（此时打印一次警告）。
 * @param {string|URL} url 请求目标
 * @param {object} [extra] 显式请求头
 * @param {{allowRemote?:boolean, silent?:boolean, token?:string, path?:string}} [options]
 */
export function tokenHeadersFor(url, extra = {}, options = {}) {
  return token.tokenHeadersFor(url, extra, options);
}
