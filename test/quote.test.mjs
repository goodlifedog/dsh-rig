'use strict';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { appleScriptQuote } = require('../overlay/quote.js');

test('普通名称包成双引号字符串', () => {
  assert.equal(appleScriptQuote('DeepSeek Harness'), '"DeepSeek Harness"');
  assert.equal(appleScriptQuote('计算器'), '"计算器"');
});

test('双引号被转义，不会截断字符串', () => {
  assert.equal(appleScriptQuote('a"b'), '"a\\"b"');
  const quoted = appleScriptQuote('tell application "Finder"');
  assert.equal(quoted, '"tell application \\"Finder\\""');
});

test('反斜杠被转义', () => {
  assert.equal(appleScriptQuote('a\\b'), '"a\\\\b"');
});

test('空值不产生 null 字样', () => {
  assert.equal(appleScriptQuote(null), '""');
  assert.equal(appleScriptQuote(undefined), '""');
});
