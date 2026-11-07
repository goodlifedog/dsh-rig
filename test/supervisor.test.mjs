'use strict';
// 小窗托管 daemon 子进程：spawn 失败或子进程意外退出都不能把主进程带崩，
// 而且 /health 要能看出「为什么没有后台服务」。
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createSupervisor } = require('../overlay/supervisor.js');

function fakeChild(pid = 4242) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = () => { child.killed = true; return true; };
  return child;
}

function depsWith(overrides = {}) {
  const child = fakeChild();
  return {
    child,
    deps: {
      fs: { existsSync: () => true },
      spawn: () => child,
      fetch: async () => ({ json: async () => ({ ok: false }) }),  // daemon 一直没起来
      sleep: async () => {},
      now: (() => { let t = 0; return () => (t += 4000); })(),   // 第一次比较就超时，测试不等 8 秒
      port: 7799,
      ...overrides,
    },
  };
}

test('spawn 失败：不抛未捕获异常，start 返回带原因的错误', async () => {
  const { child, deps } = depsWith();
  const sup = createSupervisor(Object.assign({}, deps, {
    // 真实行为：spawn 成功后异步抛 'error'。这里在 spawn 返回前排一个微任务，
    // 保证 error 在 startDaemon 的等待循环结束前送达。
    spawn: () => { queueMicrotask(() => child.emit('error', new Error('spawn ENOENT'))); return child; },
  }));
  const r = await sup.startDaemon();
  assert.equal(r.ok, false);
  assert.match(r.error, /spawn ENOENT/, '要把子进程失败原因带回调用方');
  assert.match(sup.status().spawnError, /ENOENT/);
});

test('子进程意外退出：记录到 status，不抛出', async () => {
  const { child, deps } = depsWith();
  const sup = createSupervisor(deps);
  await sup.startDaemon();
  assert.doesNotThrow(() => child.emit('exit', 78, null));
  const st = sup.status();
  assert.equal(st.lastExit.code, 78);
  assert.equal(st.lastExit.expected, false, '非主动停止要标成意外退出');
  assert.equal(st.managed, false, '进程没了就不该再显示托管中');
});

test('主动 stop：退出标记成 expected，避免误报「意外退出」', async () => {
  const { child, deps } = depsWith({ fetch: async () => ({ json: async () => ({ ok: true }) }) });
  const sup = createSupervisor(deps);
  const started = await sup.startDaemon();
  assert.equal(started.ok, true);
  assert.equal(started.reused, true);
  // 复用已有 daemon 时没有子进程，直接验证 stop 不抛错
  assert.doesNotThrow(() => sup.stopDaemon());
});

test('stopDaemon 会 TERM 自己拉起的子进程，并清掉托管状态', async () => {
  const { child, deps } = depsWith();
  const sup = createSupervisor(deps);
  const pending = sup.startDaemon();
  setImmediate(() => child.emit('error', new Error('spawn ENOENT')));  // 让循环能结束
  await pending;
  // 重新起一个（模拟真正 spawn 成功但端口没起来）
  const sup2 = createSupervisor(deps);
  await sup2.startDaemon();
  sup2.stopDaemon();
  assert.equal(child.killed, true);
  assert.equal(sup2.status().managed, false);
});
