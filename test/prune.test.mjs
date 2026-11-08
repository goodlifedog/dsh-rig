import test from 'node:test';
import assert from 'node:assert/strict';
import { planPrune } from '../core/prune.mjs';

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
test('验收证据报告不受数量上限影响（删了会把「测过」退回「未测」）', () => {
  const now = Date.now();
  const files = Array.from({ length: 6 }, (_, i) => ({ path: 'reports/app-matrix-2026-01-0' + i + '.json', mtimeMs: now - i * DAY, size: 1 }));
  const plan = planPrune({ files, now, keepDays: 7, keepReports: 2 });
  assert.equal(plan.remove.length, 0, '证据文件即使超过数量上限也要留');
  assert.equal(plan.keep.length, 6);
});

test('验收证据只按天数老化：超过 90 天的才删', () => {
  const now = Date.now();
  const files = [
    { path: 'reports/app-matrix-old.json', mtimeMs: now - 120 * DAY, size: 10 },
    { path: 'reports/app-matrix-new.json', mtimeMs: now - 30 * DAY, size: 10 },
  ];
  const plan = planPrune({ files, now, keepDays: 7, keepReports: 200, keepEvidenceDays: 90 });
  assert.deepEqual(plan.remove.map((f) => f.path), ['reports/app-matrix-old.json']);
});

test('普通报告仍然按数量+天数清理（混在证据里也不受影响）', () => {
  const now = Date.now();
  const files = [
    { path: 'reports/app-matrix-1.json', mtimeMs: now - 1 * DAY, size: 1 },
    { path: 'reports/live-verify-1.md', mtimeMs: now - 1 * DAY, size: 1 },
    { path: 'reports/live-verify-2.md', mtimeMs: now - 2 * DAY, size: 1 },
    { path: 'reports/live-verify-3.md', mtimeMs: now - 3 * DAY, size: 1 },
  ];
  const plan = planPrune({ files, now, keepDays: 7, keepReports: 2 });
  assert.ok(plan.keep.some((f) => f.path === 'reports/app-matrix-1.json'));
  assert.equal(plan.remove.filter((f) => f.path.includes('live-verify')).length, 1);
});
