'use strict';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { computeFrameTarget } = require('../overlay/frame-target.js');

test('收起态 300×190 出 600×380（Retina 1:1）', () => {
  assert.deepEqual(computeFrameTarget(300, 190), { width: 600, height: 380 });
});

test('放大态 960×600 出 1920×1200', () => {
  assert.deepEqual(computeFrameTarget(960, 600), { width: 1920, height: 1200 });
});

test('保持窗口宽高比，不变形', () => {
  const t = computeFrameTarget(400, 300);
  assert.equal(t.width, 800);
  assert.equal(t.height, 600);
  assert.equal(Math.round((t.width / t.height) * 100) / 100, Math.round((400 / 300) * 100) / 100);
});

test('太小/太大都夹在合理区间', () => {
  const small = computeFrameTarget(60, 40);
  assert.equal(small.width, 300, '最小 300，避免糊成一片');
  const big = computeFrameTarget(2000, 1200);
  assert.equal(big.width, 2560, '最大 2560，避免解码内存和传输爆掉');
});

test('非法尺寸回退到默认小窗尺寸', () => {
  assert.deepEqual(computeFrameTarget(0, 0), { width: 600, height: 380 });
  assert.deepEqual(computeFrameTarget(NaN, undefined), { width: 600, height: 380 });
});

test('高度至少 1 像素', () => {
  const t = computeFrameTarget(300, 1);
  assert.ok(t.height >= 1);
});
