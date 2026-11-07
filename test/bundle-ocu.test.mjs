'use strict';
// 随包第三方声明：要能说清「发出去的到底是哪一份运行时」。
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildNotice } from '../scripts/bundle-ocu.mjs';

const pkg = { version: '1.2.3', license: 'MIT', repository: { url: 'https://example.com/ocu' } };

test('不含运行时：只列许可与声明', () => {
  const md = buildNotice(pkg, { withBinary: false });
  assert.match(md, /open-computer-use 1.2.3/);
  assert.match(md, /未包含运行时/);
  assert.doesNotMatch(md, /sha256/);
});

test('含运行时：必须写主二进制 sha256', () => {
  const md = buildNotice(pkg, { withBinary: true, sha256: 'a'.repeat(64) });
  assert.match(md, /主二进制 sha256：a{64}/);
  assert.doesNotMatch(md, /未包含运行时/);
});

test('取不到哈希时明确写「未取到」，不静默留空', () => {
  const md = buildNotice(pkg, { withBinary: true, sha256: '' });
  assert.match(md, /未取到/);
});
