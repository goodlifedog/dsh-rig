'use strict';
// 控制面票据：这是挡「别的用户/浏览器页面」的唯一一道门，默认行为错一点就是致命洞
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { isAuthorized } from '../core/local-token.mjs';

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
