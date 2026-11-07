'use strict';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { checkFreshness, formatFreshness, WATCH_FILES } from '../core/deploy-freshness.mjs';

function tmpRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fresh-'));
  fs.mkdirSync(path.join(dir, 'core'), { recursive: true });
  return dir;
}

test('文件都比进程启动早：不落后', () => {
  const root = tmpRoot();
  const file = path.join(root, 'core', 'a.mjs');
  fs.writeFileSync(file, 'x');
  const started = Date.now() + 5000;   // 进程在文件之后启动
  const r = checkFreshness({ rootDir: root, startedAtMs: started, files: ['core/a.mjs'] });
  assert.equal(r.stale, false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('文件比进程启动新：判定落后并指出文件', () => {
  const root = tmpRoot();
  const file = path.join(root, 'core', 'b.mjs');
  fs.writeFileSync(file, 'x');
  const started = Date.now() - 60000;  // 进程一分钟前启动
  const r = checkFreshness({ rootDir: root, startedAtMs: started, files: ['core/b.mjs'] });
  assert.equal(r.stale, true);
  assert.equal(r.newestFile, 'core/b.mjs');
  assert.match(formatFreshness('daemon', r), /落后/);
  assert.match(formatFreshness('daemon', r), /service:restart/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('缺失的文件被忽略，不报错', () => {
  const root = tmpRoot();
  const r = checkFreshness({ rootDir: root, startedAtMs: Date.now(), files: ['core/nope.mjs'] });
  assert.equal(r.stale, false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('输入不完整时安全返回', () => {
  assert.equal(checkFreshness().stale, false);
  assert.equal(checkFreshness({ rootDir: '/tmp', startedAtMs: 0, files: [] }).stale, false);
});

test('watch 列表覆盖 daemon 与 overlay 的关键依赖', () => {
  assert.ok(WATCH_FILES.daemon.includes('core/agentd.mjs'));
  assert.ok(WATCH_FILES.overlay.includes('overlay/session-policy.js'));
});
