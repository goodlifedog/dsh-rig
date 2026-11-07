'use strict';
// 读取保护：某些应用一读界面树就会被顶到前台（Ghostty/ChatGPT 实测），必须立刻还原
import test from 'node:test';
import assert from 'node:assert/strict';
import { readSafe, findSafe } from '../core/background.mjs';

// 模拟真实情况：应用在操作过程中把前台抢走，还原成功之后前台就真的回去了
function makeDeps({ tree = 'x'.repeat(80), matches = [], stealOnState = null, stealOnFind = null, stateError = null } = {}) {
  const state = { front: 'DSH' };
  const restored = [];
  const deps = {
    frontName: async () => state.front,
    state: async () => {
      if (stealOnState) state.front = stealOnState;
      if (stateError) throw stateError;
      return tree;
    },
    find: async () => {
      if (stealOnFind) state.front = stealOnFind;
      return matches;
    },
    restoreFront: async (name) => { restored.push(name); state.front = name; return true; },
  };
  return { restored, state, deps };
}

test('读取把前台抢走时：立刻还原，并如实标记', async () => {
  const d = makeDeps({ stealOnState: 'Ghostty' });
  const r = await readSafe('Ghostty', { deps: d.deps });
  assert.equal(r.frontStolen, true);
  assert.deepEqual(d.restored, ['DSH'], '一次读取只该还原一次');
  assert.equal(d.state.front, 'DSH');
  assert.ok(r.text.length > 40);
});

test('读取没有抢前台：不做任何还原', async () => {
  const d = makeDeps();
  const r = await readSafe('备忘录', { deps: d.deps });
  assert.equal(r.frontStolen, false);
  assert.equal(d.restored.length, 0);
});

test('读取抛错也要检查并还原前台', async () => {
  const d = makeDeps({ stealOnState: 'ChatGPT', stateError: new Error('AX 挂了') });
  const r = await readSafe('某应用', { deps: d.deps });
  assert.ok(/AX 挂了/.test(r.error));
  assert.equal(r.frontStolen, true);
  assert.deepEqual(d.restored, ['DSH']);
});

test('可以关闭自动还原（交给上层统一处理）', async () => {
  const d = makeDeps({ stealOnState: 'Ghostty' });
  const r = await readSafe('Ghostty', { deps: d.deps, restore: false });
  assert.equal(r.frontStolen, true);
  assert.equal(d.restored.length, 0);
});

test('查询同样有前台保护', async () => {
  const d = makeDeps({ stealOnFind: 'ChatGPT', matches: [{ index: 1, title: '按钮' }] });
  const r = await findSafe('ChatGPT', { role: 'AXButton' }, { deps: d.deps });
  assert.equal(r.matches.length, 1);
  assert.equal(r.frontStolen, true);
  assert.deepEqual(d.restored, ['DSH'], '查询也只还原一次');
});
