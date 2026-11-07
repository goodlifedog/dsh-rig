'use strict';
// 报告索引：状态看板的「最近验收」不能再被字典序带偏
import test from 'node:test';
import assert from 'node:assert/strict';
import { reportTimestamp, latestReport } from '../core/report-index.mjs';

test('从文件名取时间戳，两种命名都认', () => {
  const a = reportTimestamp('acceptance-2026-11-07T16-20-42-131Z.md');
  const b = reportTimestamp('2026-11-07T16-20-42-131Z-acceptance.md');
  assert.ok(a > 0);
  assert.equal(a, b);
  assert.equal(reportTimestamp('随便一个名字.md'), 0);
});

test('只挑 acceptance 报告，且按时间取最新', () => {
  const files = [
    'acceptance-2026-11-07T16-20-42-131Z.md',
    'acceptance-2026-11-07T16-23-26-478Z.md',
    'app-matrix-2026-11-07T23-59-59-999Z.md',
    'bg-verify-2026-11-07T16-22-00-000Z.md',
  ];
  assert.equal(latestReport(files), 'acceptance-2026-11-07T16-23-26-478Z.md');
  assert.equal(latestReport([]), '');
  assert.equal(latestReport(['a.md']), '');
});

test('没有时间戳的验收报告不会被当成最新', () => {
  const files = ['acceptance-old.md', 'acceptance-2026-11-06T10-00-00-000Z.md'];
  assert.equal(latestReport(files), 'acceptance-2026-11-06T10-00-00-000Z.md');
});
