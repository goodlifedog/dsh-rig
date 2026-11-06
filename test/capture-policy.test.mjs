'use strict';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { nextCaptureDelay } = require('../overlay/capture-policy.js');

test('画面在变：保持满帧率', () => {
  assert.equal(nextCaptureDelay({ unchangedFrames: 0, basePeriod: 70 }), 70);
});

test('连续不变时逐步降频', () => {
  assert.equal(nextCaptureDelay({ unchangedFrames: 1, basePeriod: 70 }), 140);
  assert.equal(nextCaptureDelay({ unchangedFrames: 2, basePeriod: 70 }), 280);
  assert.equal(nextCaptureDelay({ unchangedFrames: 3, basePeriod: 70 }), 560);
});

test('降频有上限，不会低到看不见变化', () => {
  assert.equal(nextCaptureDelay({ unchangedFrames: 5, basePeriod: 70, maxPeriod: 1000 }), 1000);
  assert.equal(nextCaptureDelay({ unchangedFrames: 99, basePeriod: 70, maxPeriod: 500 }), 500);
});

test('异常输入回退到默认值，不返回 NaN', () => {
  assert.equal(nextCaptureDelay({}), 70);
  assert.equal(nextCaptureDelay({ unchangedFrames: NaN, basePeriod: NaN }), 70);
  assert.equal(nextCaptureDelay({ unchangedFrames: -5, basePeriod: -1 }), 70);
  assert.ok(Number.isFinite(nextCaptureDelay({ unchangedFrames: 1000, basePeriod: 1 })));
});
