'use strict';
// 跨平台控制层演示：验证「同一套调用，macOS 走 ocu、Windows 走 UIA」。
// macOS 只读界面（不点击），Windows 尝试读记事本。
import { execFile } from 'node:child_process';
import { isMac, isWindows, controlBackend } from '../platform.mjs';
import * as uia from '../backends/uia.mjs';

const OCU = process.env.OCU_BIN || '';

function run(cmd, args, timeout = 60000) {
  return new Promise((resolve) => execFile(cmd, args, { timeout, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, OPEN_COMPUTER_USE_VISUAL_CURSOR: '0' } },
    (err, stdout) => resolve({ ok: !err, out: (stdout || '').trim() })));
}

async function ocuState(appName) {
  const script = 'var app = await cua.getApp(' + JSON.stringify(appName) + ', { initialState: false });' +
    'var s = await app.getAXState({ includeScreenshot: false, maxTreeNodes: 3000 });' +
    'var t = typeof s === "string" ? s : JSON.stringify(s);' +
    'nodeRepl.write(JSON.stringify({ lines: t.split("\\n").length }));';
  const fs = await import('node:fs/promises');
  const tmp = '/tmp/ocu-platform-demo.mjs';
  await fs.writeFile(tmp, script);
  const r = await run(OCU || 'ocu', ['js', '--timeout', '45000', '--file', tmp]);
  await fs.rm(tmp, { force: true });
  const line = r.out.split('\n').filter((x) => x.trim().startsWith('{')).pop();
  return line ? JSON.parse(line) : null;
}

async function main() {
  const backend = controlBackend();
  console.log('控制后端:', backend);

  if (isMac) {
    const target = process.env.TARGET_APP || 'Google Chrome';
    // 锁屏下 AX 不可用：如实环境跳过，不产出假失败
    const { isScreenLocked, lockedSkipNotice } = await import('../platform.mjs');
    if (await isScreenLocked()) {
      console.log(lockedSkipNotice('platform-demo.mjs'));
      console.log(JSON.stringify({ ok: true, backend: 'ocu', app: target, skipped: true, reason: 'screen-locked' }));
      return;
    }
    // 读 Chrome 界面树可能让它自己跳前台：走前台风险名单 + 读后还原
    const bg = await import('../background.mjs');
    const risk = bg.frontRiskGate();
    if (risk.shouldSkip(target)) {
      console.log('环境跳过：' + target + ' 读取会抢前台（前台风险名单），先不读它的界面树');
      console.log(JSON.stringify({ ok: true, backend: 'ocu', app: target, skipped: true, reason: 'front-risk' }));
      return;
    }
    const frontBefore = await bg.frontName();
    const state = await ocuState(target);
    const settled = await bg.settleFront(frontBefore, { waitMs: 200, retries: 2 });
    if (settled.stolen) {
      risk.note(target);
      console.error('提示：读取期间前台被 ' + target + ' 抢走，已' + (settled.restored ? '还原到 ' + frontBefore : '尝试还原（未成功）') + '，并记入前台风险名单');
    }
    if (!state) throw new Error('读不到 ' + target + ' 的界面树（应用没运行或没有辅助功能权限）');
    console.log('macOS 通路 OK：' + target + ' 界面树 ' + state.lines + ' 行');
    console.log(JSON.stringify({ ok: true, backend: 'ocu', app: target, lines: state.lines }));
    return;
  }

  if (isWindows) {
    const target = process.env.TARGET_APP || 'notepad';
    const tree = await uia.snapshot(target);
    console.log('Windows 通路 OK：' + target + ' 共 ' + tree.elements.length + ' 个元素');
    console.log(JSON.stringify({ ok: true, backend: 'uia', app: target, elements: tree.elements.length }));
    return;
  }

  throw new Error('不支持的平台: ' + process.platform);
}

main().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
