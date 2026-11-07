#!/usr/bin/env node
/**
 * 并行演示：同时驱动两个独立后台浏览器，各自把画面推到自己那一路小窗。
 *
 * 两个浏览器是不同进程、不同 profile，互不干扰；两路小窗并排显示，
 * 全程不抢前台、不弹窗、桌面零窗口。
 *
 *   node core/tasks/parallel-demo.mjs
 */
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { launch } from '../browser.mjs';
import { localHeaders } from '../local-token.mjs';

const OVERLAY = process.env.OVERLAY_URL || 'http://127.0.0.1:7788';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SESSION_A = 'parallel-a';
const SESSION_B = 'parallel-b';

const getJson = async (url) => {
  try { return await (await fetch(url, { headers: localHeaders(), signal: AbortSignal.timeout(3000) })).json(); } catch { return null; }
};
const post = (pathname, body) => fetch(OVERLAY + pathname, {
  method: 'POST',
  headers: localHeaders({ 'Content-Type': 'application/json' }),
  body: JSON.stringify(body || {}),
  signal: AbortSignal.timeout(5000),
}).then((r) => r.json()).catch(() => null);

function frontmostName() {
  try {
    return execFileSync('/usr/bin/osascript', ['-e', 'tell application "System Events" to get name of first process whose frontmost is true'], { encoding: 'utf8' }).trim();
  } catch { return '(unknown)'; }
}

/** 让虚拟光标在两行之间来回移动，看起来像有人在操作 */
function cursorFor(phase, index) {
  const t = (index % 40) / 40;
  const wave = Math.sin(t * Math.PI * 2);
  return {
    x: Math.round(180 + wave * 120 + phase * 40),
    y: Math.round(150 + Math.cos(t * Math.PI * 2) * 70),
    click: index % 20 === 10,
  };
}

async function driveBrowser({ tag, session, url, userDataDir }) {
  const target = await getJson(OVERLAY + '/frame-target?session=' + encodeURIComponent(session));
  const dshTitle = (await getJson(OVERLAY + '/health?session=__none__'))?.dshTitle;

  const startedAt = Date.now();
  await post('/status', { session, text: tag + '：启动后台浏览器', titleHint: dshTitle });

  const browser = await launch({ userDataDir, headless: true, timeoutMs: 60000 });
  const page = await browser.connect({ timeoutMs: 25000 });
  await page.send('Page.enable');
  await page.send('Page.navigate', { url });
  await sleep(1200);

  const scale = Math.max(0.3, Math.min(2, (target?.width || 600) / 1280));
  const width = target?.width || 600;
  const height = target?.height || 380;

  // 页面内找第一个链接，准备一次拟人点击（分步移动 + 抖动）
  const link = await page.evaluate(`(() => {
    const a = document.querySelector('a');
    if (!a) return null;
    const r = a.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), text: (a.textContent || '').trim().slice(0, 40) };
  })()`);
  const linkPos = link || null;

  let frames = 0;
  for (let i = 0; i < 24; i += 1) {
    if (linkPos && i < 10) {
      // 分 10 步从左上角滑到链接中心
      const t = (i + 1) / 10;
      await page.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: Math.round(120 + (linkPos.x - 120) * t),
        y: Math.round(90 + (linkPos.y - 90) * t),
      });
    }
    if (linkPos && i === 10) {
      await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: linkPos.x, y: linkPos.y, button: 'left', clickCount: 1 });
      await sleep(60);
      await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: linkPos.x, y: linkPos.y, button: 'left', clickCount: 1 });
      await post('/log', { session, text: tag + '：点击「' + (linkPos.text || '链接') + '」' });
    }

    const shot = await page.send('Page.captureScreenshot', {
      format: 'jpeg',
      quality: 78,
      clip: { x: 0, y: 0, width: 1280, height: 800, scale },
    });
    await post('/frame', {
      session,
      dataUrl: 'data:image/jpeg;base64,' + shot.data,
      note: tag,
      cursor: cursorFor(tag === 'A' ? 0 : 1, i),
      width,
      height,
    });
    frames += 1;
    if (i === 0) await post('/status', { session, text: tag + '：页面已加载，正在后台操作', titleHint: dshTitle });
    await sleep(220);
  }

  const endedAt = Date.now();
  let title = '';
  try { title = await page.evaluate('document.title'); } catch {}
  await browser.close();
  await post('/status', { session, text: tag + '：完成（' + ((endedAt - startedAt) / 1000).toFixed(1) + 's）', titleHint: dshTitle });
  return { tag, session, frames, startedAt, endedAt, title };
}

async function main() {
  const before = frontmostName();
  console.log('开始前前台:', before);

  const baseDir = path.join(os.homedir(), '.desktop-agent');
  const [a, b] = await Promise.allSettled([
    driveBrowser({ tag: 'A', session: SESSION_A, url: 'https://example.com', userDataDir: path.join(baseDir, 'headless-profile-p1') }),
    driveBrowser({ tag: 'B', session: SESSION_B, url: 'https://www.iana.org/help/example-domains', userDataDir: path.join(baseDir, 'headless-profile-p2') }),
  ]);

  const results = [a, b].map((r) => (r.status === 'fulfilled' ? r.value : { error: String(r.reason).slice(0, 120) }));
  const after = frontmostName();

  const overlap = (() => {
    if (results.length < 2 || !results[0].startedAt || !results[1].startedAt) return 0;
    const start = Math.max(results[0].startedAt, results[1].startedAt);
    const end = Math.min(results[0].endedAt, results[1].endedAt);
    return Math.max(0, end - start);
  })();

  console.log('结果:', JSON.stringify({
    apps: results.map((r) => ({ tag: r.tag, session: r.session, frames: r.frames, title: r.title, error: r.error })),
    overlapMs: overlap,
    frontmostUnchanged: before === after,
    before,
    after,
  }, null, 2));
}

main().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
