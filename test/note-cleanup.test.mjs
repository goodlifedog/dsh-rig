'use strict';
// H-1：deleteTestNotes 的 top-fallback 必须是显式闸门，默认不得按条数删用户笔记
import test from 'node:test';
import assert from 'node:assert/strict';
import { deleteTestNotes } from '../core/note-cleanup.mjs';

// 单测用假探测：默认已授权，绝不发真实 AppleEvent（真实预检走 AEDeterminePermissionToAutomateTarget）
const granted = async () => ({ status: 'granted' });

function makeDeps(script) {
  const calls = [];
  const deps = {
    checkAutomationPermission: granted,
    sleep: async () => {},
    exec: async (bin, args) => {
      calls.push(args.join(' '));
      return { stdout: script(calls.length) };
    },
  };
  return { calls, deps };
}

test('H-1: readable=0 + 默认 → 不删，且不执行 top-fallback', async () => {
  const { calls, deps } = makeDeps(() => 'removed=0 readable=0');
  const removed = await deleteTestNotes({ count: 2, deps });
  assert.equal(removed, 0, '标题读不到时默认必须 fail-closed，返回 0');
  assert.equal(calls.length, 1, '只允许执行一次按标记删除');
  // 按标记删除脚本包含 rowLabel 处理器；按条数删的 top 脚本没有，用它区分两条路径
  assert.ok(calls[0].includes('rowLabel'), '默认路径执行的应是按标记删除脚本');
  assert.equal(calls.filter((c) => !c.includes('rowLabel')).length, 0, '默认路径不能出现按条数删的脚本');
});

test('H-1: readable=0 + allowTopFallback=true → 允许退回 count-delta', async () => {
  const { calls, deps } = makeDeps((n) => (n === 1 ? 'removed=0 readable=0' : '1'));
  const removed = await deleteTestNotes({ count: 1, allowTopFallback: true, deps });
  assert.equal(removed, 1, '显式放开后要能退回旧策略');
  assert.equal(calls.length, 2);
  assert.ok(calls[1].includes('repeat with kk from 1 to 1'), '第二次调用应是要删 1 条的脚本');
  assert.ok(!calls[1].includes('rowLabel'), '第二次调用应是 top 删除脚本，不是按标记删除');
});

test('H-1: readable>0 → 行为不变，只按标记删', async () => {
  const { calls, deps } = makeDeps(() => 'removed=1 readable=5');
  const removed = await deleteTestNotes({ count: 2, deps });
  assert.equal(removed, 1);
  assert.equal(calls.length, 1, '标题可读时不该走按条数删');
  assert.ok(calls[0].includes('[AGENT-TEST]'), '按标记删的脚本必须带测试标记');
});

test('H-1: allowTopFallback 只认严格 true，truthy 字符串不放行', async () => {
  const { calls, deps } = makeDeps(() => 'removed=0 readable=0');
  const removed = await deleteTestNotes({ count: 1, allowTopFallback: 'true', deps });
  assert.equal(removed, 0, '非布尔 true 不许放行');
  assert.equal(calls.length, 1);
});
