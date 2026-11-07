'use strict';
// 笔记清理的数据安全：只删"自己新增的条数"，绝不批量删可删行
import test from 'node:test';
import assert from 'node:assert/strict';
import { countNotes, deleteTopNotes, deleteTestNotes, isTestNoteTitle } from '../core/note-cleanup.mjs';

test('countNotes 解析数字，失败返回 -1', async () => {
  assert.equal(await countNotes({ deps: { exec: async () => ({ stdout: '3\n' }) } }), 3);
  assert.equal(await countNotes({ deps: { exec: async () => { throw new Error('boom'); } } }), -1);
});

test('deleteTopNotes：条数为 0 时不执行任何命令', async () => {
  let calls = 0;
  assert.equal(await deleteTopNotes(0, { deps: { exec: async () => { calls += 1; return { stdout: '0' }; } } }), 0);
  assert.equal(calls, 0, '不给条数就不许删');
});

test('deleteTopNotes：把条数传进脚本并解析结果', async () => {
  let seen = '';
  const n = await deleteTopNotes(2, {
    deps: { exec: async (bin, args) => { seen = args.join(' '); return { stdout: '2' }; } },
  });
  assert.equal(n, 2);
  assert.ok(seen.includes('repeat with kk from 1 to 2'), '脚本里应带上明确条数');
});

test('deleteTestNotes 旧名也要求显式条数，默认不删', async () => {
  let calls = 0;
  assert.equal(await deleteTestNotes({ deps: { exec: async () => { calls += 1; return { stdout: '0' }; } } }), 0);
  assert.equal(calls, 0, '没有 count 时不许删');
});

test('测试笔记标题识别仍保留（仅用于日志/自检）', () => {
  assert.equal(isTestNoteTitle('后台控制验证：00:34:11'), true);
  assert.equal(isTestNoteTitle('我自己的笔记'), false);
});
