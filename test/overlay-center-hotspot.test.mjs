'use strict';
// 用户反馈：放大按钮移到窗口中央后，主进程的点击穿透热区必须跟着中央走，
// 否则指针还没触发渲染进程 pointermove 时，第一次点中央按钮会穿透到后面的 DSH。
// 纯静态 + 纯函数：从 overlay/main.js 抽出 cursorInHotspot，用假窗口边界跑几何断言。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(ROOT, 'overlay', 'main.js'), 'utf8');

function extractFunction(name) {
  const needle = 'function ' + name + '(';
  const start = source.indexOf(needle);
  assert.ok(start >= 0, 'main.js 里找不到 ' + name);
  let i = source.indexOf('{', start);
  const bodyStart = i + 1;
  let depth = 0;
  for (; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  assert.ok(depth === 0, name + ' 大括号不配对');
  return source.slice(bodyStart, i);
}

const body = extractFunction('cursorInHotspot');
const cursorInHotspot = new Function('s', 'win', 'point', body);

// 300×190 的小窗，放在屏幕 (100,50)
const BOUNDS = { x: 100, y: 50, width: 300, height: 190 };
const win = { getBounds: () => ({ ...BOUNDS }) };
const at = (x, y) => cursorInHotspot({ state: {}, flags: {} }, win, { x, y });

test('中央 38×38 放大按钮是热区（含 2px 容差）', () => {
  assert.equal(at(250, 145), true, '窗口正中心必须可点');
  assert.equal(at(250 + 20, 145 + 20), true, '按钮右下角内沿');
  assert.equal(at(250 - 20, 145 - 20), true, '按钮左上角内沿');
  assert.equal(at(250 + 22, 145), false, '按钮外 2px 以上不再接管鼠标');
});

test('中央热区随窗口尺寸自适应，不是写死的屏幕坐标', () => {
  const big = { getBounds: () => ({ x: 0, y: 0, width: 600, height: 400 }) };
  assert.equal(cursorInHotspot({}, big, { x: 300, y: 200 }), true);
  assert.equal(cursorInHotspot({}, big, { x: 250, y: 200 }), false);
});

test('右上角关闭钮仍是热区', () => {
  assert.equal(at(BOUNDS.x + BOUNDS.width - 15, BOUNDS.y + 20), true);
});

test('已删除的「■ 停止按钮」旧热区不再接管鼠标（即使任务在跑）', () => {
  // 旧实现里 right:65 的停止按钮占 x ∈ [w-90, w-64]，即绝对坐标 310~336
  assert.equal(cursorInHotspot({ state: { activity: 'running' }, flags: {} }, win, { x: 320, y: 70 }), false);
  assert.equal(cursorInHotspot({ state: { activity: 'running' }, flags: {} }, win, { x: 330, y: 70 }), false);
  assert.doesNotMatch(body, /activity === 'running'/, '主进程热区不应再引用已删除的停止按钮');
});

test('边缘 8px 拖拽条、左上角日志入口、底部错误操作按钮行为不变', () => {
  assert.equal(at(200, 52), true, '顶部 8px');
  assert.equal(at(102, 120), true, '左侧 8px');
  assert.equal(at(110, 60), true, '左上角日志入口');
  assert.equal(at(250, 225), false, '没有错误按钮时底部中间不接管');
  assert.equal(cursorInHotspot({ flags: { hasAction: true } }, win, { x: 250, y: 225 }), true, '有错误按钮时接管');
});

test('窗口外一律不接管', () => {
  assert.equal(at(99, 50), false);
  assert.equal(at(400, 240), false);
});

test('热区计算与渲染进程用同一套几何：中央按钮尺寸取自 index.html', () => {
  const html = fs.readFileSync(path.join(ROOT, 'overlay', 'index.html'), 'utf8');
  const block = html.slice(html.indexOf('#expand {'), html.indexOf('}', html.indexOf('#expand {')));
  assert.match(block, /width:\s*38px/);
  assert.match(block, /height:\s*38px/);
  // 38 / 2 + 2px 容差 = 21
  assert.match(body, /21/);
});
