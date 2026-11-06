'use strict';
// 生成小窗各状态的外观截图（running / error / expanded），仅供内部评审。
// 注意：底图是 best-effort（headless 截图偶尔会被错误态覆盖），正式展示图用 overlay/docs/ui-after*.png。
//   node scripts/ui-gallery.mjs
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const BASE = 'http://127.0.0.1:7788';
const DOCS = path.join(ROOT, 'overlay', 'docs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function post(p, body) {
  return fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}), signal: AbortSignal.timeout(5000) });
}
async function health() {
  const r = await fetch(BASE + '/health', { signal: AbortSignal.timeout(3000) });
  return r.json();
}

function shot(name) {
  fs.mkdirSync(DOCS, { recursive: true });
  const out = path.join('/tmp', 'gallery-' + name + '.png');
  execFileSync('screencapture', ['-x', out]);
  const full = execFileSync('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', out]).toString();
  const pw = Number(/pixelWidth: (\d+)/.exec(full)[1]);
  const desktop = execFileSync('osascript', ['-e', 'tell application "Finder" to get bounds of window of desktop']).toString();
  const dw = Number(desktop.split(',')[2].trim());
  const scale = pw / dw;
  const h = healthCache;
  const b = h.bounds;
  const dest = path.join(DOCS, 'ui-gallery-' + name + '.png');
  execFileSync('sips', ['-c', String(Math.round(b.height * scale)), String(Math.round(b.width * scale)),
    '--cropOffset', String(Math.round(b.y * scale)), String(Math.round(b.x * scale)), out, '--out', dest]);
  fs.rmSync(out, { force: true });
  console.log('  截图:', path.relative(ROOT, dest), '(' + b.width + 'x' + b.height + ')');
}

let healthCache = null;
async function captureState(name) {
  healthCache = await health();
  if (!healthCache.bounds) { console.log('  跳过（无 bounds）'); return; }
  shot(name);
}

async function main() {
  console.log('生成状态截图…');
  // 先重启小窗，保证从干净状态开始（错误态会一直挂到下一次成功抓帧）
  try {
    execFileSync('launchctl', ['kickstart', '-k', 'gui/' + String(process.getuid()) + '/com.desktop-agent.overlay']);
    await sleep(7000);
  } catch (e) { console.log('  重启失败:', e.message); }

  // 0. 用 headless 页面当底图，画面干净、看得出是在后台跑
  try {
    const { launch } = await import('../core/browser.mjs');
    const os = await import('node:os');
    const b = await launch({ userDataDir: path.join(os.homedir(), '.desktop-agent', 'headless-profile'), headless: true, timeoutMs: 45000 });
    const pg = await b.connect({ timeoutMs: 20000 });
    await pg.send('Page.enable');
    await pg.send('Page.navigate', { url: 'https://example.com' });
    await sleep(1200);
    const shotRes = await pg.send('Page.captureScreenshot', { format: 'jpeg', quality: 80, clip: { x: 0, y: 0, width: 1280, height: 800, scale: 2 } });
    await post('/frame', { dataUrl: 'data:image/jpeg;base64,' + shotRes.data, note: 'gallery 底图', cursor: { x: 700, y: 420, click: false } });
    await b.close();
  } catch (e) { console.log('  底图失败:', e.message); }
  await sleep(600);

  // 0b. 清掉可能残留的错误
  await post('/window', { windowId: null });
  try {
    const wins = await (await fetch(BASE + '/windows', { signal: AbortSignal.timeout(3000) })).json();
    const self = (wins.windows || []).find((w) => w.self);
    if (self) {
      const f = path.join('/tmp', 'gallery-src.png');
      execFileSync('screencapture', ['-x', '-o', '-l', String(self.windowId), f]);
      const b64 = fs.readFileSync(f).toString('base64');
      await post('/frame', { dataUrl: 'data:image/png;base64,' + b64, note: 'gallery 底图' });
      fs.rmSync(f, { force: true });
    }
  } catch (e) { console.log('  底图失败:', e.message); }
  await sleep(800);

  // 1. running
  await post('/visible', { visible: true });
  await post('/status', { text: '正在后台读取岗位列表（拟人节奏）' });
  await sleep(1500);
  await captureState('running');

  // 2. expanded
  await post('/expand');
  await sleep(1500);
  await captureState('expanded');
  await post('/expand');
  await sleep(800);

  // 3. error
  await post('/window', { windowId: 999999999 });
  await sleep(1800);
  await captureState('error');

  // 收尾：清错误、清掉演示用状态文字、恢复默认
  await post('/window', { windowId: null });
  await post('/status', { clear: true });
  await post('/visible', { visible: false });
  console.log('完成');
}

main().catch(async (e) => {
  console.error('FAIL:', e.message);
  // 即使中途失败也要把演示状态清掉，别让残影挂着
  await post('/status', { clear: true }).catch(() => {});
  await post('/window', { windowId: null }).catch(() => {});
  process.exit(1);
});