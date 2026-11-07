'use strict';
// 清理：日志按天数、报告按数量，只挑对的、不误删
import test from 'node:test';
import assert from 'node:assert/strict';
import { selectStaleLogs, selectExcessReports, isPrunablePath, logTimestamp } from '../core/prune.mjs';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-11-08T00:00:00Z');

test('日志时间戳解析', () => {
  assert.ok(logTimestamp('2026-11-07T16-25-26-514Z-foo.jsonl') > 0);
  assert.equal(logTimestamp('foo.jsonl'), 0);
});

test('过期日志：只挑早于 cutoff 的，取不到时间戳用 mtime', () => {
  const files = [
    { name: '2026-11-07T16-25-26-514Z-new.jsonl', mtimeMs: 0 },
    { name: '2026-10-01T10-00-00-000Z-old.jsonl', mtimeMs: 0 },
    { name: 'no-timestamp.jsonl', mtimeMs: NOW - 30 * DAY },
    { name: 'no-timestamp-new.jsonl', mtimeMs: NOW - 1 * DAY },
  ];
  const out = selectStaleLogs(files, { now: NOW, days: 7 });
  assert.deepEqual(out.sort(), ['2026-10-01T10-00-00-000Z-old.jsonl', 'no-timestamp.jsonl']);
});

test('报告数量：保留最新 keep 份，删更早的', () => {
  const files = [
    { name: 'acceptance-2026-11-01T00-00-00-000Z.md', mtimeMs: 0 },
    { name: 'acceptance-2026-11-02T00-00-00-000Z.md', mtimeMs: 0 },
    { name: 'acceptance-2026-11-03T00-00-00-000Z.md', mtimeMs: 0 },
  ];
  assert.deepEqual(selectExcessReports(files, { keep: 2 }), ['acceptance-2026-11-01T00-00-00-000Z.md']);
  assert.deepEqual(selectExcessReports(files, { keep: 5 }), []);
});

test('只允许删 logs/ 与 reports/ 下的文件', () => {
  assert.equal(isPrunablePath('/x/logs/runs/a.jsonl', ['/x/logs', '/x/reports']), true);
  assert.equal(isPrunablePath('/x/reports/a.md', ['/x/logs', '/x/reports']), true);
  assert.equal(isPrunablePath('/x/core/daemon.mjs', ['/x/logs', '/x/reports']), false);
});
