'use strict';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { base64DataBytes, jpegSize, imageSizeFromDataUrl, sanitizeCursor } = require('../overlay/image-meta.js');

// 造一个最小 PNG 头：8 字节签名 + 长度 + 'IHDR' + 宽高
function pngBuffer(width, height) {
  const buf = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write('IHDR', 12, 'ascii');
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

// 造一个最小 JPEG 头：SOI + APP0 + SOF0（含宽高）
function jpegBuffer(width, height) {
  const parts = [
    Buffer.from([0xff, 0xd8]),                       // SOI
    Buffer.from([0xff, 0xe0, 0x00, 0x04, 0x00, 0x00]), // APP0，长度 4
    Buffer.alloc(9),                                  // SOF0 占位
  ];
  parts[2].writeUInt8(0xff, 0);
  parts[2].writeUInt8(0xc0, 1);
  parts[2].writeUInt16BE(0x11, 2);   // 段长度
  parts[2].writeUInt8(8, 4);         // 精度
  parts[2].writeUInt16BE(height, 5);
  parts[2].writeUInt16BE(width, 7);
  return Buffer.concat(parts);
}

const dataUrl = (mime, buf) => 'data:' + mime + ';base64,' + buf.toString('base64');

test('字节数按 base64 长度换算（不是 base64 字符数）', () => {
  const buf = Buffer.from('hello');
  assert.equal(base64DataBytes(dataUrl('image/png', buf)), 5);
  assert.equal(base64DataBytes('没有逗号'), 0);
  assert.equal(base64DataBytes(''), 0);
  assert.equal(base64DataBytes(null), 0);
});

test('PNG 头读出宽高', () => {
  const size = imageSizeFromDataUrl(dataUrl('image/png', pngBuffer(600, 380)));
  assert.deepEqual(size, { width: 600, height: 380 });
});

test('JPEG 头读出宽高', () => {
  const size = imageSizeFromDataUrl(dataUrl('image/jpeg', jpegBuffer(1920, 1200)));
  assert.deepEqual(size, { width: 1920, height: 1200 });
});

test('畸形/非图片一律返回 null，不抛错', () => {
  assert.equal(imageSizeFromDataUrl('data:image/png;base64,AAAA'), null);
  assert.equal(imageSizeFromDataUrl('data:text/plain;base64,aGk='), null);
  assert.equal(imageSizeFromDataUrl('https://example.com/a.jpg'), null);
  assert.equal(imageSizeFromDataUrl(null), null);
  assert.equal(imageSizeFromDataUrl(''), null);
});

test('截断的 JPEG 不死循环、返回 0', () => {
  const truncated = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00]);
  assert.deepEqual(jpegSize(truncated), { width: 0, height: 0 });
  assert.deepEqual(jpegSize(null), { width: 0, height: 0 });
});

test('光标坐标保留两位小数、非法值返回 null', () => {
  assert.deepEqual(sanitizeCursor({ x: 10.123456, y: 20.98765, click: 1 }), { x: 10.12, y: 20.99, click: true });
  assert.equal(sanitizeCursor({ x: NaN, y: 1 }), null);
  assert.equal(sanitizeCursor({ x: 'a', y: 2 }), null);
  assert.equal(sanitizeCursor(null), null);
  assert.equal(sanitizeCursor('x'), null);
});
