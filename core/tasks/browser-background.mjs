#!/usr/bin/env node
/**
 * 浏览器后台控制：独立实例 + CDP，全程不碰用户前台。
 *
 *   node core/tasks/browser-background.mjs
 *
 * 为什么不用用户的 Chrome：实测 Chrome 无论直接启动还是 open -g 启动，都会把前台抢走
 * （Chrome 自己会 activate）。要"后台且不跳转"，只能起独立实例：
 *   - headless：屏幕上零窗口，CDP 驱动，帧推给小窗回显
 */
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { launch } from '../browser.mjs';
import { isScreenLocked } from '../platform.mjs';
import { localHeaders } from '../local-token.mjs';

const OVERLAY = process.env.OVERLAY_URL || 'http://127.0.0.1:7788';
const SESSION = 'bg-browser';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const getJson = async (url) => {
  try { return await (await fetch(url, { headers: localHeaders(), signal: AbortSignal.timeout(3000) })).json(); } catch { return null; }
};
const post = (pathname, body) => fetch(OVERLAY + pathname, {
  method: 'POST',
  headers: localHeaders({ 'Content-Type': 'application/json' }),
  body: JSON.stringify(body || {}),
  signal: AbortSignal.timeout(5000),
}).then((r) => r.json()).catch(() => null);

function frontName() {
  try {
    return execFileSync('/usr/bin/osascript', ['-e', 'tell application "System Events" to get name of first process whose frontmost is true'], { encoding: 'utf8' }).trim();
  } catch { return '(unknown)'; }
}

async function main() {
  // 锁屏时前台断言没有意义（前台恒为 loginwindow），但 headless 浏览器本身照常能跑，
  // 所以照跑并在报告里标注"前台断言跳过"，别把整项都跳过、丢掉了可验证的部分
  const locked = await isScreenLocked();
  if (locked) console.log('提示：屏幕已锁 —— 前台断言将跳过，只验证后台浏览器是否真的能操作页面');
  const steps = [];
  const record = (name, ok, extra) => {
    steps.push(Object.assign({ name, ok }, extra || {}));
    console.log((ok ? '  ✅ ' : '  ❌ ') + name + (extra && extra.detail ? '  ' + extra.detail : ''));
  };

  const frontStart = frontName();
  const titleHint = (await getJson(OVERLAY + '/health?session=__none__'))?.dshTitle || '';
  console.log('起点前台:', frontStart, locked ? '（锁屏，前台断言跳过）' : '');

  // 1. 后台起独立浏览器（headless，屏幕上不会有窗口）
  const t0 = Date.now();
  const browser = await launch({
    userDataDir: path.join(os.homedir(), '.desktop-agent', 'headless-profile'),
    headless: true,
    timeoutMs: 60000,
  });
  const frontAfterLaunch = frontName();
  record('后台启动浏览器（headless）' + (locked ? '（前台断言跳过）' : ''), locked ? true : frontStart === frontAfterLaunch, {
    detail: '耗时 ' + (Date.now() - t0) + 'ms，前台 ' + frontStart + ' → ' + frontAfterLaunch,
  });

  const page = await browser.connect({ timeoutMs: 25000 });
  await page.send('Page.enable');

  // 2. 导航
  const navAt = Date.now();
  await page.send('Page.navigate', { url: 'https://example.com' });
  await sleep(900);
  const url1 = await page.evaluate('location.href').catch(() => '');
  record('打开页面', /example\.com/.test(String(url1)), { detail: '耗时 ' + (Date.now() - navAt) + 'ms，url=' + url1 });

  // 3. 把画面推到小窗（用户能看见它在后台干活）
  await post('/status', { session: SESSION, text: '后台浏览器：正在操作页面', titleHint });
  const target = await getJson(OVERLAY + '/frame-target?session=' + SESSION);
  const shot = await page.send('Page.captureScreenshot', {
    format: 'jpeg',
    quality: 80,
    clip: { x: 0, y: 0, width: 1280, height: 800, scale: Math.max(0.3, Math.min(2, (target?.width || 600) / 1280)) },
  });
  await post('/frame', {
    session: SESSION,
    dataUrl: 'data:image/jpeg;base64,' + shot.data,
    note: '后台浏览器',
    cursor: { x: 640, y: 400, click: false },
    width: target?.width,
    height: target?.height,
  });
  await post('/visible', { session: SESSION, visible: true });
  await sleep(600);
  const h = await getJson(OVERLAY + '/health?session=' + SESSION);
  record('画面回显到小窗', Boolean(h && h.thumbnail && h.thumbnail.state === 'live'), {
    detail: 'state=' + (h && h.thumbnail && h.thumbnail.state),
  });

  // 4. 找链接并拟人点击（CDP 输入，不碰系统指针）
  const link = await page.evaluate(`(() => {
    const a = document.querySelector('a');
    if (!a) return null;
    const r = a.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), text: (a.textContent || '').trim().slice(0, 40) };
  })()`).catch(() => null);
  if (link) {
    const clickAt = Date.now();
    for (let i = 1; i <= 8; i += 1) {
      await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(100 + (link.x - 100) * (i / 8)), y: Math.round(80 + (link.y - 80) * (i / 8)) });
      await sleep(12);
    }
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: link.x, y: link.y, button: 'left', clickCount: 1 });
    await sleep(60);
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: link.x, y: link.y, button: 'left', clickCount: 1 });
    await sleep(1200);
    const url2 = await page.evaluate('location.href').catch(() => '');
    const frontClick = frontName();
    record('后台点击链接并跳转', url1 !== url2, {
      detail: '「' + (link.text || '链接') + '」点击 ' + (Date.now() - clickAt) + 'ms，url=' + String(url1).slice(0, 30) + ' → ' + String(url2).slice(0, 40),
    });
    record('点击期间前台未变' + (locked ? '（前台断言跳过）' : ''), locked ? true : frontClick === frontStart, { detail: frontClick });
  } else {
    record('后台点击链接并跳转', false, { detail: '页面没有链接' });
  }

  // 5. 收尾
  const frontEnd = frontName();
  record('全程前台未变' + (locked ? '（前台断言跳过）' : ''), locked ? true : frontStart === frontEnd, { detail: frontStart + ' → ' + frontEnd });

  await browser.close();
  const report = { ok: steps.every((s) => s.ok), frontStart, frontEnd, steps };
  console.log('\n' + JSON.stringify(report, null, 2));

  const keepMs = Number(process.env.BG_KEEP_MS || 6000);
  if (keepMs > 0) await sleep(keepMs);
  await post('/status', { session: SESSION, clear: true });
  await post('/visible', { session: SESSION, visible: false });
  console.log('小窗已收起');
  if (!report.ok) process.exitCode = 1;
}

main().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
