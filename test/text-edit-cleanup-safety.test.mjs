'use strict';
// 清理文稿的判定：宁可留着测试稿，也不能把用户草稿 saving no 掉。
import test from 'node:test';
import assert from 'node:assert/strict';
import { isDisposableTestDocument } from '../core/text-edit-guard.mjs';

test('未命名 + 我们写的标记 → 可以关', () => {
  const r = isDisposableTestDocument({ name: '未命名', text: '[AGENT-TEST] 后台控制验证：12:00' });
  assert.equal(r.ok, true);
});

test('未命名 + 带时间的固定句式 → 可以关', () => {
  assert.equal(isDisposableTestDocument({ name: 'Untitled', text: '后台写入：10:30:01' }).ok, true);
  assert.equal(isDisposableTestDocument({ name: '未命名文稿', text: '后台控制验证：10:30' }).ok, true);
});

test('用户自己命名的文稿 → 绝不关（哪怕正文就是测试格式）', () => {
  const r = isDisposableTestDocument({ name: '会议记录.txt', text: '[AGENT-TEST] 后台控制验证' });
  assert.equal(r.ok, false);
  assert.match(r.reason, /命名文稿/);
});

test('未命名草稿里只是「包含」这些词 → 不关（以前会丢数据）', () => {
  const r = isDisposableTestDocument({ name: '未命名', text: '我和同事讨论后台测试的方案，后面还要补后台写入的流程' });
  assert.equal(r.ok, false);
  assert.match(r.reason, /不是测试格式/);
});

test('未命名空文稿 → 不关（可能是用户刚打开的）', () => {
  const r = isDisposableTestDocument({ name: '未命名', text: '' });
  assert.equal(r.ok, false);
  assert.match(r.reason, /空文稿/);
});

test('读不到文稿名 / 缺字段 → 不关', () => {
  assert.equal(isDisposableTestDocument({}).ok, false);
  assert.equal(isDisposableTestDocument({ name: '', text: '[AGENT-TEST]' }).ok, false);
  assert.equal(isDisposableTestDocument(null).ok, false);
});
