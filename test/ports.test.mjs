'use strict';
// 端口单一来源：daemon/overlay 端口都从环境变量读，诊断工具不能各写死一份。
import test from 'node:test';
import assert from 'node:assert/strict';
import { daemonPort, overlayPort, daemonUrl, overlayUrl } from '../core/ports.mjs';

function withEnv(key, value, fn) {
  const old = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try { return fn(); } finally {
    if (old === undefined) delete process.env[key];
    else process.env[key] = old;
  }
}

test('默认端口：daemon 7789 / overlay 7788', () => {
  withEnv('AGENTD_PORT', undefined, () => assert.equal(daemonPort(), 7789));
  withEnv('OVERLAY_PORT', undefined, () => assert.equal(overlayPort(), 7788));
});

test('环境变量能覆盖端口', () => {
  withEnv('AGENTD_PORT', '7799', () => {
    assert.equal(daemonPort(), 7799);
    assert.equal(daemonUrl('/status'), 'http://127.0.0.1:7799/status');
  });
  withEnv('OVERLAY_PORT', '7797', () => assert.equal(overlayUrl('/health'), 'http://127.0.0.1:7797/health'));
});

test('非法值回退默认，不抛错', () => {
  for (const bad of ['0', '-1', 'abc', '70000', '']) {
    withEnv('AGENTD_PORT', bad, () => assert.equal(daemonPort(), 7789, bad));
  }
});
