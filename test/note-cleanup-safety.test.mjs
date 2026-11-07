'use strict';
// 笔记清理的数据安全：只删"自己新增的条数"，绝不批量删可删行
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  countNotes,
  deleteTopNotes,
  deleteTestNotes,
  deleteMarkedTestNotes,
  buildMarkedDeleteScript,
  buildWordListLiteral,
  pickDeletableLabels,
  isTestNoteTitle,
  TEST_NOTE_MARKER,
  LEGACY_TEST_WORDS,
} from '../core/note-cleanup.mjs';

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

test('新标记：写的时候带 [AGENT-TEST]，清理只认它和历史测试词', () => {
  assert.equal(TEST_NOTE_MARKER, '[AGENT-TEST]');
  assert.equal(isTestNoteTitle('[AGENT-TEST] 后台控制验证：12:00'), true);
  assert.equal(isTestNoteTitle('  [ agent-test ] 小写也行'), true);
  assert.equal(isTestNoteTitle('我的会议记录'), false);
  assert.equal(isTestNoteTitle(''), false);
});

test('按行标签挑要删的：默认只认 [AGENT-TEST]，历史测试词要显式传入', () => {
  const labels = ['[AGENT-TEST] 后台控制验证', '用户自己的笔记', '后台写入：x', '', 'pta 测试 1'];
  assert.deepEqual(pickDeletableLabels(labels), ['[AGENT-TEST] 后台控制验证'], '默认不许碰历史词');
  assert.deepEqual(pickDeletableLabels(labels, { words: ['[AGENT-TEST]', ...LEGACY_TEST_WORDS] }),
    ['[AGENT-TEST] 后台控制验证', '后台写入：x', 'pta 测试 1']);
  // 只放历史词：带标记那条的文本里也含历史词，所以也会命中
  assert.deepEqual(pickDeletableLabels(labels, { words: LEGACY_TEST_WORDS }), ['[AGENT-TEST] 后台控制验证', '后台写入：x', 'pta 测试 1']);
  assert.deepEqual(pickDeletableLabels(labels, { limit: 1, words: ['[AGENT-TEST]', ...LEGACY_TEST_WORDS] }), ['[AGENT-TEST] 后台控制验证']);
  assert.deepEqual(pickDeletableLabels(['用户笔记']), []);
  assert.deepEqual(pickDeletableLabels(null), []);
});

test('删除脚本：带上条数与命中词；危险字面量塞不进脚本', () => {
  const script = buildMarkedDeleteScript(3);
  assert.ok(script.includes('repeat with kk from 1 to 3'));
  assert.ok(script.includes('"[AGENT-TEST]"'));
  assert.ok(!script.includes('后台控制验证'), '历史测试词默认不该进删除脚本');
  assert.ok(buildMarkedDeleteScript(1, LEGACY_TEST_WORDS).includes('后台控制验证'), '显式传历史词才允许');
  // 含引号/反斜杠/换行的词直接丢弃，不会破坏脚本结构
  const injected = buildWordListLiteral(['ok', 'a"b', 'c\\d', 'e\nf']);
  assert.equal(injected, '{"ok"}');
});

test('生成的删除脚本能通过 AppleScript 编译（保留字/语法错会导致静默退回）', () => {
  if (process.platform !== 'darwin') return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notes-script-'));
  try {
    const src = path.join(dir, 'script.applescript');
    const out = path.join(dir, 'out.scpt');
    fs.writeFileSync(src, buildMarkedDeleteScript(2));
    // 实测踩过：循环变量叫 st / word 会撞 AppleScript 保留字，编译期才报错——
    // 而运行期是「命令失败 → 退回旧策略」，很难发现。所以把编译检查放进测试。
    execFileSync('/usr/bin/osacompile', ['-o', out, src], { timeout: 20000, stdio: 'ignore' });
    assert.equal(fs.existsSync(out), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('按标记删除：解析 removed/readable；条数为 0 不执行', async () => {
  assert.deepEqual(await deleteMarkedTestNotes(0, { deps: { exec: async () => { throw new Error('不该执行'); } } }),
    { removed: 0, readable: 0, attempted: false });
  const r = await deleteMarkedTestNotes(2, { deps: { exec: async () => ({ stdout: 'removed=1 readable=5\n' }) } });
  assert.deepEqual(r, { removed: 1, readable: 5, attempted: true });
  // 传 words 时要体现在脚本里（--force-all 的放宽路径）
  let seen = '';
  await deleteMarkedTestNotes(1, {
    words: LEGACY_TEST_WORDS,
    deps: { exec: async (bin, args) => { seen = args.join(' '); return { stdout: 'removed=0 readable=3' }; } },
  });
  assert.ok(seen.includes('后台控制验证'), '显式放宽词必须进脚本');
});

test('deleteTestNotes 优先按标记删；标题读不到才退回 count-delta', async () => {
  const calls = [];
  const byMarker = await deleteTestNotes({
    count: 2,
    deps: {
      exec: async (bin, args) => {
        calls.push(args.join(' '));
        return { stdout: 'removed=2 readable=7' };
      },
    },
  });
  assert.equal(byMarker, 2);
  assert.equal(calls.length, 1, '标题可读时不该再走按条数删');

  const fallbackCalls = [];
  const fallback = await deleteTestNotes({
    count: 1,
    deps: {
      exec: async (bin, args) => {
        fallbackCalls.push(args.join(' '));
        return { stdout: fallbackCalls.length === 1 ? 'removed=0 readable=0' : '1' };
      },
      sleep: async () => {},
    },
  });
  assert.equal(fallback, 1, '标题读不到要退回旧策略，别一条都删不掉');
  assert.equal(fallbackCalls.length, 2);
  assert.ok(fallbackCalls[1].includes('repeat with kk from 1 to 1'));
});
