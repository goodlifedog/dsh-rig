'use strict';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { normalizeWindowId, resolveWindowId } = require('../overlay/window-id.js');

test('数字与数字字符串都认', () => {
  assert.equal(normalizeWindowId(68544), 68544);
  assert.equal(normalizeWindowId('68544'), 68544);
  assert.equal(normalizeWindowId(' 68544 '), 68544);
});

test('Electron desktopCapturer 的 source id 也认', () => {
  assert.equal(normalizeWindowId('window:68544:0'), 68544);
  assert.equal(normalizeWindowId('window:68544'), 68544);
});

test('非法值一律 null（调用方据此判定解绑/400）', () => {
  for (const bad of [null, undefined, '', '  ', 'abc', 'window:abc:0', 0, -1, 1.5, NaN, Infinity, {}, []]) {
    assert.equal(normalizeWindowId(bad), null, String(bad));
  }
});

test('从命令行参数解析', () => {
  assert.equal(resolveWindowId(['--window-id=68544']), 68544);
  assert.equal(resolveWindowId(['--window-id', '68544']), 68544);
  assert.equal(resolveWindowId(['68544']), 68544);
  assert.equal(resolveWindowId([]), null);
});

test('环境变量优先于命令行', () => {
  assert.equal(resolveWindowId(['--window-id=111'], { OVERLAY_WINDOW_ID: '222' }), 222);
});

test('环境变量非法时回退到命令行', () => {
  assert.equal(resolveWindowId(['--window-id=111'], { OVERLAY_WINDOW_ID: 'abc' }), 111);
});
