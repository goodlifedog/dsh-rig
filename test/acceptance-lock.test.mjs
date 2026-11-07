'use strict';
// 验收互斥锁：两个验收同时跑会一起切窗口、一起动测试数据，必须保证只有一个能进
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  acquireLock,
  releaseLock,
  readLockPid,
  pidAlive,
  CORRUPT_LOCK_GRACE_MS,
  parsePpidTable,
  isDescendantOf,
  foreignAcceptanceOwner,
} from '../core/acceptance-lock.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acceptance-lock-'));
function fileFor(name) { return path.join(dir, name + '.lock'); }

test.after(() => { fs.rmSync(dir, { recursive: true, force: true }); });

test('拿锁后文件里是自己的 pid，且不留临时文件', () => {
  const file = fileFor('fresh');
  const r = acquireLock(file, { pid: 4242 });
  assert.equal(r.ok, true);
  assert.equal(readLockPid(file), 4242);
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp')), []);
});

test('别人活着时抢不到锁，而且不会删掉他的锁', () => {
  const file = fileFor('busy');
  assert.equal(acquireLock(file, { pid: 111 }).ok, true);
  const r = acquireLock(file, { pid: 222, alive: (pid) => pid === 111 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'busy');
  assert.equal(r.pid, 111);
  assert.equal(readLockPid(file), 111, '不能把别人的锁回收掉');
});

test('持锁进程已死：残留锁会被回收，新进程能拿到', () => {
  const file = fileFor('stale');
  fs.writeFileSync(file, '999999 2026-01-01T00:00:00.000Z');
  const r = acquireLock(file, { pid: 333, alive: () => false });
  assert.equal(r.ok, true);
  assert.equal(readLockPid(file), 333);
});

test('锁内容不可解析且很新：判 busy，不抢（防止误删正在写的锁）', () => {
  const file = fileFor('corrupt-new');
  fs.writeFileSync(file, '');
  const r = acquireLock(file, { pid: 444, alive: () => false });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'busy');
});

test('锁内容不可解析且已过期：当成崩溃残留回收', () => {
  const file = fileFor('corrupt-old');
  fs.writeFileSync(file, '');
  const old = new Date(Date.now() - CORRUPT_LOCK_GRACE_MS * 2);
  fs.utimesSync(file, old, old);
  const r = acquireLock(file, { pid: 555, alive: () => false });
  assert.equal(r.ok, true);
  assert.equal(readLockPid(file), 555);
});

test('并发抢锁：两个进程同时抢只有一个成功', () => {
  const file = fileFor('race');
  const results = [];
  // 模拟两个进程：A 已拿到锁，B 后到
  results.push(acquireLock(file, { pid: 666, alive: (pid) => pid === 666 }));
  results.push(acquireLock(file, { pid: 777, alive: (pid) => pid === 666 }));
  assert.equal(results.filter((r) => r.ok).length, 1, '只能有一个成功');
  assert.equal(readLockPid(file), 666);
});

test('释放锁只删自己的，别人的锁不动', () => {
  const file = fileFor('release');
  assert.equal(acquireLock(file, { pid: 888 }).ok, true);
  assert.equal(releaseLock(file, 999), false);
  assert.equal(fs.existsSync(file), true);
  assert.equal(releaseLock(file, 888), true);
  assert.equal(fs.existsSync(file), false);
});

test('写锁失败时按未加锁继续，但必须给警告（fail-open 是有意为之，不能静默）', () => {
  const parent = path.join(dir, 'not-a-dir');
  fs.writeFileSync(parent, 'x');   // 父路径是个文件：建目录/写临时文件都会失败
  const r = acquireLock(path.join(parent, 'lock'), { pid: 4321 });
  assert.equal(r.ok, true, '拿不到锁不该把验收直接卡死');
  assert.ok(r.warning && r.warning.length > 0, '但必须警告，否则用户不知道这次没加锁');
});

test('进程树判定：祖先链上的 pid 算自己人，旁支不算', () => {
  const table = parsePpidTable(['  100  5', '  200 100', '  300 200', '  400   1'].join('\n'));
  assert.equal(isDescendantOf(100, 300, table), true);
  assert.equal(isDescendantOf(100, 100, table), true, '自己也算');
  assert.equal(isDescendantOf(100, 400, table), false);
  assert.equal(isDescendantOf(0, 300, table), false);
  assert.equal(isDescendantOf(100, 300, null), false);
});

test('解析 ppid 表：坏行忽略', () => {
  const table = parsePpidTable('100 1\nnot a line\n200 100\n');
  assert.equal(table.get(100), 1);
  assert.equal(table.get(200), 100);
  assert.equal(table.size, 2);
});

test('验收锁：自己的祖先持锁不算冲突，外部进程持锁要报冲突', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'accept-lock-owner-'));
  const file = path.join(dir, 'lock');
  const self = { pid: 300 };
  const table = parsePpidTable(['100 1', '200 100', '300 200'].join('\n'));
  try {
    fs.writeFileSync(file, '100 ' + new Date().toISOString());
    assert.equal(await foreignAcceptanceOwner(file, { pid: self.pid, table }), null, '自己的祖先持锁=正常');
    fs.writeFileSync(file, '999 ' + new Date().toISOString());
    // 999 用自己这个活 pid 顶替（保证 pidAlive 为真），但进程树里不是 300 的祖先
    fs.writeFileSync(file, process.pid + ' ' + new Date().toISOString());
    const foreign = await foreignAcceptanceOwner(file, {
      pid: self.pid,
      table: parsePpidTable(['1 0', String(self.pid) + ' 1', String(process.pid) + ' 1'].join('\n')),
    });
    assert.equal(foreign && foreign.pid, process.pid);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('pidAlive：自己活着，0 和非法值、不存在的 pid 都是死', () => {
  assert.equal(pidAlive(process.pid), true);
  assert.equal(pidAlive(0), false);
  assert.equal(pidAlive(-1), false);
  assert.equal(pidAlive('abc'), false);
  assert.equal(pidAlive(4194303), false);
});
