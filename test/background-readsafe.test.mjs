'use strict';
// 读取保护：某些应用一读界面树就会被顶到前台（Ghostty/ChatGPT 实测），必须立刻还原
import test from 'node:test';
import assert from 'node:assert/strict';
import { readSafe, findSafe } from '../core/background.mjs';

function deps({ fronts = [], tree = 'x'.repeat(80), matches = [] } = {}) {
  let i = 0;
  const restored = [];
  return {
    restored,
    deps: {
      frontName: async () => { const v = fronts[Math.min(i, fronts.length - 1)]; i += 1; return v; },
      state: async () => tree,
      find: async () => matches,
      restoreFront: async (name) => { restored.push(name); return true; },
    },
  };
}

test('读取把前台抢走时：立刻还原，并如实标记', async () => {
  const d = deps({ fronts: ['DSH', 'Ghostty'] });
  const r = await readSafe('Ghostty', { deps: d.deps });
  assert.equal(r.frontStolen, true);
  assert.deepEqual(d.restored, ['DSH']);
  assert.ok(r.text.length > 40);
});

test('读取没有抢前台：不做任何还原', async () => {
  const d = deps({ fronts: ['DSH', 'DSH'] });
  const r = await readSafe('备忘录', { deps: d.deps });
  assert.equal(r.frontStolen, false);
  assert.equal(d.restored.length, 0);
});

test('读取抛错也要检查并还原前台', async () => {
  const restored = [];
  const r = await readSafe('某应用', {
    deps: {
      frontName: (() => { let i = 0; const seq = ['DSH', 'ChatGPT']; return async () => seq[Math.min(i++, 1)]; })(),
      state: async () => { throw new Error('AX 挂了'); },
      restoreFront: async (n) => { restored.push(n); return true; },
    },
  });
  assert.ok(/AX 挂了/.test(r.error));
  assert.equal(r.frontStolen, true);
  assert.deepEqual(restored, ['DSH']);
});

test('可以关闭自动还原（交给上层统一处理）', async () => {
  const d = deps({ fronts: ['DSH', 'Ghostty'] });
  const r = await readSafe('Ghostty', { deps: d.deps, restore: false });
  assert.equal(r.frontStolen, true);
  assert.equal(d.restored.length, 0);
});

test('查询同样有前台保护', async () => {
  const d = deps({ fronts: ['DSH', 'ChatGPT'], matches: [{ index: 1, title: '按钮' }] });
  const r = await findSafe('ChatGPT', { role: 'AXButton' }, { deps: d.deps });
  assert.equal(r.matches.length, 1);
  assert.equal(r.frontStolen, true);
  assert.deepEqual(d.restored, ['DSH']);
});
