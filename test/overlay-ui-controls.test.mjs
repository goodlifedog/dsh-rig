'use strict';
// 用户反馈：小窗不要录制暂停的红色「停止任务」按钮；放大按钮移到窗口中央、做成浏览器全屏样式。
// 纯静态断言：只读 index.html + renderer.js，不启动 Electron、不动屏幕。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(ROOT, 'overlay', 'index.html'), 'utf8');
const renderer = fs.readFileSync(path.join(ROOT, 'overlay', 'renderer.js'), 'utf8');

/** 取 CSS 里某个选择器的第一个声明块（按字面量找，不拼正则） */
function cssBlock(selector) {
  const needle = selector + ' {';
  const start = html.indexOf(needle);
  if (start < 0) return '';
  const bodyStart = start + needle.length;
  const end = html.indexOf('}', bodyStart);
  return end < 0 ? '' : html.slice(bodyStart, end);
}

test('markup 不再有红色「停止任务」按钮（无 id=stop / #stop 样式）', () => {
  assert.doesNotMatch(html, /id="stop"/);
  assert.doesNotMatch(html, /#stop\b/);
});

test('renderer 不再引用 elements.stop / stopTask handler', () => {
  assert.doesNotMatch(renderer, /elements\.stop/);
  assert.doesNotMatch(renderer, /api\.stopTask/);
});

test('放大按钮在窗口中央：top/left 50% + translate(-50%,-50%)，不贴右上角', () => {
  const block = cssBlock('#expand');
  assert.ok(block, '找不到 #expand 样式块');
  assert.match(block, /top:\s*50%/);
  assert.match(block, /left:\s*50%/);
  assert.match(block, /transform:\s*translate\(-50%,\s*-50%\)/);
  assert.doesNotMatch(block, /right:\s*\d+px/, '不应再使用 right 定位');
  assert.match(block, /pointer-events:\s*none/, '隐藏时不能挡住画面中心的点击穿透');
});

test('放大按钮是圆角方形半透明全屏按钮，且只在 card hover 时出现', () => {
  const block = cssBlock('#expand');
  assert.match(block, /width:\s*38px/);
  assert.match(block, /height:\s*38px/);
  assert.match(block, /border-radius:\s*10px/);
  assert.doesNotMatch(block, /border-radius:\s*50%/);
  assert.match(block, /background:\s*rgba\(0,\s*0,\s*0,\s*0\.46\)/);
  const hover = cssBlock('#card:hover #expand');
  assert.ok(hover, '找不到 hover 显示规则');
  assert.match(hover, /opacity:\s*1/);
  assert.match(hover, /pointer-events:\s*auto/);
});

test('放大按钮点击仍走 toggleExpand', () => {
  assert.match(html, /id="expand"/);
  assert.match(renderer, /elements\.expand\.addEventListener\('click'/);
  assert.match(renderer, /api\.toggleExpand\(\)/);
});

test('关闭按钮 ✕ 与 Esc 关闭保留', () => {
  assert.match(html, /id="close"/);
  assert.match(renderer, /elements\.close\.addEventListener\('click'/);
  assert.match(renderer, /event\.key === 'Escape'[\s\S]{0,40}api\.close\(\)/);
});

test('删除停止按钮不影响状态胶囊展示逻辑', () => {
  assert.match(renderer, /function renderActivity\(/);
  assert.match(renderer, /function updateBar\(/);
  assert.match(renderer, /elements\.barText\.textContent = text/);
  assert.match(renderer, /elements\.bar\.classList/);
});

test('点击穿透热区只算真正可见的按钮（隐藏的中央放大按钮不挡画面中心）', () => {
  assert.match(renderer, /getComputedStyle\(element\)/);
  assert.match(renderer, /pointerEvents === 'none'/);
  assert.match(renderer, /Number\(style\.opacity\) === 0/);
});
