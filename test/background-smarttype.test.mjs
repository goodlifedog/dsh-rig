'use strict';
// 智能输入降级链：接口说成功但内容没进去时不能算成功
import test from 'node:test';
import assert from 'node:assert/strict';
import { smartType, smartTypeWithCache } from '../core/background.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function deps({ tree, setValueOk = true, typeOk = true, afterSetValue, afterType } = {}) {
  let current = tree || '';
  const calls = { setValue: 0, typeText: 0 };
  return {
    calls,
    deps: {
      state: async () => current,
      setValue: async () => {
        calls.setValue += 1;
        if (afterSetValue !== undefined) current = typeof afterSetValue === 'function' ? afterSetValue(current) : afterSetValue;
        return { ok: setValueOk, frontUnchanged: true };
      },
      typeText: async () => {
        calls.typeText += 1;
        if (afterType !== undefined) current = typeof afterType === 'function' ? afterType(current) : afterType;
        return { ok: typeOk, frontUnchanged: true };
      },
    },
  };
}

test('AX 设值成功且读回确认：用 set_value，不再键入', async () => {
  const d = deps({ tree: '', afterSetValue: '用户内容 ABC' });
  const r = await smartType('文本编辑', { elementIndex: 1000002, text: '用户内容 ABC', deps: d.deps });
  assert.equal(r.ok, true);
  assert.equal(r.method, 'set_value');
  assert.equal(r.verified, true);
  assert.equal(d.calls.typeText, 0);
});

test('AX 设值失败：自动降级到后台键入', async () => {
  const d = deps({ tree: '', setValueOk: false, afterType: '用户内容 ABC' });
  const r = await smartType('计算器', { elementIndex: 1000002, text: '用户内容 ABC', deps: d.deps });
  assert.equal(r.ok, true);
  assert.equal(r.method, 'type_text');
  assert.equal(r.attempts.length, 2);
  assert.equal(r.attempts[0].method, 'set_value');
});

test('接口报成功但读不到内容：继续尝试下一种，最终如实报失败', async () => {
  const d = deps({ tree: '完全没变' });
  const r = await smartType('某应用', { elementIndex: 1, text: '要写进去的内容', deps: d.deps });
  assert.equal(r.ok, false);
  assert.equal(r.method, 'none');
  assert.equal(r.attempts.length, 2, '两种方式都试过');
  assert.equal(r.attempts.every((a) => a.ok), true, '接口层都报成功，但校验没过');
});

test('没有元素索引时直接走键入', async () => {
  const d = deps({ tree: '', afterType: '内容X' });
  const r = await smartType('计算器', { text: '内容X', deps: d.deps });
  assert.equal(r.method, 'type_text');
  assert.equal(d.calls.setValue, 0);
});

test('设值成功但校验不通过时，会再试键入并采用成功的那种', async () => {
  let tree = '';
  const r = await smartType('备忘录', {
    elementIndex: 7,
    text: '目标文本',
    deps: {
      state: async () => tree,
      setValue: async () => ({ ok: true, frontUnchanged: true }),      // 报成功但不改内容
      typeText: async () => { tree = '目标文本 已写入'; return { ok: true, frontUnchanged: true }; },
    },
  });
  assert.equal(r.ok, true);
  assert.equal(r.method, 'type_text');
});

test('每次尝试都记录前台是否未变（供上报用）', async () => {
  const r = await smartType('文本编辑', {
    elementIndex: 3,
    text: 'zzz',
    deps: {
      state: async () => '没有',
      setValue: async () => ({ ok: false, frontUnchanged: true }),
      typeText: async () => ({ ok: false, frontUnchanged: false }),
    },
  });
  assert.equal(r.ok, false);
  assert.equal(r.attempts[0].frontUnchanged, true);
  assert.equal(r.attempts[1].frontUnchanged, false);
});
test('order 指定顺序时按顺序尝试（只给 type_text 就不碰设值）', async () => {
  const d = deps({ tree: '', afterType: '内容Z' });
  const r = await smartType('某应用', { elementIndex: 5, text: '内容Z', order: ['type_text'], deps: d.deps });
  assert.equal(r.method, 'type_text');
  assert.equal(d.calls.setValue, 0, '指定了只走键入就不该调设值');
});

test('带缓存：成功方式写回缓存，下次优先用它', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smart-cache-'));
  const cacheFile = path.join(dir, 'cap.json');
  let tree = '';
  const makeDeps = () => ({
    state: async () => tree,
    setValue: async () => ({ ok: false, frontUnchanged: true }),
    typeText: async () => { tree = '缓存测试内容'; return { ok: true, frontUnchanged: true }; },
  });
  const first = await smartTypeWithCache('应用C', { elementIndex: 9, text: '缓存测试内容', cacheFile, deps: makeDeps() });
  assert.equal(first.method, 'type_text');
  const saved = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  assert.deepEqual(saved['应用C'].type[0], 'type_text', '成功方式应排在缓存最前');
  fs.rmSync(dir, { recursive: true, force: true });
});
