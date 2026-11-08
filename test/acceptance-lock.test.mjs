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
  unlockedAllowed,
} from '../core/acceptance-lock.mjs';
import { acceptanceLockFailureMessage } from '../core/acceptance.mjs';

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

// ---------- 写锁失败：默认 fail-closed（M-3） ----------
// 旧行为是「拿不到锁就 warning + 按未加锁继续」，两个验收可能同时跑、一起切窗口。
// 现在只有显式 AGENT_ALLOW_UNLOCKED=1 才降级，默认直接拒绝。

/** 可注入的 fs 桩：委托真实 fs，按需覆盖某一步，用来模拟 EACCES/ENOSPC 这类真实磁盘错误 */
function stubFs(overrides = {}) {
  return {
    existsSync: (p) => fs.existsSync(p),
    readFileSync: (p, enc) => fs.readFileSync(p, enc),
    statSync: (p) => fs.statSync(p),
    unlinkSync: (p) => fs.unlinkSync(p),
    mkdirSync: (p, o) => fs.mkdirSync(p, o),
    writeFileSync: (p, d) => fs.writeFileSync(p, d),
    linkSync: (a, b) => fs.linkSync(a, b),
    ...overrides,
  };
}

function fsError(code, file) {
  const e = new Error(code + ': 模拟写锁失败, ' + (file || 'lock'));
  e.code = code;
  return e;
}

test('写锁报 EACCES：默认 fail-closed，返回 ok:false 而不是「未加锁继续」', () => {
  const file = fileFor('eacces');
  const r = acquireLock(file, {
    pid: 4321,
    env: {},   // 显式空环境：不受外部 AGENT_ALLOW_UNLOCKED 影响
    fs: stubFs({ writeFileSync: () => { throw fsError('EACCES', file); } }),
  });
  assert.equal(r.ok, false, '写锁失败不能再当成成功继续');
  assert.equal(r.reason, 'lock-unwritable');
  assert.match(r.error, /EACCES/, '错误里要带真实原因，方便排障');
  assert.match(r.error, /fail-closed/);
  assert.equal(r.warning, undefined, '失败时不该再给「继续跑」的 warning');
  assert.equal(fs.existsSync(file), false, '没写成功就不该有锁文件');
});

test('写锁报 ENOSPC（磁盘满）：同样 fail-closed', () => {
  const file = fileFor('enospc');
  const r = acquireLock(file, {
    pid: 4322,
    env: {},
    fs: stubFs({ writeFileSync: () => { throw fsError('ENOSPC', file); } }),
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'lock-unwritable');
  assert.match(r.error, /ENOSPC/);
});

test('写锁第一步（建目录）就 EACCES：同样 fail-closed', () => {
  const file = fileFor('mkdir-eacces');
  const r = acquireLock(file, {
    pid: 4327,
    env: {},
    fs: stubFs({ mkdirSync: () => { throw fsError('EACCES', file); } }),
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'lock-unwritable');
  assert.match(r.error, /EACCES/);
});

test('link 报非 EEXIST 的错误（EACCES）：不能当成并发继续，要 fail-closed', () => {
  const file = fileFor('link-eacces');
  const r = acquireLock(file, {
    pid: 4328,
    env: {},
    fs: stubFs({ linkSync: () => { throw fsError('EACCES', file); } }),
  });
  assert.equal(r.ok, false, 'EACCES 不是并发，不能走 continue 重试');
  assert.equal(r.reason, 'lock-unwritable');
  assert.match(r.error, /EACCES/);
});

test('AGENT_ALLOW_UNLOCKED=1 不能把「并发」也放成未加锁', () => {
  const file = fileFor('unlocked-vs-busy');
  const owner = 4242;
  const r = acquireLock(file, {
    pid: 4243,
    env: { AGENT_ALLOW_UNLOCKED: '1' },
    alive: (pid) => pid === owner,
    fs: stubFs({
      linkSync: () => {
        fs.writeFileSync(file, owner + ' ' + new Date().toISOString());
        throw fsError('EEXIST', file);
      },
    }),
  });
  assert.equal(r.ok, false, '有人持锁时，放行开关也不该让它跑');
  assert.equal(r.reason, 'busy');
  assert.equal(r.pid, owner);
  assert.equal(r.unlocked, undefined);
});

test('显式 AGENT_ALLOW_UNLOCKED=1：才降级为未加锁继续，并给出警告', () => {
  const file = fileFor('unlocked-optin');
  const r = acquireLock(file, {
    pid: 4323,
    env: { AGENT_ALLOW_UNLOCKED: '1' },
    fs: stubFs({ writeFileSync: () => { throw fsError('EACCES', file); } }),
  });
  assert.equal(r.ok, true);
  assert.equal(r.unlocked, true, '必须标记出这次是未加锁跑的');
  assert.match(r.warning, /AGENT_ALLOW_UNLOCKED/, '警告要说清是显式放行的');
  assert.match(r.warning, /未加锁/);
});

test('AGENT_ALLOW_UNLOCKED 真实环境变量生效（设置后恢复）', () => {
  const file = fileFor('unlocked-real-env');
  const old = process.env.AGENT_ALLOW_UNLOCKED;
  try {
    process.env.AGENT_ALLOW_UNLOCKED = '1';
    const r = acquireLock(file, {
      pid: 4324,
      fs: stubFs({ writeFileSync: () => { throw fsError('EACCES', file); } }),
    });
    assert.equal(r.ok, true);
    assert.equal(r.unlocked, true);
  } finally {
    if (old === undefined) delete process.env.AGENT_ALLOW_UNLOCKED;
    else process.env.AGENT_ALLOW_UNLOCKED = old;
  }
});

test('AGENT_ALLOW_UNLOCKED 只认 "1"：0/true/空 都不放行', () => {
  assert.equal(unlockedAllowed({ AGENT_ALLOW_UNLOCKED: '1' }), true);
  assert.equal(unlockedAllowed({ AGENT_ALLOW_UNLOCKED: '0' }), false);
  assert.equal(unlockedAllowed({ AGENT_ALLOW_UNLOCKED: 'true' }), false);
  assert.equal(unlockedAllowed({ AGENT_ALLOW_UNLOCKED: '' }), false);
  assert.equal(unlockedAllowed({}), false);
  assert.equal(unlockedAllowed(null), false);
});

test('EEXIST 且锁已存在：仍按原并发逻辑判 busy，不误报成锁写失败', () => {
  const file = fileFor('eexist-busy');
  const owner = 4242;
  let linked = 0;
  const r = acquireLock(file, {
    pid: 4243,
    env: {},
    alive: (pid) => pid === owner,
    // 模拟「抢的瞬间别人刚把锁写上」：link 抛 EEXIST，同时锁文件真的存在了
    fs: stubFs({
      linkSync: () => {
        linked += 1;
        fs.writeFileSync(file, owner + ' ' + new Date().toISOString());
        throw fsError('EEXIST', file);
      },
    }),
  });
  assert.ok(linked >= 1, '应该走到 link 这一步');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'busy', 'EEXIST + 锁存在 = 并发，不是锁坏');
  assert.equal(r.pid, owner);
});

test('父路径是普通文件（ENOTDIR）：fail-closed，不再 warning 继续', () => {
  const parent = path.join(dir, 'not-a-dir');
  fs.writeFileSync(parent, 'x');   // 父路径是个文件：建目录/写临时文件都会失败
  const r = acquireLock(path.join(parent, 'lock'), { pid: 4325, env: {} });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'lock-unwritable');
  assert.match(r.error, /拿不到验收锁/);
});

test('父路径异常 + AGENT_ALLOW_UNLOCKED=1：降级为 warning 继续（应急口子）', () => {
  const parent = path.join(dir, 'not-a-dir-optin');
  fs.writeFileSync(parent, 'x');
  const r = acquireLock(path.join(parent, 'lock'), { pid: 4326, env: { AGENT_ALLOW_UNLOCKED: '1' } });
  assert.equal(r.ok, true);
  assert.equal(r.unlocked, true);
  assert.ok(r.warning && r.warning.length > 0);
});

test('验收启动时锁失败的原因要分得清：busy 是让路，写锁失败是环境异常', () => {
  assert.match(acceptanceLockFailureMessage({ ok: false, reason: 'busy', pid: 4242 }), /另一个验收正在进行.*4242/);
  assert.match(acceptanceLockFailureMessage({ ok: false, reason: 'busy', pid: 0 }), /刚被另一个进程创建/);
  const m = acceptanceLockFailureMessage({ ok: false, reason: 'lock-unwritable', error: '拿不到验收锁（EACCES）' });
  assert.match(m, /fail-closed/);
  assert.match(m, /EACCES/);
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
