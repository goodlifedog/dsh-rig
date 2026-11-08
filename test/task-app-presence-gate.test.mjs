'use strict';
// P0 批次A：终端/agent 驱动任务必须先确认目标应用在运行（否则 ocu 会把它拉起并顶到前台）。
//
// 这三条任务现在统一走 core/app-presence.mjs 的闸门（requireAppRunning + reportAppPresence），
// 本测试覆盖两件事：
//   1) 闸门本身用注入的 isRunning 走完所有分支（不发任何系统命令）；
//   2) 三个任务文件的「运行检查」确实排在第一次 raw ocu 调用之前（静态顺序回归，防止以后改回去）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  requireAppRunning, reportAppPresence, decideAppPresence, probeArgsForApp, NOT_RUNNING_HINT,
} from '../core/app-presence.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const TASKS = [
  'core/tasks/terminal-control.mjs',
  'core/tasks/drive-agent.mjs',
  'core/tasks/drive-agent-cli.mjs',
];

// ---------- 1) 闸门分支（注入 isRunning，不碰真实应用） ----------

test('应用在运行：放行，不打印跳过文案', async () => {
  const r = await requireAppRunning('Ghostty', { isRunning: async () => true });
  assert.equal(r.ok, true);
  assert.equal(r.skipped, false);
  assert.equal(r.running, true);
  assert.equal(r.message, '');
  assert.equal(reportAppPresence(r, () => {}), false, '不该让任务提前结束');
});

test('应用没在运行：环境跳过，理由点名应用并说明不会启动它，任务应提前结束', async () => {
  const lines = [];
  const r = await requireAppRunning('Ghostty', { isRunning: async () => false });
  assert.equal(r.ok, false);
  assert.equal(r.skipped, true);
  assert.match(r.message, /环境跳过：Ghostty 没在运行/);
  assert.ok(r.message.includes(NOT_RUNNING_HINT), '理由要包含统一说明');
  assert.equal(reportAppPresence(r, (line) => lines.push(line)), true, 'skipped 时调用方应 return');
  assert.equal(lines.length, 1, '要打印一条人能看懂的原因');
});

test('探测失败/拿不到状态：按不在运行处理（fail closed，宁可跳过也不误启动）', async () => {
  const r = await requireAppRunning('ChatGPT', { isRunning: async () => { throw new Error('权限不足'); } });
  assert.equal(r.running, false);
  assert.equal(r.skipped, true);

  assert.equal(decideAppPresence({ app: 'ChatGPT', running: undefined }).proceed, false);
  assert.equal(decideAppPresence({ app: 'ChatGPT' }).proceed, false);
});

test('显式 allowLaunch：放行但提示"可能会把它拉起来"（其它批次用，行为保持）', () => {
  const d = decideAppPresence({ app: 'Google Chrome', running: false, allowLaunch: true });
  assert.equal(d.proceed, true);
  assert.equal(d.forced, true);
  assert.match(d.message, /^注意：/);
  assert.match(d.message, /allowLaunch/);
});

test('probeArgsForApp：显示名走 appName/processName，bundle id 走 bundleId 分支', () => {
  assert.deepEqual(probeArgsForApp('Google Chrome'), { appName: 'Google Chrome', processName: 'Google Chrome' });
  assert.deepEqual(probeArgsForApp('ChatGPT'), { appName: 'ChatGPT', processName: 'ChatGPT' });
  assert.deepEqual(probeArgsForApp('com.openai.codex'), { bundleId: 'com.openai.codex', appName: 'com.openai.codex' });
});

// ---------- 2) 三个任务的顺序回归：运行检查必须在第一次 raw ocu 调用之前 ----------

const FIRST_OCU_MARKERS = [
  'getOcuMcp()',        // 建 MCP 连接（之后必然对应用发请求）
  'readSafe(APP',       // background.readSafe → MCP
  'find(APP',           // background.find → MCP
  'typeText(APP',       // background.typeText → MCP
  'state(APP',          // background.state → MCP
  'pressEnter(APP',     // terminal-control 的回车 helper 内部会建 MCP
  "m.callTool('",       // 直接 MCP 调用
];

for (const rel of TASKS) {
  test(rel + '：requireAppRunning 在第一次 raw ocu 调用之前，且不再自造本地 helper', () => {
    const source = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    // 只看 main() 内部：顶层定义的 helper（如 pressEnter）会被静态匹配到，但它们不在 gate 之前执行
    const mainAt = source.indexOf('async function main()');
    assert.ok(mainAt >= 0, '找不到 main()');
    const mainBody = source.slice(mainAt);
    const gateAt = mainBody.indexOf('const presence = await requireAppRunning(APP, { isAppRunning });');
    assert.ok(gateAt >= 0, '必须调用共享闸门 requireAppRunning(APP, { isAppRunning })');

    for (const marker of FIRST_OCU_MARKERS) {
      const at = mainBody.indexOf(marker);
      if (at < 0) continue;
      assert.ok(gateAt < at, marker + ' 出现在运行检查之前（' + at + ' vs ' + gateAt + '）');
    }

    assert.match(source, /if \(reportAppPresence\(presence\)\)/, '跳过分支必须用 reportAppPresence');
    assert.doesNotMatch(source, /export function shouldSkipNotRunning/, '应复用 core/app-presence.mjs，不再各自复制一份');
    // 本地文件里不能有「跳过之后继续调 ocu」的常见写法
    assert.ok(gateAt < source.indexOf("'app-not-running'"), '跳过 JSON 打印在闸门之后');
  });
}
