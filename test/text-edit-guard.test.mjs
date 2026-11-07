'use strict';
// 写文本编辑前的安全判定：只允许往「未命名 + 空」的文稿里写，别覆盖用户内容。
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDocumentList, isSafeToWrite, checkTextEditWritable } from '../core/text-edit-guard.mjs';

test('解析「名字<TAB>长度」输出', () => {
  const out = '未命名\t0\n报告.rtf\t1234\n';
  assert.deepEqual(parseDocumentList(out), [
    { name: '未命名', length: 0 },
    { name: '报告.rtf', length: 1234 },
  ]);
});

test('只有未命名空文稿才允许写', () => {
  assert.equal(isSafeToWrite([{ name: '未命名', length: 0 }]).ok, true);
  assert.equal(isSafeToWrite([{ name: 'Untitled 2', length: 0 }]).ok, true);
});

test('有命名文稿 / 有内容 / 没文稿 一律拒绝', () => {
  assert.equal(isSafeToWrite([{ name: '报告.rtf', length: 0 }]).ok, false);
  assert.equal(isSafeToWrite([{ name: '未命名', length: 42 }]).ok, false);
  assert.equal(isSafeToWrite([]).ok, false);
  assert.equal(isSafeToWrite(null).ok, false);
});

test('读不到文稿状态时按不安全处理', async () => {
  const r = await checkTextEditWritable({ exec: async () => { throw new Error('osascript 失败'); } });
  assert.equal(r.ok, false);
  assert.match(r.reason, /读不到文稿状态/);
});

test('读到空文稿时放行', async () => {
  const r = await checkTextEditWritable({ exec: async () => ({ stdout: '未命名\t0\n' }) });
  assert.equal(r.ok, true);
});
