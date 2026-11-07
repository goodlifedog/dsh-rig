'use strict';
// 菜单命令必须两步：菜单不展开时系统不给菜单项（矩阵实测 AXMenuItem 恒为 0）
import test from 'node:test';
import assert from 'node:assert/strict';
import { clickMenuItem } from '../core/background.mjs';

const noSleep = () => Promise.resolve();

test('给了 menu：先点开菜单栏，再点菜单项', async () => {
  const clicked = [];
  const r = await clickMenuItem('文本编辑', {
    menu: '文件',
    item: '保存',
    sleep: noSleep,
    deps: {
      find: async (app, { role, text }) => {
        if (role === 'AXMenuBarItem') return [{ index: 10, title: '文件' }];
        if (role === 'AXMenuItem') return [{ index: 20, title: '保存' }];
        return [];
      },
      click: async (app, idx) => { clicked.push(idx); return { ok: true, frontUnchanged: true }; },
    },
  });
  assert.equal(r.ok, true);
  assert.deepEqual(clicked, [10, 20], '顺序必须是先菜单栏后菜单项');
  assert.equal(r.menuOpened, true);
});

test('没给 menu：退化成直接点菜单项（适用于菜单已经展开）', async () => {
  const clicked = [];
  const r = await clickMenuItem('某应用', {
    item: '新建',
    sleep: noSleep,
    deps: {
      find: async (app, { role }) => (role === 'AXMenuItem' ? [{ index: 5, title: '新建' }] : []),
      click: async (app, idx) => { clicked.push(idx); return { ok: true, frontUnchanged: true }; },
    },
  });
  assert.equal(r.ok, true);
  assert.deepEqual(clicked, [5]);
  assert.equal(r.menuOpened, false);
});

test('菜单栏项找不到：如实失败，不去点菜单项', async () => {
  let itemClicks = 0;
  const r = await clickMenuItem('某应用', {
    menu: '不存在的菜单',
    item: '保存',
    sleep: noSleep,
    deps: {
      find: async (app, { role }) => (role === 'AXMenuBarItem' ? [] : [{ index: 1, title: '保存' }]),
      click: async () => { itemClicks += 1; return { ok: true }; },
    },
  });
  assert.equal(r.ok, false);
  assert.ok(/菜单栏项没找到/.test(r.reason));
  assert.equal(itemClicks, 0);
});

test('点开菜单失败：不再继续点菜单项', async () => {
  const r = await clickMenuItem('某应用', {
    menu: '文件',
    item: '保存',
    sleep: noSleep,
    deps: {
      find: async (app, { role }) => (role === 'AXMenuBarItem' ? [{ index: 1, title: '文件' }] : []),
      click: async () => ({ ok: false, error: '权限不足' }),
    },
  });
  assert.equal(r.ok, false);
  assert.equal(r.menuOpened, false);
});

test('菜单项完全匹配优先', async () => {
  const clicked = [];
  await clickMenuItem('某应用', {
    menu: '文件',
    item: '保存',
    sleep: noSleep,
    deps: {
      find: async (app, { role }) => {
        if (role === 'AXMenuBarItem') return [{ index: 1, title: '文件' }];
        return [{ index: 8, title: '保存并退出' }, { index: 9, title: '保存' }];
      },
      click: async (app, idx) => { clicked.push(idx); return { ok: true, frontUnchanged: true }; },
    },
  });
  assert.deepEqual(clicked, [1, 9]);
});
