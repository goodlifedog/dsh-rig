'use strict';
// 小窗渲染进程的 CSP 是安全边界的一部分：它拿到的是「窗口标题/日志/推帧」这类外部数据，
// 一旦 CSP 被放宽或加回内联 handler，注入面就回来了。这里把当前口径钉住。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(ROOT, 'overlay', 'index.html'), 'utf8');
const renderer = fs.readFileSync(path.join(ROOT, 'overlay', 'renderer.js'), 'utf8');

test('index.html 带严格 CSP：默认全禁，只允许本地脚本与内联样式', () => {
  assert.match(html, /Content-Security-Policy/);
  const m = /content="([^"]+)"/.exec(html.split('Content-Security-Policy')[1] || '');
  const csp = m ? m[1] : '';
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /script-src 'self'/);
  assert.match(csp, /img-src 'self' data:/, '推帧是 data: 图片，必须允许');
  assert.match(csp, /base-uri 'none'/);
  assert.match(csp, /form-action 'none'/);
  assert.doesNotMatch(csp, /script-src[^;]*unsafe-inline/, '脚本不允许内联');
});

test('不允许内联事件处理器（CSP 会被绕过/被迫放宽）', () => {
  assert.equal(/\son(click|load|error|mouseover)\s*=/.test(html), false);
  assert.equal(/\son(click|load|error|mouseover)\s*=/.test(renderer), false);
});

test('渲染层只用 textContent 写外部文本，不用 innerHTML', () => {
  assert.equal(/innerHTML\s*=/.test(renderer), false);
  assert.equal(/insertAdjacentHTML/.test(renderer), false);
});
