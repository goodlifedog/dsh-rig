'use strict';
// 端口默认值现在有两处写法（daemon.mjs / overlay/main.js 各自一份常量，ports.mjs 一份）。
// 两边一旦改岔，诊断工具和真服务就会连不同端口——用测试钉住一致性。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { daemonPort, overlayPort } from '../core/ports.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

function withCleanEnv(fn) {
  const d = process.env.AGENTD_PORT;
  const o = process.env.OVERLAY_PORT;
  delete process.env.AGENTD_PORT;
  delete process.env.OVERLAY_PORT;
  try { return fn(); } finally {
    if (d !== undefined) process.env.AGENTD_PORT = d;
    if (o !== undefined) process.env.OVERLAY_PORT = o;
  }
}

test('daemon.mjs 的默认端口与 ports.mjs 一致', () => {
  const m = /process\.env\.AGENTD_PORT\s*\|\|\s*(\d+)/.exec(read('core/daemon.mjs'));
  assert.ok(m, 'daemon.mjs 里找不到默认端口写法');
  withCleanEnv(() => assert.equal(Number(m[1]), daemonPort(), 'daemon.mjs 默认 ' + m[1] + ' vs ports.mjs ' + daemonPort()));
});

test('overlay/main.js 的默认端口与 ports.mjs 一致', () => {
  const m = /const DEFAULT_PORT = (\d+)/.exec(read('overlay/main.js'));
  assert.ok(m, 'overlay/main.js 里找不到 DEFAULT_PORT');
  withCleanEnv(() => assert.equal(Number(m[1]), overlayPort(), 'overlay 默认 ' + m[1] + ' vs ports.mjs ' + overlayPort()));
});

test('两个默认端口不相同（避免 daemon 和 overlay 抢同一端口）', () => {
  withCleanEnv(() => assert.notEqual(daemonPort(), overlayPort()));
});
