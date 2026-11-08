import { overlayUrl, overlayPort } from '../core/ports.mjs';
'use strict';
// 重启自检：把两个服务真正重启一遍再验证健康，专门用来抓「跑的是内存里的旧代码」这类问题。
//   node scripts/restart-check.mjs
import { execFile } from 'node:child_process';
import { isMac, isWindows } from '../core/platform.mjs';
import { tokenHeadersFor } from '../core/local-token.mjs';
import { daemonUrl, daemonPort } from '../core/ports.mjs';

// 0.8.0 改名后必须用新标签（旧 com.desktop-agent.* 在 service install 时会被清掉）
const LABELS = ['com.goodlifedog.dsh-rig.daemon', 'com.goodlifedog.dsh-rig.overlay'];

function run(cmd, args, timeout = 30000) {
  return new Promise((resolve) => execFile(cmd, args, { timeout }, (err, stdout, stderr) =>
    resolve({ ok: !err, out: (stdout || '').trim(), err: (stderr || '').trim() })));
}

async function restartMac() {
  const uid = String(process.getuid ? process.getuid() : 501);
  for (const label of LABELS) {
    const r = await run('launchctl', ['kickstart', '-k', 'gui/' + uid + '/' + label]);
    console.log((r.ok ? '  重启 ' : '  重启失败 ') + label + (r.ok ? '' : ': ' + r.err));
  }
}

async function restartWin() {
  for (const name of ['dsh-rig-daemon', 'dsh-rig-overlay']) {
    await run('schtasks', ['/End', '/TN', name]);
    const r = await run('schtasks', ['/Run', '/TN', name]);
    console.log((r.ok ? '  重启 ' : '  重启失败 ') + name);
  }
}

async function probe(url, name) {
  const started = Date.now();
  while (Date.now() - started < 25000) {
    try {
      const r = await fetch(url, { headers: tokenHeadersFor(url), signal: AbortSignal.timeout(2000) });
      const d = await r.json();
      if (d && d.ok) return { ok: true, pid: d.pid };
    } catch {}
    await new Promise((res) => setTimeout(res, 500));
  }
  return { ok: false };
}

async function main() {
  if (!isMac && !isWindows) { console.error('不支持的平台'); process.exit(1); }
  console.log('重启服务并验证…');
  if (isMac) await restartMac();
  else await restartWin();

  const overlay = await probe(overlayUrl('/health'), 'overlay');
  const daemon = await probe(daemonUrl(), 'daemon');
  const rows = [
    ['小窗服务 ' + overlayPort(), overlay.ok, 'pid=' + (overlay.pid || '-')],
    ['后台 daemon ' + daemonPort(), daemon.ok, 'pid=' + (daemon.pid || '-')],
  ];
  console.log('');
  for (const [name, ok, detail] of rows) console.log((ok ? '  ✅ ' : '  ❌ ') + name + '  ' + detail);
  const bad = rows.filter((r) => !r[1]).length;
  console.log('\n' + (bad ? bad + ' 项未通过' : '全部通过') + '\n');
  process.exit(bad ? 1 : 0);
}

main().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
