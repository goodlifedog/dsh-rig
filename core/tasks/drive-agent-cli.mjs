#!/usr/bin/env node
import { overlayBase } from '../ports.mjs';
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
import { getOcuMcp, closeOcuMcp } from '../ocu-mcp.mjs';
import { restoreFront } from '../front-watch.mjs';
import { isScreenLocked } from '../platform.mjs';
import { frontName as sharedFrontName, isAppRunning } from '../background.mjs';
import { requireAppRunning, reportAppPresence } from '../app-presence.mjs';
import { tokenHeadersFor } from '../local-token.mjs';

const APP = process.env.CLI_TERM_APP || 'Ghostty';
const ALLOW_FRONT_RISK = process.env.AGENT_DRIVE_ALLOW_FRONT_RISK === '1';
const PROMPT = process.env.CLI_PROMPT || '只回复两个字：收到';
const CUSTOM_CMD = process.env.CLI_CMD || '';
const TIMEOUT_MS = Math.max(10000, Number(process.env.CLI_TIMEOUT_MS) || 240000);
const SESSION = 'agent-cli';
const OVERLAY = overlayBase();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 读当前前台应用名（H2 缺口 A：不再对 System Events 发 AppleEvent）。
 * 复用 core/background.mjs 的 frontName()（ObjC/NSWorkspace），薄包装保持旧语义：
 * 拿不到返回 ''（共享实现失败时返回 '(unknown)'）。
 * @param {() => Promise<string>} [reader] 单测注入用
 */
export async function front(reader = sharedFrontName) {
  try {
    const value = String((await reader()) || '').trim();
    return value === '(unknown)' ? '' : value;
  } catch {
    return '';
  }
}
const getJson = async (url) => {
  try { return await (await fetch(url, { headers: tokenHeadersFor(url), signal: AbortSignal.timeout(3000) })).json(); } catch { return null; }
};
const post = (pathname, body) => fetch(OVERLAY + pathname, {
  method: 'POST',
  headers: tokenHeadersFor(OVERLAY + pathname, { 'Content-Type': 'application/json' }),
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

  // ocu 对未运行的应用会把它启动并顶到前台：先确认在运行，再碰任何 ocu 接口。
  // 判定/探测收在 core/app-presence.mjs（纯函数 + 注入 isAppRunning），与 P0 批次B 用同一套闸门。
  const presence = await requireAppRunning(APP, { isAppRunning });
  if (reportAppPresence(presence)) {
    console.log(JSON.stringify({ ok: true, skipped: true, reason: 'app-not-running', app: APP }));
    await closeOcuMcp().catch(() => {});
    return;
  }

  const before = await front();

  // 往用户终端里敲命令并回车，必须先确认没有把用户没写完的命令拼上去（同 terminal-control）
  const { frontRiskGate, readSafe } = await import('../background.mjs');
  const { decideTerminalType, lastNonEmptyLine } = await import('../terminal-guard.mjs');
  const { hidIdleMs } = await import('../front-watch.mjs');
  const risk = frontRiskGate();
  const riskSkip = !ALLOW_FRONT_RISK && risk.shouldSkip(APP);
  let lastLine = '';
  if (!riskSkip) {
    const rd = await readSafe(APP, { timeoutMs: 5000 });
    lastLine = lastNonEmptyLine(rd.text);
  }
  const decision = decideTerminalType({
    app: APP,
    frontApp: before,
    hidIdleMs: await hidIdleMs(),
    riskSkip,
    lastLine,
  });
  if (!decision.ok) {
    console.log('环境跳过：' + decision.reason + (riskSkip ? '（要强行驱动：AGENT_DRIVE_ALLOW_FRONT_RISK=1）' : ''));
    await closeOcuMcp().catch(() => {});
    return;
  }

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
  const afterType = await front();
  if (afterType !== before) await restoreFront(before);
  record('后台键入命令', !typed.isError && afterType === before, afterType === before ? '' : '前台被抢（已还原）');

  const enter = await m.callTool('press_key', { app: APP, key: 'ENTER', key_method: 'sky_key' });
  const afterEnter = await front();
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

  const end = await front();
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

// 导入本模块（单测拿薄包装）时不要执行任务本体；runner/daemon 仍然是 spawn node <file>。
const invokedDirectly = Boolean(process.argv[1])
  && (await import('node:path')).resolve(process.argv[1]) === (await import('node:url')).fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
}
