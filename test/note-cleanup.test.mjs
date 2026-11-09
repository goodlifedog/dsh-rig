'use strict';
// H-1：deleteTestNotes 的 top-fallback 必须是显式闸门，默认不得按条数删用户笔记
import test from 'node:test';
import assert from 'node:assert/strict';
import { deleteTestNotes, buildTrashCountScript, buildTrashPurgeScript, purgeRecentlyDeletedNotes, buildMarkedLiveNotesScript, purgeMarkedLiveNotes } from '../core/note-cleanup.mjs';

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

test('最近删除清理：脚本只按测试标记匹配，且带「Recently Deleted」文件夹', () => {
  const count = buildTrashCountScript();
  assert.match(count, /Recently Deleted/);
  assert.match(count, /AGENT-TEST/);
  assert.match(count, /后台控制验证/);
  assert.match(count, /return c as text/);
  const purge = buildTrashPurgeScript();
  assert.match(purge, /delete note id/);
  assert.match(purge, /return removed as text/);
});

test('最近删除清理：默认 dry-run 只数不删；显式 dryRun=false 才删除', async () => {
  const scripts = [];
  const exec = (script) => { scripts.push(script); return '3'; };
  const dry = await purgeRecentlyDeletedNotes({ exec });
  assert.deepEqual(dry, { count: 3, removed: 0, dryRun: true });
  assert.equal(scripts.length, 1);
  scripts.length = 0;
  const run = await purgeRecentlyDeletedNotes({ exec, dryRun: false });
  assert.deepEqual(run, { count: 3, removed: 3, dryRun: false });
  assert.equal(scripts.length, 2);
});

test('最近删除清理：exec 抛错时返回 error，不抛出', async () => {
  const exec = () => { throw new Error('osascript failed'); };
  const r = await purgeRecentlyDeletedNotes({ exec, dryRun: false });
  assert.equal(r.count, 0);
  assert.match(r.error, /osascript failed/);
});

test('活笔记兜底：脚本排除最近删除文件夹并按测试标记匹配', () => {
  const count = buildMarkedLiveNotesScript('count');
  assert.match(count, /AGENT-TEST/);
  assert.match(count, /后台控制验证/);
  assert.match(count, /is not "Recently Deleted"/);
  assert.match(count, /return c as text/);
  const purge = buildMarkedLiveNotesScript('purge');
  assert.match(purge, /delete note id/);
  assert.match(purge, /return removed as text/);
});

test('活笔记兜底：默认 dry-run 只数不删，显式 dryRun=false 才删除', async () => {
  const scripts = [];
  const exec = (script) => { scripts.push(script); return '2'; };
  const dry = await purgeMarkedLiveNotes({ exec });
  assert.deepEqual(dry, { count: 2, removed: 0, dryRun: true });
  assert.equal(scripts.length, 1);
  scripts.length = 0;
  const run = await purgeMarkedLiveNotes({ exec, dryRun: false });
  assert.deepEqual(run, { count: 2, removed: 2, dryRun: false });
  assert.equal(scripts.length, 2);
});
