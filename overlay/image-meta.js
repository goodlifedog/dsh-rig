'use strict';

/**
 * 帧数据解析（纯函数，便于单测）。
 * 外部推帧的 dataUrl、宽高、光标坐标都来自外部，解析必须对畸形输入免疫。
 */

/** base64 data URL 解出来的字节数（只算长度，不真解码整段） */
function base64DataBytes(dataUrl) {
  const text = String(dataUrl == null ? '' : dataUrl);
  const comma = text.indexOf(',');
  if (comma < 0) return 0;
  const b64 = text.length - comma - 1;
  let padding = 0;
  if (text.endsWith('==')) padding = 2;
  else if (text.endsWith('=')) padding = 1;
  return Math.max(0, Math.floor((b64 * 3) / 4) - padding);
}

/** 从 JPEG 字节里读 SOF 段的宽高；读不到返回 {width:0,height:0} */
function jpegSize(buf) {
  try {
    if (!buf || buf.length < 4) return { width: 0, height: 0 };
    let i = 2;
    // 需要读到 i+8 的宽度高字节，所以边界按 i+8 < length 判断（之前写成 i+9 会漏掉紧贴末尾的 SOF）
    while (i + 8 < buf.length) {
      if (buf[i] !== 0xff) { i += 1; continue; }
      const marker = buf[i + 1];
      const len = buf.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      }
      i += 2 + len;
      if (len <= 0) break;   // 长度非法，别死循环
    }
  } catch (error) {
    // 截断/畸形数据按未知处理
  }
  return { width: 0, height: 0 };
}

/** 只读图片头拿宽高（JPEG SOF / PNG IHDR），不整图解码；失败返回 null */
function imageSizeFromDataUrl(dataUrl) {
  try {
    const text = String(dataUrl == null ? '' : dataUrl);
    const comma = text.indexOf(',');
    if (comma < 0) return null;
    const meta = text.slice(0, comma);
    if (!/^data:image\//i.test(meta)) return null;
    const buf = Buffer.from(text.slice(comma + 1), 'base64');
    if (!buf.length) return null;
    if (/^data:image\/png/i.test(meta)) {
      if (buf.length >= 24 && buf.readUInt32BE(12) === 0x49484452) { // 'IHDR'
        const width = buf.readUInt32BE(16);
        const height = buf.readUInt32BE(20);
        if (width > 0 && height > 0) return { width: width, height: height };
      }
      return null;
    }
    if (/^data:image\/jpe?g/i.test(meta)) {
      const size = jpegSize(buf);
      if (size && size.width > 0 && size.height > 0) return size;
      return null;
    }
    return null;
  } catch (error) {
    return null;
  }
}

/** 虚拟光标：只接受有限数字坐标，保留两位小数；不合法返回 null */
function sanitizeCursor(cursor) {
  if (!cursor || typeof cursor !== 'object') return null;
  const x = Number(cursor.x);
  const y = Number(cursor.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return {
    x: Math.round(x * 100) / 100,
    y: Math.round(y * 100) / 100,
    click: Boolean(cursor.click),
  };
}

// 外部推帧只接受内联 base64 图片：如果放行 http(s):// 地址，小窗渲染进程会去远程拉图，
// 等于把「谁在用、什么时候用」泄漏给第三方，也可能被当成跟踪像素。svg 也不放行（可做伪装界面）。
const FRAME_DATA_URL_RE = /^data:image\/(?:png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=\s]+$/i;
const MAX_FRAME_DATA_URL_CHARS = 12 * 1024 * 1024;   // 二进制 ~9MB，够 CDP 截图

/** 校验外部推帧的 dataUrl 是不是允许的内联 base64 图片（纯函数） */
function isAllowedFrameDataUrl(value) {
  if (typeof value !== 'string') return false;
  if (!value || value.length > MAX_FRAME_DATA_URL_CHARS) return false;
  return FRAME_DATA_URL_RE.test(value);
}

module.exports = { base64DataBytes, jpegSize, imageSizeFromDataUrl, sanitizeCursor, isAllowedFrameDataUrl };
/**
 * 判断一张 RGBA 位图是不是"整块纯色"。
 *
 * 用途：窗口在别的桌面时系统会返回一整块纯色（JPEG 压完只有几 KB）。
 * 但纯黑/纯白的**正常**窗口压缩后同样很小 —— 只按体积判断会误伤，
 * 所以先按体积筛出可疑帧，再解码抽样确认是否真的纯色。
 *
 * @param {Buffer} rgba 原生位图（按 4 字节一个像素）
 * @param {{threshold?:number, samples?:number}} [options]
 * @returns {{uniform:boolean, range:number}}
 */
function looksUniform(rgba, options = {}) {
  const opts = options || {};
  const threshold = Number.isFinite(opts.threshold) ? opts.threshold : 10;
  const samples = Number.isFinite(opts.samples) ? opts.samples : 400;
  if (!rgba || rgba.length < 4) return { uniform: false, range: 0 };

  const pixels = Math.floor(rgba.length / 4);
  const step = Math.max(1, Math.floor(pixels / samples));
  let min = 255;
  let max = 0;
  let counted = 0;
  for (let i = 0; i < pixels; i += step) {
    const offset = i * 4;
    if (offset + 2 >= rgba.length) break;
    for (let c = 0; c < 3; c += 1) {
      const v = rgba[offset + c];
      if (v < min) min = v;
      if (v > max) max = v;
    }
    counted += 1;
  }
  if (!counted) return { uniform: false, range: 0 };
  const range = max - min;
  return { uniform: range <= threshold, range };
}

module.exports = Object.assign({}, module.exports, { looksUniform });
