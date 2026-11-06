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

module.exports = { base64DataBytes, jpegSize, imageSizeFromDataUrl, sanitizeCursor };
