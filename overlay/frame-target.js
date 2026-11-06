'use strict';

/**
 * 推帧尺寸计算（纯函数，便于单测）。
 * 小窗是 Retina 屏上的逻辑尺寸：300×190 的点实际要 600×380 像素才 1:1 清晰，
 * 放大到 960×600 就要 1920×1200。超过上限（默认 2560）才截断。
 */

function computeFrameTarget(width, height, options) {
  const opts = options || {};
  const scale = Number(opts.scale) > 0 ? Number(opts.scale) : 2;
  const min = Number(opts.min) > 0 ? Number(opts.min) : 300;
  const max = Number(opts.max) > 0 ? Number(opts.max) : 2560;

  const w = Number(width) > 0 ? Number(width) : 300;
  const h = Number(height) > 0 ? Number(height) : 190;

  // 先算目标宽度并夹在 [min, max]，再按窗口宽高比推高度，保证不变形
  const targetWidth = Math.min(max, Math.max(min, Math.round(w * scale)));
  return {
    width: targetWidth,
    height: Math.max(1, Math.round(targetWidth * (h / w))),
  };
}

module.exports = { computeFrameTarget };
