'use strict';
// 小窗崩溃记录：/health 里那条 crash 的来源，字段截断和"只留最后一条"都要钉住
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createCrashLog, shouldReloadAfterCrash } = require('../overlay/crash-log.js');

test('初始为空；记录后能取到最后一次', () => {
  const log = createCrashLog({ now: () => '2026-01-01T00:00:00.000Z' });
  assert.equal(log.get(), null);
  const first = log.note('render-process-gone', 'crashed/11');
  assert.deepEqual(first, { kind: 'render-process-gone', detail: 'crashed/11', at: '2026-01-01T00:00:00.000Z' });
  log.note('child-process-gone', 'GPU/oom');
  assert.equal(log.get().kind, 'child-process-gone', '只保留最近一条，避免无限增长');
});

test('超长 detail 截断，空值有兜底', () => {
  const log = createCrashLog({ now: () => 't', maxDetail: 10 });
  assert.equal(log.note('x', 'a'.repeat(100)).detail.length, 10);
  assert.equal(log.note(null, null).kind, 'unknown');
  assert.equal(log.get().detail, '');
});

test('崩溃重载有次数上限：时间窗内崩太多次就停手', () => {
  const now = 1_700_000_000_000;
  assert.equal(shouldReloadAfterCrash([now - 5000], now).reload, true);
  assert.equal(shouldReloadAfterCrash([now - 5000, now - 3000], now).reload, true);
  const third = shouldReloadAfterCrash([now - 5000, now - 3000, now - 1000], now);
  assert.equal(third.reload, false, '窗内第 3 次就应该停，避免崩溃循环');
  assert.match(third.reason, /循环/);
  // 窗口外的旧崩溃不算
  assert.equal(shouldReloadAfterCrash([now - 120000, now - 110000, now - 100000], now).reload, true);
  // 非法输入不抛错
  assert.doesNotThrow(() => shouldReloadAfterCrash(null, now));
  assert.equal(shouldReloadAfterCrash(null, now).reload, true);
});

test('异常输入不抛错（崩溃处理本身不能把进程搞崩）', () => {
  const log = createCrashLog();
  assert.doesNotThrow(() => log.note(undefined, undefined));
  assert.doesNotThrow(() => log.note({}, Symbol('x')));
  assert.ok(log.get());
});
