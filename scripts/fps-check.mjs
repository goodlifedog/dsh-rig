import { overlayBase } from '../core/ports.mjs';
'use strict';
// 帧率压测：持续往小窗推帧，量实际帧率、单帧体积、抖动、内存。
//   node scripts/fps-check.mjs           默认 20 秒、目标 13fps
//   FPS_CHECK_SECONDS=60 FPS_CHECK_TARGET=15 node scripts/fps-check.mjs
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { launch } from '../core/browser.mjs';
import { localHeaders } from '../core/local-token.mjs';

const OVERLAY = overlayBase();
const SESSION = 'fps-check';
const SECONDS = Math.max(5, Number(process.env.FPS_CHECK_SECONDS) || 20);
const TARGET_FPS = Math.max(2, Number(process.env.FPS_CHECK_TARGET) || 13);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const getJson = async (url) => {
  try { return await (await fetch(url, { headers: localHeaders(), signal: AbortSignal.timeout(3000) })).json(); } catch { return null; }
};
const post = (p, body) => fetch(OVERLAY + p, {
  method: 'POST',
  headers: localHeaders({ 'Content-Type': 'application/json' }),
  body: JSON.stringify({ session: SESSION, ...(body || {}) }),
  signal: AbortSignal.timeout(5000),
}).then((r) => r.json()).catch(() => null);

function rssMb(pid) {
  if (!pid) return 0;
  try {
    const out = execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8', timeout: 5000 }).trim();
    return Math.round((Number(out) || 0) / 1024);
  } catch { return 0; }
}

const median = (arr) => {
  const a = arr.slice().sort((x, y) => x - y);
  return a.length ? a[Math.floor(a.length / 2)] : 0;
};

async function main() {
  const before = await getJson(OVERLAY + '/health?session=' + SESSION);
  const pid = (() => { try { return execFileSync('pgrep', ['-f', 'desktop-agent.*overlay'], { encoding: 'utf8' }).trim().split('\n')[0]; } catch { return ''; } })();

  const hello = await getJson(OVERLAY + '/health?session=__none__');
  if (!hello || !hello.ok) { console.log('❌ 小窗没起来（7788）'); process.exit(1); }
  const title = hello.dshTitle;

  await post('/status', { text: '帧率压测中', titleHint: title });
  const target = await (await fetch(OVERLAY + '/frame-target?session=' + SESSION)).json();
  const width = target.width || 600;
  let scale = Math.min(3, Math.max(0.3, width / 1280));

  const browser = await launch({ userDataDir: path.join(os.homedir(), '.desktop-agent', 'headless-profile'), headless: true, timeoutMs: 45000 });
  const page = await browser.connect({ timeoutMs: 20000 });
  await page.send('Page.enable');
  await page.send('Page.navigate', { url: 'https://github.com/iFurySt' });
  await sleep(2000);
  await post('/visible', { visible: true });
  // FPS_CHECK_EXPANDED=1：先切放大态再压测（1920 宽出图，是更吃力的场景）
  if (process.env.FPS_CHECK_EXPANDED === '1') {
    await post('/expand', {});
    await sleep(900);
  }
  const liveTarget = await (await fetch(OVERLAY + '/frame-target?session=' + SESSION)).json();
  if (liveTarget && liveTarget.width) {
    target.width = liveTarget.width;
    target.height = liveTarget.height;
    scale = Math.min(3, Math.max(0.3, liveTarget.width / 1280));
  }

  const rssStart = rssMb(pid);
  const pushTimes = [];
  const sizes = [];
  const fpsSamples = [];
  const startedAll = Date.now();
  const deadline = startedAll + SECONDS * 1000;
  let nextSample = startedAll + 1000;
  let sent = 0;

  while (Date.now() < deadline) {
    const frameStart = Date.now();
    const shot = await page.send('Page.captureScreenshot', { format: 'jpeg', quality: 80, clip: { x: 0, y: 0, width: 1280, height: 800, scale } });
    const bytes = Buffer.from(shot.data, 'base64').length;
    sizes.push(bytes);
    const r = await post('/frame', { dataUrl: 'data:image/jpeg;base64,' + shot.data, note: '帧率压测', cursor: { x: 700, y: 400, click: false }, width: target.width, height: target.height });
    sent += 1;
    pushTimes.push(Date.now() - frameStart);
    if (r && r.ok === false) break;

    if (Date.now() >= nextSample) {
      const h = await getJson(OVERLAY + '/health?session=' + SESSION);
      fpsSamples.push((h && h.fps) || 0);
      nextSample += 1000;
    }
    const period = Math.round(1000 / TARGET_FPS);
    const spent = Date.now() - frameStart;
    if (spent < period) await sleep(period - spent);
  }

  const elapsed = (Date.now() - startedAll) / 1000;
  const rssEnd = rssMb(pid);
  await page.send('Page.close').catch(() => {});
  await browser.close();
  await post('/status', { clear: true });
  await post('/visible', { visible: false });
  await fetch(OVERLAY + '/close', { method: 'POST', headers: localHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify({ session: SESSION }) }).catch(() => {});

  const actualFps = sent / elapsed;
  const validSamples = fpsSamples.filter((v) => v > 0);
  const avgSample = validSamples.length ? validSamples.reduce((a, b) => a + b, 0) / validSamples.length : 0;
  const avgBytes = sizes.length ? Math.round(sizes.reduce((a, b) => a + b, 0) / sizes.length) : 0;
  const rows = [
    ['时长', elapsed.toFixed(1) + 's，目标/实际帧率 ' + TARGET_FPS + ' / ' + actualFps.toFixed(1) + ' fps'],
    ['小窗自报帧率', validSamples.length ? '平均 ' + avgSample.toFixed(1) + '｜中位 ' + median(validSamples).toFixed(1) + '｜最低 ' + Math.min(...validSamples).toFixed(1) + '（' + fpsSamples.length + ' 次采样）' : '没有采样到有效帧率'],
    ['单帧体积', avgBytes + 'B（' + target.width + 'px 宽出图，' + (process.env.FPS_CHECK_EXPANDED === '1' ? '放大态' : '收起态') + '）'],
    ['推一帧耗时', '平均 ' + Math.round(pushTimes.reduce((a, b) => a + b, 0) / pushTimes.length) + 'ms｜中位 ' + median(pushTimes) + 'ms｜最长 ' + Math.max(...pushTimes) + 'ms'],
    ['小窗内存', rssStart + 'MB → ' + rssEnd + 'MB（变化 ' + (rssEnd - rssStart >= 0 ? '+' : '') + (rssEnd - rssStart) + 'MB）'],
  ];
  const w = Math.max(...rows.map((r) => r[0].length)) + 2;
  console.log('\n帧率压测\n');
  for (const [k, v] of rows) console.log('  ' + k.padEnd(w) + v);

  const problems = [];
  if (actualFps < Math.min(10, TARGET_FPS * 0.8)) problems.push('实际帧率 ' + actualFps.toFixed(1) + 'fps 低于目标');
  if (validSamples.length && Math.min(...validSamples) < 5) problems.push('出现 ' + Math.min(...validSamples).toFixed(1) + 'fps 的低谷');
  if (rssEnd - rssStart > 60) problems.push('内存增长 ' + (rssEnd - rssStart) + 'MB');
  console.log('\n' + (problems.length ? '需要关注：' + problems.join('；') : '帧率表现稳定') + '\n');
  process.exit(problems.length ? 1 : 0);
}

main().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
