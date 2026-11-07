'use strict';
// 宿主窗口选择：原生优先，浏览器 Web 界面兜底
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { selectHostWindow } = require('../overlay/host-select.js');

const W = (owner, title, x, y, w, h, layer = 0) => ({ owner, title, x, y, w, h, layer });

test('原生宿主窗口优先', () => {
  const hit = selectHostWindow([
    W('Google Chrome', 'DeepSeek Harness', 10, 10, 1200, 800),
    W('DeepSeek Harness', '项目详情', 0, 0, 1000, 700),
  ], 'DeepSeek Harness');
  assert.equal(hit.kind, 'native');
  assert.equal(hit.owner, 'DeepSeek Harness');
});

test('没有原生窗口时认浏览器里标题带 DSH 的窗口', () => {
  const hit = selectHostWindow([
    W('Google Chrome', '无关页面', 0, 0, 1400, 900),
    W('Google Chrome', '规划布局探讨 — DeepSeek Harness', 100, 50, 1200, 800),
  ], 'DeepSeek Harness');
  assert.equal(hit.kind, 'browser');
  assert.equal(hit.title, '规划布局探讨 — DeepSeek Harness');
  assert.equal(hit.x, 100);
});

test('多个浏览器候选时取面积最大的', () => {
  const hit = selectHostWindow([
    W('Safari', 'A — DeepSeek Harness', 0, 0, 800, 600),
    W('Google Chrome', 'B — DeepSeek Harness', 0, 0, 1600, 1000),
  ], 'DeepSeek Harness');
  assert.equal(hit.owner, 'Google Chrome');
});

test('标题不带 DSH 的浏览器窗口不算宿主', () => {
  assert.equal(selectHostWindow([W('Google Chrome', 'Gmail', 0, 0, 1200, 800)], 'DeepSeek Harness'), null);
});

test('太小/非主层窗口忽略', () => {
  assert.equal(selectHostWindow([W('DeepSeek Harness', 'x', 0, 0, 100, 50)], 'DeepSeek Harness'), null);
  assert.equal(selectHostWindow([W('DeepSeek Harness', 'x', 0, 0, 900, 600, 1)], 'DeepSeek Harness'), null);
  assert.equal(selectHostWindow([], 'DeepSeek Harness'), null);
});
