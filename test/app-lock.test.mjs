'use strict';
// 应用锁：长任务不能被后来者抢锁（评审实锤：只按 mtime 判过期，长任务会被抢）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { withAppLock } from '../core/agentd.mjs';

const lockFile = (app) => path.join(os.tmpdir(), 'agentd-' + app.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '.lock');

function cleanup(app) {
  try { fs.unlinkSync(lockFile(app)); } catch {}
}

test('持锁进程已经死了的锁：可以接管', async () => {
  const app = 'lock-test-dead-' + Date.now();
  cleanup(app);
  fs.writeFileSync(lockFile(app), '999999');                 // 不存在的 pid
  const old = new Date(Date.now() - 10 * 60 * 1000);
  fs.utimesSync(lockFile(app), old, old);                    // 很旧的 mtime
  let ran = false;
  const result = await withAppLock(app, async () => { ran = true; return 42; }, { timeoutMs: 2000, staleMs: 5000 });
  assert.equal(result, 42);
  assert.equal(ran, true);
  assert.equal(fs.existsSync(lockFile(app)), false, '跑完要释放锁');
  cleanup(app);
});

test('持锁进程还活着：不许抢，等超时就报错', async () => {
  const app = 'lock-test-live-' + Date.now();
  cleanup(app);
  fs.writeFileSync(lockFile(app), String(process.pid));      // 自己还活着
  let ran = false;
  await assert.rejects(
    () => withAppLock(app, async () => { ran = true; }, { timeoutMs: 600, staleMs: 60000 }),
    /等待应用锁超时/,
  );
  assert.equal(ran, false, '没拿到锁就不能执行');
  cleanup(app);
});

test('持锁期间心跳续期：mtime 持续被刷新', async () => {
  const app = 'lock-test-beat-' + Date.now();
  cleanup(app);
  const file = lockFile(app);
  await withAppLock(app, async () => {
    const before = fs.statSync(file).mtimeMs;
    await new Promise((r) => setTimeout(r, 1200));
    const after = fs.statSync(file).mtimeMs;
    assert.ok(after >= before, 'mtime 不该倒退');
    assert.ok(after > before, '心跳应该刷新 mtime（否则长任务会被判过期）');
  }, { timeoutMs: 2000, staleMs: 600 });
  cleanup(app);
});
