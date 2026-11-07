'use strict';
// Host 校验：挡 DNS rebinding（evil.com 解析到 127.0.0.1 后打本地服务）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { isLoopbackHost } from '../core/safety.mjs';

test('本机回环 Host 一律放行', () => {
  for (const host of ['127.0.0.1', '127.0.0.1:7789', 'localhost', 'localhost:7788', '[::1]', '[::1]:7788', 'LOCALHOST:1']) {
    assert.equal(isLoopbackHost(host), true, host);
  }
});

test('外部域名 / 空 Host 一律拒绝', () => {
  for (const host of ['evil.example', 'evil.example:7789', '127.0.0.1.evil.com', '0.0.0.0', '', null, undefined]) {
    assert.equal(isLoopbackHost(host), false, String(host));
  }
});

test('边界：方括号不闭合的 IPv6 视为非法', () => {
  assert.equal(isLoopbackHost('[::1'), false);
});
