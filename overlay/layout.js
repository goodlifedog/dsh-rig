'use strict';

/**
 * 小窗排版（纯函数，便于单测）。
 * 贴宿主窗口右上角开始平铺，放不下就往左、再往下，越界时贴边而不是跑到宿主外面。
 */

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * 第 index 个会话窗口的位置。
 * @param {{x:number,y:number,w:number,h:number}} hostBounds 宿主窗口（屏幕坐标）
 * @param {{w:number,h:number}} windowSize 小窗尺寸
 * @param {number} index 第几个会话（0 开始）
 * @param {{margin?:number, gap?:number}} [options]
 * @returns {{x:number,y:number,cols:number,row:number,col:number}}
 */
function tilePosition(hostBounds, windowSize, index, options) {
  const opts = options || {};
  const margin = Number.isFinite(opts.margin) ? opts.margin : 16;
  const gap = Number.isFinite(opts.gap) ? opts.gap : 10;
  const b = hostBounds || { x: 0, y: 0, w: 0, h: 0 };
  const cw = Math.max(1, Number(windowSize && windowSize.w) || 300);
  const ch = Math.max(1, Number(windowSize && windowSize.h) || 190);
  const i = Number.isInteger(index) && index >= 0 ? index : 0;

  const usableWidth = Math.max(cw, b.w - 2 * margin);
  const cols = Math.max(1, Math.floor((usableWidth + gap) / (cw + gap)));
  const col = i % cols;
  const row = Math.floor(i / cols);

  const rawX = b.x + b.w - margin - cw - col * (cw + gap);
  const rawY = b.y + margin + row * (ch + gap);
  const maxY = b.y + b.h - margin - ch;

  return {
    x: Math.round(clamp(rawX, b.x, Math.max(b.x, b.x + b.w - cw))),
    y: Math.round(clamp(rawY > maxY ? maxY : rawY, b.y, Math.max(b.y, maxY))),
    cols: cols,
    row: row,
    col: col,
  };
}

/**
 * 把窗口位置夹回宿主范围内（宿主移动/缩放后调用）。
 * @returns {{x:number,y:number,changed:boolean}}
 */
function clampIntoBounds(position, windowSize, bounds, tolerance) {
  const tol = Number.isFinite(tolerance) ? tolerance : 1;
  const p = position || { x: 0, y: 0 };
  const cw = Math.max(1, Number(windowSize && windowSize.w) || 300);
  const ch = Math.max(1, Number(windowSize && windowSize.h) || 190);
  const b = bounds || { x: 0, y: 0, w: 0, h: 0 };
  const maxX = Math.max(b.x, b.x + b.w - cw);
  const maxY = Math.max(b.y, b.y + b.h - ch);
  const x = Math.round(clamp(p.x, b.x, maxX));
  const y = Math.round(clamp(p.y, b.y, maxY));
  return { x: x, y: y, changed: Math.abs(x - p.x) > tol || Math.abs(y - p.y) > tol };
}

module.exports = { tilePosition, clampIntoBounds };
