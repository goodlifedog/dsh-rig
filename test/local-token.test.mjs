'use strict';
// 控制面票据：这是挡「别的用户/浏览器页面」的唯一一道门，默认行为错一点就是致命洞
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import {
  isAuthorized, isLoopbackHost, isLoopbackUrl, shouldSendToken, tokenHeadersFor,
} from '../core/local-token.mjs';
import { isLoopbackHost as safetyIsLoopbackHost } from '../core/safety.mjs';

const require = createRequire(import.meta.url);
const cjs = require('../core/local-token.cjs');

const TOKEN = 'a'.repeat(64);

test('带对请求头就放行，错的/空的都拒绝', () => {
  assert.equal(isAuthorized({ 'x-agent-token': TOKEN }, TOKEN), true);
  assert.equal(isAuthorized({ 'X-Agent-Token': TOKEN }, TOKEN), true);
  assert.equal(isAuthorized({ 'x-agent-token': 'b'.repeat(64) }, TOKEN), false);
  assert.equal(isAuthorized({ 'x-agent-token': '' }, TOKEN), false);
  assert.equal(isAuthorized({}, TOKEN), false);
  assert.equal(isAuthorized(null, TOKEN), false);
});

test('服务端没有 token 时一律拒绝（不能出现「没配就全放行」）', () => {
  assert.equal(isAuthorized({ 'x-agent-token': '' }, ''), false);
  assert.equal(isAuthorized({ 'x-agent-token': 'anything' }, ''), false);
  assert.equal(isAuthorized({}, ''), false);
});

test('?token= 默认不认；显式 allowQuery 才认', () => {
  assert.equal(isAuthorized({}, TOKEN, { queryToken: TOKEN }), false, '默认必须拒绝查询参数');
  assert.equal(isAuthorized({}, TOKEN, { queryToken: TOKEN, allowQuery: true }), true);
  assert.equal(isAuthorized({}, TOKEN, { queryToken: 'b'.repeat(64), allowQuery: true }), false);
  // 头里带对 + 查询里带错：头优先，仍然放行
  assert.equal(isAuthorized({ 'x-agent-token': TOKEN }, TOKEN, { queryToken: 'nope' }), true);
});

test('长度不同的 token 不能把比较搞崩（timingSafeEqual 会抛错）', () => {
  assert.doesNotThrow(() => cjs.isAuthorized({ 'x-agent-token': 'short' }, TOKEN));
  assert.equal(cjs.isAuthorized({ 'x-agent-token': 'short' }, TOKEN), false);
  assert.doesNotThrow(() => cjs.isAuthorized({}, TOKEN, 'x'.repeat(4), { allowQuery: true }));
});

test('token 文件：首次生成 600 权限、内容够长；再次调用复用同一个', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'token-'));
  const file = path.join(dir, 'api-token');
  try {
    const first = cjs.ensureTokenSync(file);
    assert.match(first, /^[0-9a-f]{64}$/, '32 字节随机数的 hex 是 64 位');
    const mode = fs.statSync(file).mode & 0o777;
    assert.equal(mode, 0o600, 'token 文件必须 600，别的用户读不到');
    assert.equal(cjs.readTokenSync(file), first);
    assert.equal(cjs.ensureTokenSync(file), first, '已有 token 要复用，不能每次重启换一个');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('权限修正：已存在的 755 目录和 644 token 文件会被纠正成 700/600', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'token-'));
  const file = path.join(dir, 'api-token');
  try {
    fs.chmodSync(dir, 0o755);
    fs.writeFileSync(file, cjs.newToken() + '\n', { mode: 0o644 });
    fs.chmodSync(file, 0o644);
    const token = cjs.ensureTokenSync(file);
    assert.match(token, /^[0-9a-f]{64}$/);
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700, '目录已存在时 mkdir 的 mode 不生效，必须显式 chmod');
    assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'token 合法也要把权限纠正回来');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('hardenDataDir：存在的敏感子目录收紧到 700，不存在的不报错', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harden-'));
  try {
    const profile = path.join(dir, 'chrome-profile');
    fs.mkdirSync(profile, { recursive: true });
    fs.chmodSync(dir, 0o755);
    fs.chmodSync(profile, 0o755);
    cjs.hardenDataDir(dir);
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
    assert.equal(fs.statSync(profile).mode & 0o777, 0o700, '浏览器 profile 可能带登录态，也要 700');
    assert.doesNotThrow(() => cjs.hardenDataDir(path.join(dir, '不存在')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('token 文件内容被写坏时重新生成，不会把坏值当 token 用', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'token-'));
  const file = path.join(dir, 'api-token');
  try {
    fs.writeFileSync(file, 'short');
    const token = cjs.ensureTokenSync(file);
    assert.match(token, /^[0-9a-f]{64}$/);
    assert.notEqual(token, 'short');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- M-5：token 不能跟着自定义 OVERLAY_URL / AGENTD_URL 发到非回环主机 ----------

test('回环地址才默认带 token（127.0.0.1 / localhost / [::1]）', () => {
  for (const url of [
    'http://127.0.0.1:7788/health',
    'http://localhost:7789/status',
    'http://[::1]:7788/health',
    'https://127.0.0.1/',
  ]) {
    assert.equal(shouldSendToken(url), true, url + ' 应该带 token');
    const headers = tokenHeadersFor(url, { 'X-Extra': 'v' }, { token: TOKEN });
    assert.equal(headers['X-Agent-Token'], TOKEN, url);
    assert.equal(headers['X-Extra'], 'v', '显式请求头不能被丢掉');
  }
  // token 为空时不加头（兼容测试环境，和 withTokenHeaders 的旧行为一致）
  assert.equal(tokenHeadersFor('http://127.0.0.1:7788/health', {}, { token: '' })['X-Agent-Token'], undefined);
});

test('非回环默认不带 token（自定义 OVERLAY_URL/AGENTD_URL 指向别的机器时）', () => {
  const prev = process.env.AGENT_ALLOW_REMOTE_TOKEN;
  delete process.env.AGENT_ALLOW_REMOTE_TOKEN;
  try {
    for (const url of [
      'http://203.0.113.5:7788/health',
      'https://example.com/health',
      'http://127.0.0.1.evil.com/health',
      'http://localhost.evil.com:7788/health',
    ]) {
      assert.equal(shouldSendToken(url), false, url + ' 不应该带 token');
      const headers = tokenHeadersFor(url, { 'Content-Type': 'application/json' }, { token: TOKEN });
      assert.equal(headers['X-Agent-Token'], undefined, url + ' 不能把 token 发出去');
      assert.equal(headers['Content-Type'], 'application/json', '其它请求头照常保留');
    }
    // 解析不了的 URL 一律 fail closed（不发）
    for (const url of ['', null, undefined, 'not a url', '/health', 'file:///tmp/x', 'ftp://127.0.0.1/']) {
      assert.equal(shouldSendToken(url), false, String(url));
      assert.equal(tokenHeadersFor(url, {}, { token: TOKEN })['X-Agent-Token'], undefined, String(url));
    }
  } finally {
    if (prev !== undefined) process.env.AGENT_ALLOW_REMOTE_TOKEN = prev;
  }
});

test('非回环 + 显式 AGENT_ALLOW_REMOTE_TOKEN=1 才带 token（环境变量路径）', () => {
  const prev = process.env.AGENT_ALLOW_REMOTE_TOKEN;
  process.env.AGENT_ALLOW_REMOTE_TOKEN = '1';
  try {
    assert.equal(shouldSendToken('http://203.0.113.9:7788/', { silent: true }), true);
    const headers = tokenHeadersFor('http://203.0.113.9:7788/health', {}, { silent: true, token: TOKEN });
    assert.equal(headers['X-Agent-Token'], TOKEN);
  } finally {
    if (prev === undefined) delete process.env.AGENT_ALLOW_REMOTE_TOKEN;
    else process.env.AGENT_ALLOW_REMOTE_TOKEN = prev;
  }
});

test('显式允许远程时只警告一次，且 silent 不打扰测试', () => {
  const warns = [];
  const original = console.warn;
  console.warn = (...args) => { warns.push(args.map(String).join(' ')); };
  try {
    // silent:true 不产生警告
    assert.equal(shouldSendToken('http://198.51.100.9:7788/', { allowRemote: true, silent: true }), true);
    assert.equal(warns.length, 0);

    // 第一次真正允许远程：警告一次
    assert.equal(shouldSendToken('http://198.51.100.9:7788/', { allowRemote: true }), true);
    assert.equal(warns.length, 1, '应该打印一次警告');
    assert.match(warns[0], /AGENT_ALLOW_REMOTE_TOKEN/);
    assert.match(warns[0], /198\.51\.100\.9/, '警告里要写清发往哪个主机');

    // 第二次不再重复警告
    assert.equal(shouldSendToken('http://198.51.100.9:7788/', { allowRemote: true }), true);
    assert.equal(warns.length, 1, '警告只打一次，不要刷屏');

    const headers = tokenHeadersFor('http://198.51.100.9:7788/health', { 'X-Test': '1' }, { allowRemote: true, token: TOKEN });
    assert.equal(headers['X-Agent-Token'], TOKEN);
    assert.equal(headers['X-Test'], '1');
  } finally {
    console.warn = original;
  }
});

test('local-token 与 safety 的回环判定规则保持一致（两边各留一份实现，不能漂移）', () => {
  const hosts = [
    '127.0.0.1', '127.0.0.1:7788', 'localhost', 'localhost:7789', '[::1]:7788', '[::1]',
    'evil.example', '127.0.0.1.evil.com', 'localhost.evil.com', '', '198.51.100.1', '[::1',
  ];
  for (const host of hosts) {
    assert.equal(isLoopbackHost(host), safetyIsLoopbackHost(host), JSON.stringify(host));
  }
  // URL 层：只有回环主机名才算
  assert.equal(isLoopbackUrl('http://127.0.0.1:7788/health'), true);
  assert.equal(isLoopbackUrl('http://[::1]:7788/health'), true);
  assert.equal(isLoopbackUrl('http://example.com/'), false);
  assert.equal(isLoopbackUrl('not a url'), false);
});
