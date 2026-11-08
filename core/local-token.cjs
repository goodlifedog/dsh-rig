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
  // 遍历 base 下所有子目录统一 700：白名单会漏掉自定义 profile
  // （AGENT_CHROME_PROFILE / HEADLESS_PROFILE / 任务自建的 concurrent-profile 等），
  // 而它们同样可能带登录态 cookie。只处理真实目录，不跟符号链接。
  try {
    for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
      if (entry.isDirectory()) chmodSafe(path.join(base, entry.name), 0o700);
    }
  } catch {}
  // 兜底：遍历失败（权限/竞态）时至少把已知敏感目录收一遍；不存在就跳过，不报错
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

// ---------- token 发送目标决策（M-5） ----------
//
// 背景：OVERLAY_URL / AGENTD_URL 允许自定义（注释里写「别的机器/隧道」），
// 而旧代码会无条件把 X-Agent-Token 附到每个请求上——URL 一旦指向非回环主机，
// token 就明文发出去了。这里按「目标 URL 是不是本机回环」决定要不要带 token：
//   - 回环（127.0.0.1 / localhost / [::1]）→ 带；
//   - 非回环 → 默认不带；只有显式 AGENT_ALLOW_REMOTE_TOKEN=1 才带，并打印一次警告。
// 规则与 core/safety.mjs 的 isLoopbackHost 保持一致（那边是 ESM，这里是 CJS，最小实现各留一份，
// 两边都有单测；改规则要同时改）。
const REMOTE_TOKEN_ENV = 'AGENT_ALLOW_REMOTE_TOKEN';

/** host 头（可带端口）或 URL 的 hostname 是否指向本机回环 */
function isLoopbackHost(hostHeader) {
  const raw = String(hostHeader || '').trim().toLowerCase();
  if (!raw) return false;
  let host = raw;
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    if (end < 0) return false;
    host = host.slice(1, end);
  } else {
    host = host.split(':')[0];
  }
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

/** URL 是否指向本机回环（只认 http/https；解析失败按「不是回环」处理，fail closed） */
function isLoopbackUrl(url) {
  let parsed;
  try { parsed = new URL(String(url == null ? '' : url)); } catch { return false; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  return isLoopbackHost(parsed.hostname);
}

let remoteTokenWarned = false;

/**
 * 这个 URL 该不该带 token。
 * @param {string|URL} url 请求目标
 * @param {{allowRemote?:boolean, silent?:boolean}} [options]
 *   allowRemote 默认读 AGENT_ALLOW_REMOTE_TOKEN=1；测试可以显式传 true/false
 * @returns {boolean}
 */
function shouldSendToken(url, options = {}) {
  const opts = options || {};
  if (isLoopbackUrl(url)) return true;
  // 这里用字面量而不是 process.env[REMOTE_TOKEN_ENV]：scripts/env-doc.mjs 只认字面量写法，
  // 否则 AGENT_ALLOW_REMOTE_TOKEN 不会出现在 flow/TASK-ENV.md 里（repo:check 会报不同步）。
  const allowRemote = opts.allowRemote === undefined
    ? process.env.AGENT_ALLOW_REMOTE_TOKEN === '1'
    : Boolean(opts.allowRemote);
  if (!allowRemote) return false;
  if (!opts.silent && !remoteTokenWarned) {
    remoteTokenWarned = true;
    let target = '';
    try { target = new URL(String(url)).host; } catch {}
    try {
      console.warn('[desktop-agent] ' + REMOTE_TOKEN_ENV + '=1：X-Agent-Token 将发往非回环地址 '
        + (target || '(无法解析的 URL)') + '。只在你完全信任这条隧道时开启。');
    } catch {}
  }
  return true;
}

/**
 * 按 URL 生成请求头：回环才附带 token（或显式允许远程时）。
 * @param {string|URL} url
 * @param {object} [extra] 显式请求头
 * @param {{allowRemote?:boolean, silent?:boolean, token?:string, path?:string}} [options]
 *   token/path 仅测试用：不传就按默认 token 文件读
 */
function tokenHeadersFor(url, extra, options = {}) {
  const opts = options || {};
  const headers = Object.assign({}, extra || {});
  if (!shouldSendToken(url, opts)) return headers;
  const value = opts.token !== undefined ? String(opts.token) : readTokenSync(opts.path);
  return withTokenHeaders(value, headers);
}

module.exports = {
  TOKEN_HEADER, tokenPath, newToken, ensureTokenSync, readTokenSync, withTokenHeaders, isAuthorized, hardenDataDir,
  REMOTE_TOKEN_ENV, isLoopbackHost, isLoopbackUrl, shouldSendToken, tokenHeadersFor,
};
