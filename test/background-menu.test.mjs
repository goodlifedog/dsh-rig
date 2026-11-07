'use strict';
// 菜单栏命令与窗口控制按钮：纯逻辑用假 MCP 验证
import test from 'node:test';
import assert from 'node:assert/strict';
import { clickMenuItem, windowControls } from '../core/background.mjs';

test('菜单项完全匹配优先，点击并返回前台状态', async () => {
  const clicked = [];
  const r = await clickMenuItem('备忘录', {
    item: '新建备忘录',
    deps: {
      find: async () => [
        { index: 1, title: '新建备忘录（高级）' },
        { index: 2, title: '新建备忘录' },
      ],
      click: async (app, index) => { clicked.push([app, index]); return { ok: true, frontUnchanged: true }; },
    },
  });
  assert.equal(r.ok, true);
  assert.equal(r.index, 2, '应选完全匹配的那一项');
  assert.deepEqual(clicked[0], ['备忘录', 2]);
});

test('只有包含匹配时也能用', async () => {
  const r = await clickMenuItem('Safari', {
    item: '新建',
    deps: { find: async () => [{ index: 9, title: '新建无痕窗口' }], click: async () => ({ ok: true, frontUnchanged: true }) },
  });
  assert.equal(r.ok, true);
  assert.equal(r.index, 9);
});

test('找不到菜单项时如实返回原因，不点任何东西', async () => {
  let clicked = 0;
  const r = await clickMenuItem('访达', {
    item: '不存在的菜单',
    deps: { find: async () => [{ index: 1, title: '打开' }], click: async () => { clicked += 1; return { ok: true }; } },
  });
  assert.equal(r.ok, false);
  assert.ok(/没找到/.test(r.reason));
  assert.equal(clicked, 0, '没找到就不该乱点');
});

test('查询抛错不影响调用方', async () => {
  const r = await clickMenuItem('某应用', {
    item: '保存',
    deps: { find: async () => { throw new Error('AX 挂了'); }, click: async () => ({ ok: true }) },
  });
  assert.equal(r.ok, false);
  assert.ok(/菜单查询失败/.test(r.reason));
});

test('没给菜单文字直接返回失败', async () => {
  const r = await clickMenuItem('某应用', {});
  assert.equal(r.ok, false);
});

test('窗口控制按钮能识别中文与英文标题', async () => {
  const buttons = await windowControls('文本编辑', {
    deps: {
      find: async () => [
        { index: 1, title: '关闭' },
        { index: 2, title: '最小化' },
        { index: 3, title: '全屏' },
        { index: 4, title: '保存' },
      ],
    },
  });
  assert.equal(buttons.length, 2);
  assert.deepEqual(buttons.map((b) => b.title), ['关闭', '最小化']);
});
