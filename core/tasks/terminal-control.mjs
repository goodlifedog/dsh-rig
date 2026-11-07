#!/usr/bin/env node
/**
 * 终端类后台控制验收：在 Ghostty 里敲一条无害命令，确认输出出现、前台未变。
 *
 *   node core/tasks/terminal-control.mjs
 *
 * 只敲 echo，不执行任何有副作用的命令。
 */
import { frontName, state, find, typeText } from '../background.mjs';
import { restoreFront } from '../front-watch.mjs';
import { isScreenLocked, lockedSkipNotice } from '../platform.mjs';
import { getOcuMcp, closeOcuMcp } from '../ocu-mcp.mjs';

const APP = process.env.TERM_APP || 'Ghostty';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const steps = [];
const record = (name, ok, extra) => {
  steps.push(Object.assign({ name, ok }, extra || {}));
  console.log((ok ? '  ✅ ' : '  ❌ ') + name + (extra && extra.detail ? '  ' + extra.detail : ''));
};

async function pressEnter(app) {
  const m = await getOcuMcp();
  const before = await frontName();
  const r = await m.callTool('press_key', { app, key: 'ENTER', key_method: 'sky_key' });
  const after = await frontName();
  const stolen = before !== after;
  if (stolen) await restoreFront(before);
  return { ok: !r.isError, stolen };
}

async function main() {
  if (await isScreenLocked()) { console.log(lockedSkipNotice('terminal-control.mjs')); return; }
  if (await isScreenLocked()) {
    console.log('环境跳过：屏幕已锁，键盘与 AX 通路不可用，等解锁后再跑');
    return;
  }

  const before = await frontName();
  const marker = 'dsh-bg-' + Date.now().toString(36);
  console.log('目标应用:', APP, '| 起点前台:', before, '| 标记:', marker);

  const areas = await find(APP, { role: 'AXTextArea', limit: 5 }).catch(() => []);
  record('读到终端文本区', areas.length > 0, { detail: areas.length + ' 个' });
  if (!areas.length) {
    await closeOcuMcp().catch(() => {});
    process.exitCode = 1;
    return;
  }

  const typed = await typeText(APP, 'echo ' + marker);
  record('后台键入命令', typed.ok && typed.frontUnchanged !== false, { detail: typed.frontUnchanged === false ? '前台被抢（已还原）' : '' });
  await sleep(250);

  const enter = await pressEnter(APP);
  record('后台回车执行', enter.ok && !enter.stolen, { detail: enter.stolen ? '前台被抢（已还原）' : '' });
  await sleep(800);

  const tree = await state(APP).catch(() => '');
  const seen = String(tree || '').includes(marker);
  record('终端输出里能看到命令与结果', seen);

  const after = await frontName();
  record('全程前台未变', before === after, { detail: before + ' -> ' + after });

  const report = { ok: steps.every((s) => s.ok), app: APP, marker, frontStart: before, frontEnd: after, steps };
  console.log('\n' + JSON.stringify(report, null, 2));
  await closeOcuMcp().catch(() => {});
  if (!report.ok) process.exitCode = 1;
}

main().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
