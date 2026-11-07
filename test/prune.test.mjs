import test from 'node:test';
import assert from 'node:assert/strict';
import { planPrune } from '../scripts/prune.mjs';

const DAY = 24 * 60 * 60 * 1000;

test('超过保留天数的文件会被清理', () => {
  const now = Date.now();
  const files = [
    { path: 'fresh', mtimeMs: now - 1 * DAY, size: 10 },
    { path: 'old', mtimeMs: now - 30 * DAY, size: 20 },
  ];
  const plan = planPrune({ files, now, keepDays: 7, keepReports: 10 });
  assert.deepEqual(plan.remove.map((f) => f.path), ['old']);
  assert.equal(plan.bytes, 20);
});

test('数量上限优先保留最新，不会因为总量小而全留', () => {
  const now = Date.now();
  const files = Array.from({ length: 15 }, (_, i) => ({ path: 'f' + i, mtimeMs: now - i * 1000, size: 1 }));
  const plan = planPrune({ files, now, keepDays: 365, keepReports: 10 });
  assert.equal(plan.keep.length, 10);
  assert.equal(plan.remove.length, 5);
  assert.ok(plan.keep.every((f) => Number(f.path.slice(1)) < 10), '保留的应该是最新的 10 个');
});
