'use strict';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { tilePosition, clampIntoBounds } = require('../overlay/layout.js');

const HOST = { x: 0, y: 33, w: 1512, h: 949 };
const WIN = { w: 300, h: 190 };

test('第一个小窗贴右上角（留边距）', () => {
  const p = tilePosition(HOST, WIN, 0, { margin: 16, gap: 10 });
  assert.equal(p.x, HOST.x + HOST.w - 16 - 300);
  assert.equal(p.y, HOST.y + 16);
  assert.equal(p.row, 0);
  assert.equal(p.col, 0);
});

test('放得下就横着排，第二个在左边', () => {
  const p = tilePosition(HOST, WIN, 1, { margin: 16, gap: 10 });
  assert.equal(p.row, 0);
  assert.equal(p.col, 1);
  assert.ok(p.x < tilePosition(HOST, WIN, 0, { margin: 16, gap: 10 }).x, '第二个应更靠左');
});

test('一行放满后换到下一行', () => {
  const first = tilePosition(HOST, WIN, 0, { margin: 16, gap: 10 });
  const cols = first.cols;
  assert.ok(cols >= 2, '正常屏宽应该能放多列');
  const wrapped = tilePosition(HOST, WIN, cols, { margin: 16, gap: 10 });
  assert.equal(wrapped.row, 1);
  assert.equal(wrapped.col, 0);
  assert.ok(wrapped.y > first.y, '换行后应更靠下');
});

test('永远不跑到宿主外面（右/下边界被夹住）', () => {
  const p = tilePosition(HOST, WIN, 999, { margin: 16, gap: 10 });
  assert.ok(p.x >= HOST.x, '不能超出左边界');
  assert.ok(p.x + WIN.w <= HOST.x + HOST.w, '不能超出右边界');
  assert.ok(p.y >= HOST.y, '不能超出上边界');
  assert.ok(p.y + WIN.h <= HOST.y + HOST.h, '不能超出下边界');
});

test('宿主很窄时退化成单列竖排', () => {
  const narrow = { x: 100, y: 50, w: 340, h: 600 };
  const p0 = tilePosition(narrow, WIN, 0, { margin: 16, gap: 10 });
  const p1 = tilePosition(narrow, WIN, 1, { margin: 16, gap: 10 });
  assert.equal(p0.cols, 1);
  assert.equal(p1.row, 1);
  assert.equal(p1.col, 0);
});

test('非法输入不炸', () => {
  const p = tilePosition(null, null, -3, {});
  assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y));
});

test('窗口被拖出宿主后夹回范围内', () => {
  const fixed = clampIntoBounds({ x: -500, y: 5000 }, WIN, HOST, 1);
  assert.equal(fixed.changed, true);
  assert.equal(fixed.x, HOST.x);
  assert.equal(fixed.y, HOST.y + HOST.h - WIN.h);
});

test('本来就在范围内就不动', () => {
  const fixed = clampIntoBounds({ x: 100, y: 100 }, WIN, HOST, 1);
  assert.equal(fixed.changed, false);
  assert.equal(fixed.x, 100);
});

test('1px 以内的抖动不算移动（避免反复 setPosition）', () => {
  const fixed = clampIntoBounds({ x: HOST.x + 100, y: HOST.y + 100 }, WIN, HOST, 1);
  assert.equal(fixed.changed, false);
});
