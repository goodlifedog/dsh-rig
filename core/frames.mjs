'use strict';

/**
 * 把浏览器画面实时推给小窗。
 * 用 CDP 截图（Page.captureScreenshot），转成 dataURL 推到 overlay 的 /frame。
 * 这样用户在小窗里就能看到"代理正在看的页面"，而不用把窗口搬到屏幕上。
 */
import { overlay } from './agentd.mjs';

export function startFrameStream(page, { intervalMs = 800, quality = 55, getCursor = null } = {}) {
  let stopped = false;
  let timer = null;

  const tick = async () => {
    if (stopped) return;
    try {
      const shot = await page.send('Page.captureScreenshot', { format: 'jpeg', quality });
      if (shot && shot.data) {
        let cursor = null;
        try {
          cursor = getCursor ? getCursor() : null;
          if (cursor && typeof cursor === 'object') {
            cursor.click = Boolean(cursor.click);
          }
        } catch {}
        await overlay.frame('data:image/jpeg;base64,' + shot.data, 'live', cursor);
      }
    } catch {}
    if (!stopped) timer = setTimeout(tick, intervalMs);
  };

  tick();

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
