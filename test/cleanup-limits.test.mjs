'use strict';
// L4：清理脚本「按条数删顶部 N 条」的硬上限判定（纯函数，不接触系统）
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_CLEANUP_MAX_TOP,
  resolveMaxTop,
  resolveTopDelete,
} from '../core/cleanup-limits.mjs';

test('默认硬上限是 5', () => {
  assert.equal(DEFAULT_CLEANUP_MAX_TOP, 5);
  assert.equal(resolveTopDelete({ requested: 6 }).limit, 5);
  assert.equal(resolveTopDelete({ requested: 6 }).allowed, false);
});

test('resolveMaxTop：正常值取整；非法值回退默认', () => {
  assert.equal(resolveMaxTop('3'), 3);
  assert.equal(resolveMaxTop(8), 8);
  assert.equal(resolveMaxTop('0'), 0);
  assert.equal(resolveMaxTop(undefined), 5);
  assert.equal(resolveMaxTop('abc'), 5);
  assert.equal(resolveMaxTop(-2), 5);
  assert.equal(resolveMaxTop('2.9'), 2);
});

test('N 未超过上限：允许，按 N 条删', () => {
  const r = resolveTopDelete({ requested: 3, noteTotal: 40, maxTop: 5 });
  assert.equal(r.allowed, true);
  assert.equal(r.count, 3);
  assert.equal(r.requested, 3);
  assert.equal(r.noteTotal, 40);
  assert.equal(r.limit, 5);
  assert.match(r.reason, /未超过上限/);
});

test('N 等于上限：边界允许', () => {
  const r = resolveTopDelete({ requested: 5, noteTotal: 40, maxTop: 5 });
  assert.equal(r.allowed, true);
  assert.equal(r.count, 5);
});

test('N 超过上限且未显式放开：拒绝执行，不删任何条', () => {
  const r = resolveTopDelete({ requested: 40, noteTotal: 40, maxTop: 5 });
  assert.equal(r.allowed, false);
  assert.equal(r.count, 0, '拒绝时绝不能给出可删除条数');
  assert.equal(r.limit, 5);
  assert.equal(r.noteTotal, 40);
  assert.match(r.reason, /超过硬上限/);
  assert.match(r.reason, /CLEANUP_ALLOW_LARGE/);
});

test('CLEANUP_ALLOW_LARGE=1 显式放开：允许并写清条数与原因', () => {
  const r = resolveTopDelete({ requested: 40, noteTotal: 40, maxTop: 5, allowLarge: true });
  assert.equal(r.allowed, true);
  assert.equal(r.count, 40);
  assert.match(r.reason, /CLEANUP_ALLOW_LARGE=1/);
  assert.match(r.reason, /40/, '原因里要写清将删多少条');
  assert.match(r.reason, /上限 5/, '原因里要写清上限');
});

test('allowLarge 只认严格布尔 true，字符串不放行', () => {
  const r = resolveTopDelete({ requested: 40, noteTotal: 40, maxTop: 5, allowLarge: 'true' });
  assert.equal(r.allowed, false);
  assert.equal(r.count, 0);
});

test('N 为 0 / 负数 / 非数字：不删除', () => {
  for (const requested of [0, -3, 'abc', NaN, undefined, null]) {
    const r = resolveTopDelete({ requested, noteTotal: 10, maxTop: 5 });
    assert.equal(r.allowed, false, 'requested=' + String(requested));
    assert.equal(r.count, 0, 'requested=' + String(requested));
  }
});

test('上限可配置为 0：任何按条数删除都被拒绝', () => {
  const r = resolveTopDelete({ requested: 1, noteTotal: 10, maxTop: 0 });
  assert.equal(r.allowed, false);
  assert.equal(r.count, 0);
  assert.equal(r.limit, 0);
});

test('noteTotal 缺失也安全（只影响报告字段）', () => {
  const r = resolveTopDelete({ requested: 2, maxTop: 5 });
  assert.equal(r.allowed, true);
  assert.equal(r.count, 2);
  assert.equal(r.noteTotal, 0);
});
