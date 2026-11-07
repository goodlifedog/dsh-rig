import { overlayUrl, overlayPort } from './ports.mjs';
'use strict';

/**
 * 平台自检：换机器（尤其 Windows）第一件事跑这个，看出哪一层能用。
 *   node core/platform-smoke.mjs
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMac, isWindows, platform, controlBackend, resolveOcu, dataDir } from './platform.mjs';
import { localHeaders } from './local-token.mjs';
import { daemonUrl, daemonPort } from './ports.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const rows = [];
function add(name, ok, detail) { rows.push({ name, ok, detail }); }

add('平台', true, platform + (isMac ? '（macOS）' : isWindows ? '（Windows）' : ''));
add('控制后端', controlBackend() !== 'unsupported', controlBackend());

if ((isMac || isWindows) && controlBackend() === 'ocu') {
  const ocu = resolveOcu();
  let ocuOk = false;
  try { await fsp.access(ocu); ocuOk = true; } catch {}
  add('ocu 可执行文件', ocuOk, ocu || 'not found');
} else if (isWindows && controlBackend() !== 'ocu') {
  const bridge = path.join(ROOT, 'tools', 'uia-bridge.ps1');
  let bridgeOk = false;
  try { await fsp.access(bridge); bridgeOk = true; } catch {}
  add('UIA 桥脚本', bridgeOk, bridge);
  if (bridgeOk) {
    try {
      const { execFile } = await import('node:child_process');
      const out = await new Promise((resolve) => execFile('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', bridge, 'selftest'],
        { timeout: 20000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => resolve(err ? '' : String(stdout || ''))));
      const line = out.split(/\r?\n/).filter((l) => l.trim().startsWith('{')).pop();
      const r = line ? JSON.parse(line) : null;
      const failed = r && r.checks ? r.checks.filter((c) => !c.ok).map((c) => c.name) : ['selftest 无输出'];
      add('UIA 自检', Boolean(r && r.ok), r && r.ok ? 'ok' : failed.join(', '));
    } catch (e) {
      add('UIA 自检', false, e.message);
    }
  }
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
  // overlay 也要 token（2026-11-08 起），不带票会被 401，doctor 会误报小窗不可用
  const r = await fetch(overlayUrl('/health'), { headers: localHeaders(), signal: AbortSignal.timeout(2000) });
  const d = await r.json();
  overlayOk = Boolean(d.ok);
  overlayInfo = 'pid=' + d.pid + ' sessions=' + (d.session || 'default');
} catch (e) { overlayInfo = '未启动'; }
add('小窗服务 ' + overlayPort(), overlayOk, overlayInfo);

// daemon 在线
let daemonOk = false;
let daemonInfo = '';
try {
  const r = await fetch(daemonUrl(), { signal: AbortSignal.timeout(2000) });
  const d = await r.json();
  daemonOk = Boolean(d.ok);
  // GET / 现在只回最小存活信息（ok/pid/uptimeSec），任务列表在需要票据的 /status 里，
  // 这里别再显示一个恒为 0 的 tasks=
  daemonInfo = 'pid=' + d.pid + (d.uptimeSec ? ' 运行 ' + d.uptimeSec + 's' : '');
} catch (e) { daemonInfo = '未启动'; }
add('后台 daemon ' + daemonPort(), daemonOk, daemonInfo);

const width = Math.max(...rows.map((r) => r.name.length)) + 2;
console.log('\n平台自检（' + platform + '）\n');
for (const r of rows) {
  console.log((r.ok ? '  ✅ ' : '  ❌ ') + r.name.padEnd(width) + (r.detail || ''));
}
const bad = rows.filter((r) => !r.ok);
console.log('\n' + (bad.length ? bad.length + ' 项未通过' : '全部通过') + '\n');
process.exit(bad.length ? 1 : 0);
