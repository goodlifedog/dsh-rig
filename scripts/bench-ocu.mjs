'use strict';
// ocu 效率基线：对比「MCP 常驻」与「每次 spawn CLI」的实际耗时。
//   node scripts/bench-ocu.mjs [轮数]
import { execFile } from 'node:child_process';
import { getOcuMcp, closeOcuMcp } from '../core/ocu-mcp.mjs';
import { resolveOcu, bundledOcu } from '../core/platform.mjs';
import { isAppRunning } from '../core/background.mjs';
import { requireAppRunning, reportAppPresence } from '../core/app-presence.mjs';

const ROUNDS = Number(process.argv[2] || 5);
const APP = process.env.TARGET_APP || 'Google Chrome';
// 默认目标就是用户的 Chrome：没在跑时绝不代劳启动（会带登录 profile 并抢前台）。
// 确实要用一个当前没运行的应用做基线，显式加 --allow-launch。
const ALLOW_LAUNCH = process.argv.includes('--allow-launch');

function spawnCli(args, timeout = 60000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    execFile(resolveOcu(), args, { timeout, maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, OPEN_COMPUTER_USE_VISUAL_CURSOR: '0' } },
      (err, stdout) => resolve({ ms: Date.now() - t0, ok: !err, out: stdout || '' }));
  });
}

function stats(values) {
  const s = values.slice().sort((a, b) => a - b);
  const avg = s.reduce((a, b) => a + b, 0) / s.length;
  return { avg: Math.round(avg), min: s[0], max: s[s.length - 1], n: s.length };
}

async function main() {
  console.log('ocu:', resolveOcu());
  console.log('bundled:', bundledOcu() || '(未附带运行时，用全局安装)');

  // 0. 目标应用在不在跑：没在跑就跳过（exit 0），不为了测基线把用户的 Chrome 拉起来
  const presence = await requireAppRunning(APP, { isAppRunning, allowLaunch: ALLOW_LAUNCH });
  if (reportAppPresence(presence)) {
    console.log('（确实要用一个当前没运行的应用做基线：node scripts/bench-ocu.mjs ' + ROUNDS + ' --allow-launch）');
    return;
  }

  // 1. CLI 每次 spawn
  const cliList = [], cliState = [];
  for (let i = 0; i < ROUNDS; i++) {
    const r = await spawnCli(['call', 'list_apps']);
    if (r.ok) cliList.push(r.ms);
    const s = await spawnCli(['call', 'get_app_state', '--args', JSON.stringify({ app: APP, include_screenshot: false })]);
    if (s.ok) cliState.push(s.ms);
  }

  // 2. MCP 常驻
  const t0 = Date.now();
  const mcp = await getOcuMcp();
  const handshake = Date.now() - t0;
  const mcpList = [], mcpState = [];
  for (let i = 0; i < ROUNDS; i++) {
    const a = Date.now();
    await mcp.callTool('list_apps', {});
    mcpList.push(Date.now() - a);
    const b = Date.now();
    await mcp.callTool('get_app_state', { app: APP, include_screenshot: false }, 45000);
    mcpState.push(Date.now() - b);
  }
  await closeOcuMcp();

  const rows = [
    ['CLI list_apps', stats(cliList)],
    ['MCP list_apps', stats(mcpList)],
    ['CLI get_app_state', stats(cliState)],
    ['MCP get_app_state', stats(mcpState)],
  ];
  console.log('\n握手(MCP):', handshake, 'ms');
  console.log('轮数:', ROUNDS, '| 应用:', APP, '\n');
  for (const [name, s] of rows) console.log('  ' + name.padEnd(18), 'avg=' + s.avg + 'ms', 'min=' + s.min, 'max=' + s.max);
  const speedupState = cliState.length && mcpState.length ? (stats(cliState).avg / stats(mcpState).avg).toFixed(1) + 'x' : 'n/a';
  const speedupList = cliList.length && mcpList.length ? (stats(cliList).avg / stats(mcpList).avg).toFixed(1) + 'x' : 'n/a';
  console.log('\n提速：list_apps', speedupList, '| get_app_state', speedupState);
}

main().catch(async (e) => { await closeOcuMcp(); console.error('FAIL:', e.message); process.exit(1); });
