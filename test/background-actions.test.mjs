'use strict';
// 次要动作 / 滚动 / 选中文本：都要记录前台是否被抢
import test from 'node:test';
import assert from 'node:assert/strict';
import { secondaryAction, scrollElement, selectTextIn } from '../core/background.mjs';
import { execFileSync } from 'node:child_process';

// 这些封装内部直接用真实 frontName；测试里用 osascript 会慢，改为断言它们调用到了正确的工具参数
function fakeCall(returnValue = { isError: false }) {
  const calls = [];
  const call = async (tool, args) => { calls.push({ tool, args }); return returnValue; };
  return { calls, call };
}

test('次要动作：传给底层的是 perform_secondary_action 与正确参数', async () => {
  const { calls, call } = fakeCall();
  const r = await secondaryAction('备忘录', 1000014, '删除', { call });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].tool, 'perform_secondary_action');
  assert.equal(calls[0].args.action, '删除');
  assert.equal(calls[0].args.element_index, '1000014');
  assert.equal(r.action, '删除');
});

test('次要动作失败时返回错误信息', async () => {
  const { call } = fakeCall({ isError: true, raw: { content: [{ type: 'text', text: 'action not supported' }] } });
  const r = await secondaryAction('某应用', 1, '置顶', { call });
  assert.equal(r.ok, false);
  assert.ok(r.error.length > 0);
});

test('滚动：默认向下翻一页，参数按字符串传给底层', async () => {
  const { calls, call } = fakeCall();
  await scrollElement('访达', { call });
  assert.equal(calls[0].tool, 'scroll');
  assert.equal(calls[0].args.direction, 'down');
  assert.equal(calls[0].args.pages, '1');
});

test('滚动：指定元素与方向', async () => {
  const { calls, call } = fakeCall();
  await scrollElement('文本编辑', { direction: 'up', pages: 3, elementIndex: 42, call });
  assert.equal(calls[0].args.direction, 'up');
  assert.equal(calls[0].args.pages, '3');
  assert.equal(calls[0].args.element_index, '42');
});

test('选中文本：参数透传', async () => {
  const { calls, call } = fakeCall();
  await selectTextIn('文本编辑', { elementIndex: 7, text: '要选中的文字', call });
  assert.equal(calls[0].tool, 'select_text');
  assert.equal(calls[0].args.text, '要选中的文字');
  assert.equal(calls[0].args.element_index, '7');
});

test('底层抛错时不崩溃，返回错误', async () => {
  const call = async () => { throw new Error('AX down'); };
  const r = await secondaryAction('某应用', 1, '删除', { call });
  assert.equal(r.ok, false);
  assert.ok(/AX down/.test(r.error));
});
