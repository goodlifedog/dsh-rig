'use strict';
// 纯色帧判定：不能只看体积，纯黑/纯白的正常窗口也会很小
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { looksUniform } = require('../overlay/image-meta.js');

function makeRgba(width, height, fill) {
  const buf = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    const [r, g, b, a] = fill(i, width, height);
    buf[i * 4] = r; buf[i * 4 + 1] = g; buf[i * 4 + 2] = b; buf[i * 4 + 3] = a;
  }
  return buf;
}

test('纯白帧判为纯色', () => {
  const rgba = makeRgba(100, 80, () => [255, 255, 255, 255]);
  const r = looksUniform(rgba);
  assert.equal(r.uniform, true);
  assert.equal(r.range, 0);
});

test('纯黑帧也判为纯色', () => {
  const rgba = makeRgba(100, 80, () => [0, 0, 0, 255]);
  assert.equal(looksUniform(rgba).uniform, true);
});

test('有内容的帧不是纯色（少量文字也算）', () => {
  const rgba = makeRgba(200, 150, (i, w) => (i % 37 === 0 ? [255, 255, 255, 255] : [20, 20, 20, 255]));
  const r = looksUniform(rgba);
  assert.equal(r.uniform, false);
  assert.ok(r.range > 100);
});

test('渐变背景不算纯色', () => {
  const rgba = makeRgba(120, 90, (i, w) => [Math.round((i % w) * 2), 40, 60, 255]);
  assert.equal(looksUniform(rgba).uniform, false);
});

test('极小/空缓冲区安全返回非纯色', () => {
  assert.equal(looksUniform(Buffer.alloc(0)).uniform, false);
  assert.equal(looksUniform(null).uniform, false);
});

test('阈值可调：接近纯色时按阈值判定', () => {
  const rgba = makeRgba(60, 60, (i) => [(i % 2) ? 250 : 245, 245, 245, 255]);
  assert.equal(looksUniform(rgba, { threshold: 10 }).uniform, true, '范围 5 在阈值内');
  assert.equal(looksUniform(rgba, { threshold: 2 }).uniform, false, '阈值更严就不算纯色');
});
