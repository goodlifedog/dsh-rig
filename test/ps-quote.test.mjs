'use strict';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { psQuote, psLikeContains, hwndExpression } = require('../overlay/ps-quote.js');

test('普通文本包成单引号字符串', () => {
  assert.equal(psQuote('dfs'), "'dfs'");
  assert.equal(psQuote('Google Chrome'), "'Google Chrome'");
});

test('单引号被双写（PowerShell 的单引号字符串规则）', () => {
  assert.equal(psQuote("O'Brien"), "'O''Brien'");
  assert.equal(psQuote("a''b"), "'a''''b'");
});

test('命令注入尝试都被关进字符串里', () => {
  const evil = '$(calc.exe)';
  const quoted = psQuote(evil);
  assert.equal(quoted, "'$(calc.exe)'", '仍然是单引号字符串，$ 不会被解释');
  assert.ok(quoted.startsWith("'") && quoted.endsWith("'"));
  // 不允许出现未闭合的单引号
  const inner = quoted.slice(1, -1);
  assert.equal(inner.replace(/''/g, '').includes("'"), false);
});

test('反引号与双引号在单引号字符串里没有特殊含义', () => {
  assert.equal(psQuote('a`b'), "'a`b'");
  assert.equal(psQuote('a"b'), "'a\"b'");
});

test('like 通配符包裹并转义', () => {
  assert.equal(psLikeContains('计算器'), "'*计算器*'");
  assert.equal(psLikeContains("a'b"), "'*a''b*'");
});

test('窗口句柄表达式', () => {
  assert.equal(hwndExpression(12345), '0x3039');
  assert.equal(hwndExpression('12345'), '0x3039');
  assert.equal(hwndExpression(0), '');
  assert.equal(hwndExpression(null), '');
  assert.equal(hwndExpression('abc'), '');
});

test('null/undefined 不产生 "null" 字样', () => {
  assert.equal(psQuote(null), "''");
  assert.equal(psQuote(undefined), "''");
  assert.equal(psLikeContains(undefined), "'**'");
});
