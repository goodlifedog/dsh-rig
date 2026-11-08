import { overlayBase } from '../core/ports.mjs';
'use strict';
// 小窗外观监控：把小窗区域单独截出来，附带 /health 指标，用于改前改后对比。
//   node scripts/ui-check.mjs [标签]
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tokenHeadersFor } from '../core/local-token.mjs';
import { isScreenLocked } from '../core/platform.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const BASE = overlayBase();
const label = process.argv[2] || 'ui';

// 锁屏时截不到小窗区域（窗口本来就隐藏），按环境跳过
if (await isScreenLocked()) {
  console.log('环境跳过：屏幕已锁，截不到小窗（按设计隐藏）');
  process.exit(0);
}

function sh(cmd, args) {
  return execFileSync(cmd, args, { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
}

async function health() {
  const r = await fetch(BASE + '/health', { headers: tokenHeadersFor(BASE + '/health'), signal: AbortSignal.timeout(3000) });
  return await r.json();
}

async function setVisible(v) {
  await fetch(BASE + '/visible', { method: 'POST', headers: tokenHeadersFor(BASE + '/visible', { 'Content-Type': 'application/json' }), body: JSON.stringify({ visible: v }) });
}

async function main() {
  await setVisible(true);
  await new Promise((r) => setTimeout(r, 900));
  const h = await health();
  const b = h.bounds;
  if (!b) { console.error('没有 bounds，跳过'); process.exit(1); }

  const shotPath = path.join('/tmp', 'ui-shot-' + Date.now() + '.png');
  sh('screencapture', ['-x', shotPath]);
  const full = sh('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', shotPath]).toString();
  const pw = Number(/pixelWidth: (\d+)/.exec(full)[1]);
  const desktop = sh('osascript', ['-e', 'tell application "Finder" to get bounds of window of desktop']).toString();
  const dw = Number(desktop.split(',')[2].trim());
  const scale = pw / dw;

  const outDir = path.join(ROOT, 'overlay', 'docs');
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outPng = path.join(outDir, 'ui-' + label + '-' + stamp + '.png');
  sh('sips', ['-c', String(Math.round(b.height * scale)), String(Math.round(b.width * scale)),
    '--cropOffset', String(Math.round(b.y * scale)), String(Math.round(b.x * scale)), shotPath, '--out', outPng]);

  fs.rmSync(shotPath, { force: true });
  console.log('外观截图:', path.relative(ROOT, outPng));
  console.log('指标: fps=' + h.fps, 'frameBytes=' + h.frameBytes, 'clickThrough=' + h.clickThrough,
    'visible=' + h.visible, 'bounds=' + JSON.stringify(b));
}

main().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
