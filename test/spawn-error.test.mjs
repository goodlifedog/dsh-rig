'use strict';
// spawn 失败的统一收口：子进程 'error' 事件必须有监听，否则会以未捕获异常带走主进程
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { attachSpawnError } from '../core/safety.mjs';

test('挂上监听后，spawn 失败会被回调，而不是变成未捕获异常', () => {
  const child = new EventEmitter();
  let got = '';
  attachSpawnError(child, (error) => { got = error.message; });
  assert.doesNotThrow(() => child.emit('error', new Error('spawn ENOENT')));
  assert.equal(got, 'spawn ENOENT');
});

test('只处理第一次，但监听保留：后续 error 不会变成未捕获异常', () => {
  const child = new EventEmitter();
  let calls = 0;
  const detach = attachSpawnError(child, () => { calls += 1; });
  child.emit('error', new Error('x'));
  assert.doesNotThrow(() => child.emit('error', new Error('y')), '第二次 error 也不能炸');
  assert.equal(calls, 1, '只把第一次启动失败交给调用方，避免重复处理');
  detach();
  assert.equal(child.listenerCount('error'), 0, '取消后监听要真的摘掉');
});

test('回调里自己抛错也不能把进程带崩', () => {
  const child = new EventEmitter();
  attachSpawnError(child, () => { throw new Error('回调炸了'); });
  assert.doesNotThrow(() => child.emit('error', new Error('spawn error')));
});

test('异常输入安全：没有 on/once 的对象直接忽略', () => {
  assert.doesNotThrow(() => attachSpawnError(null, () => {}));
  assert.doesNotThrow(() => attachSpawnError({}, () => {}));
  assert.equal(typeof attachSpawnError({}, () => {}), 'function');
});
