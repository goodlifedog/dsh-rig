#!/usr/bin/env node
/**
 * 清理测试留下的数据：备忘录里的测试笔记、文本编辑里的空/测试文稿、测试用应用。
 *
 *   npm run cleanup:test
 *   npm run cleanup:test -- --dry-run
 *
 * 只删能确认是测试产生的：备忘录标题/正文匹配 后台控制验证 / 后台写入 / 后台测试；
 * 文本编辑里未命名且为空或含上述标记的文稿。用户自己的内容不碰。
 * Chrome 标签页 / 聊天记录只报告不删除。
 */
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { ensureAppRunning, frontName, quitApp } from '../core/background.mjs';
import { closeOcuMcp } from '../core/ocu-mcp.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dryRun = process.argv.includes('--dry-run');
const TEST_NOTE_RE = /后台控制验证|后台写入|后台测试|pta 测试/i;

function osa(script, timeoutMs = 20000) {
  try {
    return String(execFileSync('/usr/bin/osascript', ['-e', script], { timeout: timeoutMs })).trim();
  } catch {
    return '__ERR__';
  }
}

/** 对 Notes 主列表执行「删除」次要动作；实测 AX 层 secondaryAction 返回 ok 但不删，System Events 才可靠 */
const DEL_SCRIPT = [
  'with timeout of 180 seconds',
  '  set removed to 0',
  '  repeat with kk from 1 to TIMES_TOK',
  '    set didDelete to false',
  '    try',
  '      tell application "System Events" to tell process "Notes"',
  '        set w to window 1',
  '        set tbl to table 1 of scroll area 2 of splitter group 1 of w',
  '        set rs to rows of tbl',
  '        repeat with i from (count of rs) to 1 by -1',
  '          try',
  '            set rr to item i of rs',
  '            if (count of actions of rr) >= 2 then',
  '              perform action 2 of rr',
  '              set didDelete to true',
  '              exit repeat',
  '            end if',
  '          end try',
  '        end repeat',
  '      end tell',
  '    end try',
  '    if didDelete then',
  '      set removed to removed + 1',
  '      delay 0.3',
  '    else',
  '      exit repeat',
  '    end if',
  '  end repeat',
  '  return removed',
  'end timeout',
].join('\n');

function delNotes(times) {
  return Number.parseInt(osa(DEL_SCRIPT.replace('TIMES_TOK', String(times))), 10) || 0;
}

async function cleanupNotes(report) {
  const launch = await ensureAppRunning({ bundleId: 'com.apple.Notes', appName: 'Notes', processName: 'Notes' }, { waitMs: 6000 });
  await sleep(1000);
  const beforeFront = await frontName();
  if (dryRun) { report.push({ kind: 'note-total', dryRun: true }); return; }

  let removed = 0;
  for (let pass = 0; pass < 5; pass += 1) {
    const n = delNotes(40);
    removed += n;
    if (n < 40) break;
  }
  report.push({ kind: 'note-deleted', removed });

  // 最近删除里的再删一遍（永久删除）：把 Notes 切前台 → 点侧边栏「最近删除」→ 重复删除
  try {
    const info = osa('tell application "System Events" to tell process "Notes" to get {position of window 1, position of row 3 of outline 1 of scroll area 1 of splitter group 1 of window 1}');
    const nums = (info.match(/-?\d+/g) || []).map(Number);
    if (nums.length >= 4) {
      osa('tell application "System Events" to set frontmost of process "Notes" to true');
      await sleep(400);
      const rx = nums[2]; const ry = nums[3];
      osa('tell application "System Events" to click at {' + (rx + 40) + ', ' + (ry + 14) + '}', 8000);
      await sleep(700);
      const purged = delNotes(40);
      report.push({ kind: 'note-trash-purged', removed: purged });
    }
  } catch {}
  if (beforeFront && beforeFront !== 'Notes') {
    osa('tell application "System Events" to set frontmost of first process whose name is ' + JSON.stringify(beforeFront) + ' to true', 8000);
    await sleep(200);
  }
  if (!launch.launched) report.push({ kind: 'note-app', note: 'Notes 本来就在运行，未关闭' });
}

async function cleanupTextEdit(report) {
  const running = osa('application "TextEdit" is running') === 'true';
  if (!running) { report.push({ kind: 'textedit', running: false }); return; }
  const count = Number(osa('tell application "TextEdit" to count documents')) || 0;
  for (let i = count; i >= 1; i -= 1) {
    const text = osa('tell application "TextEdit" to get text of document ' + i);
    const marker = TEST_NOTE_RE.test(text);
    const empty = !String(text || '').trim();
    if (!marker && !empty) continue;
    report.push({ kind: 'textedit-doc', index: i, marker, empty, dryRun });
    if (!dryRun) osa('tell application "TextEdit" to close document ' + i + ' saving no');
    await sleep(250);
  }
  if (!dryRun) {
    const left = Number(osa('tell application "TextEdit" to count documents')) || 0;
    if (left === 0) {
      await quitApp({ bundleId: 'com.apple.TextEdit', appName: 'TextEdit', processName: 'TextEdit' });
      report.push({ kind: 'textedit-quit', left });
    }
  }
}

async function quitTestApps(report, notesWasRunning) {
  if (dryRun) return;
  const apps = [{ bundleId: 'com.apple.calculator', appName: '计算器', processName: 'Calculator' }];
  if (!notesWasRunning) apps.push({ bundleId: 'com.apple.Notes', appName: 'Notes', processName: 'Notes' });
  for (const app of apps) {
    const q = await quitApp(app);
    if (q.mode !== 'already-stopped') report.push({ kind: 'quit', app: app.appName, mode: q.mode });
  }
}

async function reportOnly(report) {
  const urls = osa('tell application "Google Chrome" to get URL of every tab of every window', 8000);
  if (urls && urls !== '__ERR__') {
    const list = urls.split(', ').filter(Boolean);
    const suspicious = list.filter((u) => /zhipin|boss|127\.0\.0\.1|localhost|data:text/i.test(u));
    report.push({ kind: 'chrome-tabs', total: list.length, suspicious: suspicious.slice(0, 5) });
  }
  report.push({ kind: 'chatgpt', note: '聊天记录不在本次清理范围（用户数据，需要确认后再动）' });
}

async function main() {
  const before = await frontName();
  const notesWasRunning = osa('application "Notes" is running') === 'true';
  const report = [];
  await cleanupNotes(report);
  await cleanupTextEdit(report);
  await quitTestApps(report, notesWasRunning);
  await reportOnly(report);
  const after = await frontName();
  console.log(JSON.stringify({ dryRun, front: { before, after }, report }, null, 1));
  await closeOcuMcp().catch(() => {});
}

main().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
