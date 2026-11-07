'use strict';
// 验收汇总口径：分母是总项数，跳过与失败分开——写错会让人误读「只跑了 11 项」
import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeResults } from '../core/acceptance.mjs';

test('13 项里 11 通过 2 跳过：显示总项数，不算失败', () => {
  const results = [];
  for (let i = 0; i < 11; i += 1) results.push({ ok: true, skipped: false });
  for (let i = 0; i < 2; i += 1) results.push({ ok: true, skipped: true });
  const s = summarizeResults(results);
  assert.deepEqual(s, { total: 13, passed: 11, skipped: 2, failed: 0, ok: true });
});

test('有失败时 ok=false，数量分开统计', () => {
  const s = summarizeResults([
    { ok: true },
    { ok: true, skipped: true },
    { ok: false },
  ]);
  assert.equal(s.total, 3);
  assert.equal(s.passed, 1);
  assert.equal(s.skipped, 1);
  assert.equal(s.failed, 1);
  assert.equal(s.ok, false);
});

test('空输入 / 异常输入不抛错', () => {
  assert.deepEqual(summarizeResults([]), { total: 0, passed: 0, skipped: 0, failed: 0, ok: true });
  assert.doesNotThrow(() => summarizeResults(null));
  assert.equal(summarizeResults([null, undefined]).total, 2);
});
