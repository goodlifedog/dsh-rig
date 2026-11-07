'use strict';
// CDP 通道验证的结论不能只看「前台有没有被抢」：一次都没连上也报成功就是假绿
import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeCdpRows } from '../core/tasks/cdp-driver.mjs';

test('全部连不上：判失败并写清原因', () => {
  const v = summarizeCdpRows([
    { status: 'cdp-unavailable', frontUnchanged: true },
    { status: 'cdp-unavailable', frontUnchanged: true },
  ]);
  assert.equal(v.ok, false);
  assert.equal(v.attempted, 2);
  assert.equal(v.cdpOk, 0);
  assert.match(v.problem, /一次 CDP 都没连上/);
});

test('至少一个连上就算通道可用', () => {
  const v = summarizeCdpRows([
    { status: 'cdp-ok', frontUnchanged: true },
    { status: 'cdp-unavailable', frontUnchanged: true },
  ]);
  assert.equal(v.ok, true);
  assert.equal(v.cdpOk, 1);
  assert.equal(v.problem, '');
});

test('前台被抢占一律失败，哪怕连上了', () => {
  const v = summarizeCdpRows([{ status: 'cdp-ok', frontUnchanged: false }]);
  assert.equal(v.ok, false);
  assert.match(v.problem, /前台/);
});

test('全部 skipped-running：没验证但不算失败', () => {
  const v = summarizeCdpRows([
    { status: 'skipped-running', frontUnchanged: true },
    { status: 'skipped-running', frontUnchanged: true },
  ]);
  assert.equal(v.ok, true);
  assert.equal(v.attempted, 0);
  assert.equal(v.skippedRunning, 2);
});

test('空输入/异常输入安全', () => {
  assert.equal(summarizeCdpRows([]).ok, true);
  assert.equal(summarizeCdpRows(null).ok, true);
  assert.doesNotThrow(() => summarizeCdpRows([null, undefined]));
});
