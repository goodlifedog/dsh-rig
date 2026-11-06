'use strict';

/**
 * 平台自检：换机器（尤其 Windows）第一件事跑这个，看出哪一层能用。
 *   node core/platform-smoke.mjs
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMac, isWindows, platform, controlBackend, resolveOcu, dataDir } from './platform.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const rows = [];
function add(name, ok, detail) { rows.push({ name, ok, detail }); }

add('平台', true, platform + (isMac ? '（macOS）' : isWindows ? '（Windows）' : ''));
add('控制后端', controlBackend() !== 'unsupported', controlBackend());

if (isMac) {
  const ocu = resolveOcu();
  let ocuOk = false;
  try { await fsp.access(ocu); ocuOk = true; } catch {}
  add('ocu 可执行文件', ocuOk, ocu || 'not found');
} else if (isWindows) {
  const bridge = path.join(ROOT, 'tools', 'uia-bridge.ps1');
  let bridgeOk = false;
  try { await fsp.access(bridge); bridgeOk = true; } catch {}
  add('UIA 桥脚本', bridgeOk, bridge);
}

// 目录可写性
const dir = dataDir('smoke');
let dirOk = false;
try {
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, 'probe'), 'ok');
  dirOk = true;
} catch {}
add('数据目录可写', dirOk, dir);

// overlay 在线
let overlayOk = false;
let overlayInfo = '';
try {
  const r = await fetch('http://127.0.0.1:7788/health', { signal: AbortSignal.timeout(2000) });
  const d = await r.json();
  overlayOk = Boolean(d.ok);
  overlayInfo = 'pid=' + d.pid + ' sessions=' + (d.session || 'default');
} catch (e) { overlayInfo = '未启动'; }
add('小窗服务 7788', overlayOk, overlayInfo);

// daemon 在线
let daemonOk = false;
let daemonInfo = '';
try {
  const r = await fetch('http://127.0.0.1:7789/', { signal: AbortSignal.timeout(2000) });
  const d = await r.json();
  daemonOk = Boolean(d.ok);
  daemonInfo = 'pid=' + d.pid + ' tasks=' + (d.tasks ? d.tasks.length : 0);
} catch (e) { daemonInfo = '未启动'; }
add('后台 daemon 7789', daemonOk, daemonInfo);

const width = Math.max(...rows.map((r) => r.name.length)) + 2;
console.log('\n平台自检（' + platform + '）\n');
for (const r of rows) {
  console.log((r.ok ? '  ✅ ' : '  ❌ ') + r.name.padEnd(width) + (r.detail || ''));
}
const bad = rows.filter((r) => !r.ok);
console.log('\n' + (bad.length ? bad.length + ' 项未通过' : '全部通过') + '\n');
process.exit(bad.length ? 1 : 0);
