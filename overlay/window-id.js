'use strict';

/**
 * windowID 解析工具。
 *
 * 支持的写法：
 *   68544
 *   '68544'
 *   'window:68544:0'   Electron desktopCapturer 的 source id
 *   '--window-id=68544'
 *   '--window-id 68544'
 *   裸数字命令行参数
 *
 * 环境变量：OVERLAY_WINDOW_ID（优先）/ WINDOW_ID（兼容别名）。
 */

function normalizeWindowId(raw) {
  if (typeof raw === 'number') {
    return Number.isSafeInteger(raw) && raw > 0 ? raw : null;
  }
  if (typeof raw !== 'string') return null;

  const text = raw.trim();
  if (!text) return null;

  const match = /^(?:window:)?(\d+)(?::\d+)?$/.exec(text);
  if (!match) return null;

  const id = Number(match[1]);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function resolveWindowId(argv, env) {
  const args = Array.isArray(argv) ? argv : [];
  const source = env || {};
  const candidates = [source.OVERLAY_WINDOW_ID, source.WINDOW_ID];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (typeof arg !== 'string') continue;

    const assigned = /^--window-id=(.+)$/.exec(arg);
    if (assigned) {
      candidates.push(assigned[1]);
      continue;
    }
    if (arg === '--window-id') {
      candidates.push(args[index + 1]);
      index += 1;
      continue;
    }
    if (/^\d+$/.test(arg)) candidates.push(arg);
  }

  for (const candidate of candidates) {
    const id = normalizeWindowId(candidate);
    if (id) return id;
  }
  return null;
}

module.exports = { normalizeWindowId, resolveWindowId };
