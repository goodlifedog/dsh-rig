import { daemonUrl, overlayUrl } from '../core/ports.mjs';
'use strict';
// 一条命令跑起来：后台 daemon + 小窗。Ctrl+C 一起停。
//   npm start
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const DAEMON = path.join(ROOT, 'core', 'daemon.mjs');
const OVERLAY_START = path.join(ROOT, 'overlay', 'start.mjs');

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function daemonAlive() {
  try {
    const r = await fetch(daemonUrl('/'), { signal: AbortSignal.timeout(1200) });
    const d = await r.json();
    return Boolean(d && d.ok);
  } catch { return false; }
}

const children = [];
function shutdown(code = 0) {
  for (const c of children) { try { c.kill('SIGTERM'); } catch {} }
  setTimeout(() => process.exit(code), 400);
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

async function overlayAlive() {
  try {
    await fetch(overlayUrl('/health'), { signal: AbortSignal.timeout(1200) });
    return true;   // 能拿到响应就说明在跑（401 也算：服务活着，只是要 token）
  } catch { return false; }
}

async function main() {
  if (!fs.existsSync(OVERLAY_START)) {
    console.error('overlay 依赖未安装，先执行：npm run setup');
    process.exit(1);
  }

  if (await daemonAlive()) {
    console.log('[start] daemon 已在运行，复用 7789');
  } else {
    fs.mkdirSync(path.join(ROOT, 'logs'), { recursive: true });
    const out = fs.openSync(path.join(ROOT, 'logs', 'daemon.out'), 'a');
    const d = spawn(process.execPath, [DAEMON], { cwd: ROOT, stdio: ['ignore', out, out], env: { ...process.env, OPEN_COMPUTER_USE_VISUAL_CURSOR: '0' } });
    children.push(d);
    let ok = false;
    for (let i = 0; i < 30; i++) {
      await sleep(300);
      if (await daemonAlive()) { ok = true; break; }
    }
    if (!ok) { console.error('[start] daemon 启动失败，看 logs/daemon.out'); shutdown(1); return; }
    console.log('[start] daemon 就绪 7789');
  }

  if (await overlayAlive()) {
    console.log('[start] 小窗已在运行，跳过（要重启用 npm run service:restart）');
    return;
  }

  console.log('[start] 启动小窗…');
  const o = spawn(process.execPath, [OVERLAY_START], { cwd: ROOT, stdio: 'inherit' });
  children.push(o);
  o.on('exit', (code) => shutdown(code === null ? 0 : code));
}

main().catch((e) => { console.error('FAIL:', e.message); shutdown(1); });
