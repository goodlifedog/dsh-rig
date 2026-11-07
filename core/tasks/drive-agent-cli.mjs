#!/usr/bin/env node
/**
 * 通过后台终端驱动 agent CLI（opencode / codex / claude 等），并把结果读回来。
 *
 *   node core/tasks/drive-agent-cli.mjs
 *   CLI_PROMPT="只回复两个字：收到" node core/tasks/drive-agent-cli.mjs
 *   CLI_CMD="opencode models | head -5" node core/tasks/drive-agent-cli.mjs
 *
 * 做法：把命令敲进 Ghostty（后台键入，不激活窗口），输出重定向到临时文件再读回。
 * 为什么不用读终端内容：AX 的终端文本会被截断，读文件更可靠。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { getOcuMcp, closeOcuMcp } from '../ocu-mcp.mjs';
import { restoreFront } from '../front-watch.mjs';
import { isScreenLocked } from '../platform.mjs';

const APP = process.env.CLI_TERM_APP || 'Ghostty';
const PROMPT = process.env.CLI_PROMPT || '只回复两个字：收到';
const CUSTOM_CMD = process.env.CLI_CMD || '';
const TIMEOUT_MS = Math.max(10000, Number(process.env.CLI_TIMEOUT_MS) || 240000);
const SESSION = 'agent-cli';
const OVERLAY = process.env.OVERLAY_URL || 'http://127.0.0.1:7788';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function front() {
  try {
    return execFileSync('/usr/bin/osascript', ['-e', 'tell application "System Events" to get name of first process whose frontmost is true'], { encoding: 'utf8' }).trim();
  } catch { return '(unknown)'; }
}
const getJson = async (url) => {
  try { return await (await fetch(url, { signal: AbortSignal.timeout(3000) })).json(); } catch { return null; }
};
const post = (pathname, body) => fetch(OVERLAY + pathname, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body || {}),
  signal: AbortSignal.timeout(5000),
}).then((r) => r.json()).catch(() => null);

const steps = [];
function record(name, ok, detail) {
  steps.push({ name, ok, detail: detail || '' });
  console.log((ok ? '  ✅ ' : '  ❌ ') + name + (detail ? '  ' + detail : ''));
}

function stripAnsi(text) {
  return String(text || '').replace(/\u001b\[[0-9;]*m/g, '').replace(/\u001b\][^\u0007]*\u0007/g, '');
}

async function main() {
  if (await isScreenLocked()) {
    console.log('环境跳过：屏幕已锁，键盘通路不可用，等解锁后再跑');
    return;
  }

  const before = front();
  const titleHint = (await getJson(OVERLAY + '/health?session=__none__'))?.dshTitle || '';
  const outFile = path.join(os.tmpdir(), 'dsh-agent-' + Date.now().toString(36) + '.txt');
  const doneFile = outFile + '.done';
  const cmd = (CUSTOM_CMD || ('opencode run ' + JSON.stringify(PROMPT))) + ' > ' + outFile + ' 2>&1; echo done > ' + doneFile;

  console.log('终端:', APP, '| 命令:', (CUSTOM_CMD || 'opencode run <prompt>'), '| 起点前台:', before);

  // 镜像终端窗口，方便观察
  const list = await getJson(OVERLAY + '/windows');
  const term = ((list && list.windows) || []).find((w) => new RegExp(APP, 'i').test(w.owner || w.title || ''));
  if (term) {
    await post('/status', { session: SESSION, text: 'agent CLI：后台执行中', titleHint });
    await post('/window', { session: SESSION, windowId: term.windowId });
    await post('/visible', { session: SESSION, visible: true });
  }

  const m = await getOcuMcp();
  const typed = await m.callTool('type_text', { app: APP, text: cmd, key_method: 'sky_key' });
  const afterType = front();
  if (afterType !== before) await restoreFront(before);
  record('后台键入命令', !typed.isError && afterType === before, afterType === before ? '' : '前台被抢（已还原）');

  const enter = await m.callTool('press_key', { app: APP, key: 'ENTER', key_method: 'sky_key' });
  const afterEnter = front();
  if (afterEnter !== before) await restoreFront(before);
  record('后台提交执行', !enter.isError && afterEnter === before, afterEnter === before ? '' : '前台被抢（已还原）');

  // 等输出文件出现（agent 可能要跑几十秒）
  const started = Date.now();
  let finished = false;
  let lastSize = 0;
  while (Date.now() - started < TIMEOUT_MS) {
    await sleep(1500);
    const size = fs.existsSync(outFile) ? fs.statSync(outFile).size : 0;
    if (size !== lastSize) {
      console.log('  ' + Math.round((Date.now() - started) / 1000) + 's 输出 ' + size + ' 字节');
      lastSize = size;
    }
    if (fs.existsSync(doneFile)) { finished = true; break; }
  }
  const rawOutput = fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8') : '';
  const output = stripAnsi(rawOutput).trim();
  record('agent 执行完成', finished, finished ? Math.round((Date.now() - started) / 1000) + 's' : '超时未结束（已放弃等待）');
  record('拿到输出', output.length > 0, output ? output.slice(-80).replace(/\n/g, ' / ') : '空输出');

  const end = front();
  record('全程前台未变', before === end, before + ' -> ' + end);

  const report = {
    ok: steps.every((s) => s.ok),
    app: APP,
    prompt: CUSTOM_CMD ? null : PROMPT,
    command: CUSTOM_CMD || ('opencode run ' + JSON.stringify(PROMPT)),
    finished,
    durationMs: Date.now() - started,
    outputTail: output.slice(-400),
    frontStart: before,
    frontEnd: end,
    steps,
  };
  console.log('\n' + JSON.stringify(report, null, 2));

  try { fs.unlinkSync(outFile); } catch {}
  try { fs.unlinkSync(doneFile); } catch {}

  const keepMs = Number(process.env.AGENT_KEEP_MS || 8000);
  if (keepMs > 0) await sleep(keepMs);
  await post('/window', { session: SESSION, windowId: null });
  await post('/status', { session: SESSION, clear: true });
  await post('/visible', { session: SESSION, visible: false });
  await closeOcuMcp().catch(() => {});
  if (!report.ok) process.exitCode = 1;
}

main().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
