'use strict';

/**
 * 拟人化输入：在目标页面里模拟真人鼠标/键盘，只作用于该浏览器实例，
 * 完全不触碰系统真实指针。
 *
 * 真实感来自：
 *   - 三次贝塞尔曲线轨迹（不是直线）
 *   - 每一步带微小抖动
 *   - 变速：起步慢、中段快、接近目标减速
 *   - 按下/抬起之间随机停留
 *   - 点击前随机悬停
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (min, max) => min + Math.random() * (max - min);
const randInt = (min, max) => Math.floor(rand(min, max + 1));

function bezier(p0, p1, p2, p3, t) {
  const u = 1 - t;
  return {
    x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
    y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
  };
}

/** 生成一条从当前点到目标点的曲线轨迹 */
export function buildPath(from, to, { points = null } = {}) {
  const dist = Math.hypot(to.x - from.x, to.y - from.y);
  const steps = points || Math.max(12, Math.min(60, Math.round(dist / 12)));
  // 控制点偏移，制造弧度
  const nx = -(to.y - from.y) / (dist || 1);
  const ny = (to.x - from.x) / (dist || 1);
  const bend = rand(-0.25, 0.25) * dist;
  const p1 = { x: from.x + (to.x - from.x) * 0.3 + nx * bend, y: from.y + (to.y - from.y) * 0.3 + ny * bend };
  const p2 = { x: from.x + (to.x - from.x) * 0.7 + nx * bend * 0.6, y: from.y + (to.y - from.y) * 0.7 + ny * bend * 0.6 };

  const path = [{ x: from.x, y: from.y }];
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    // 缓入缓出
    const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    const pt = bezier(from, p1, p2, to, e);
    path.push({ x: pt.x + rand(-0.6, 0.6), y: pt.y + rand(-0.6, 0.6) });
  }
  return path;
}

export class HumanMouse {
  constructor(page) {
    this.page = page;
    this.pos = { x: rand(200, 600), y: rand(200, 400) };
    this.lastClickAt = 0;
  }

  async move(to, { hoverMs = null } = {}) {
    const path = buildPath(this.pos, to);
    for (let i = 0; i < path.length; i++) {
      const t = i / path.length;
      // 变速：两端慢、中间快
      const speed = t < 0.15 || t > 0.85 ? rand(18, 32) : rand(6, 14);
      await this.page.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: Math.round(path[i].x),
        y: Math.round(path[i].y),
        buttons: 0,
      });
      await sleep(speed);
    }
    this.pos = { x: Math.round(to.x), y: Math.round(to.y) };
    if (hoverMs) await sleep(hoverMs);
    return path.length;
  }

  async click(to, { hoverMs = null, holdMs = null } = {}) {
    const moves = await this.move(to, { hoverMs: hoverMs ?? randInt(60, 220) });
    const hold = holdMs ?? randInt(45, 130);
    await this.page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: this.pos.x, y: this.pos.y, button: 'left', buttons: 1, clickCount: 1 });
    await sleep(hold);
    await this.page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: this.pos.x, y: this.pos.y, button: 'left', buttons: 0, clickCount: 1 });
    this.lastClickAt = Date.now();
    return { moves, holdMs: hold };
  }

  /** 拟人打字：每个字符随机间隔，偶尔停顿 */
  async type(text) {
    for (const ch of text) {
      await this.page.send('Input.insertText', { text: ch });
      let delay = rand(40, 130);
      if (Math.random() < 0.08) delay += rand(120, 420); // 偶尔停顿
      await sleep(delay);
    }
  }
}

/** 在页面里取元素中心点（视口坐标） */
export async function centerOf(page, selector) {
  const r = await page.send('Runtime.evaluate', {
    expression: '(' + function (sel) {
      const el = document.querySelector(sel);
      if (!el) return null;
      el.scrollIntoView({ block: 'center' });
      const b = el.getBoundingClientRect();
      return JSON.stringify({ x: b.x + b.width / 2, y: b.y + b.height / 2, w: b.width, h: b.height });
    } + ')(' + JSON.stringify(selector) + ')',
    returnByValue: true,
  });
  const v = r.result && r.result.value;
  return v ? JSON.parse(v) : null;
}
