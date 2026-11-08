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
import { countNotes, deleteTopNotes, deleteMarkedTestNotes, LEGACY_TEST_WORDS } from '../core/note-cleanup.mjs';
import { shouldQuitApp, shouldRunNoteCleanup } from '../core/cleanup-policy.mjs';
import { isDisposableTestDocument } from '../core/text-edit-guard.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dryRun = process.argv.includes('--dry-run');
const forceNotes = process.argv.includes('--force') || process.argv.includes('--force-all') || process.env.NOTES_CLEANUP_FORCE === '1';
// 只有明确加 --force-all 才允许退回「按条数删最上面几条」；普通 --force 只删带测试标记的笔记
const forceAllNotes = process.argv.includes('--force-all');

function osa(script, timeoutMs = 20000) {
  try {
    return String(execFileSync('/usr/bin/osascript', ['-e', script], { timeout: timeoutMs })).trim();
  } catch {
    return '__ERR__';
  }
}

/** 用户多久没动键鼠（毫秒）；读不到返回 -1 */
function hidIdleMs() {
  try {
    const out = execFileSync('/usr/sbin/ioreg', ['-c', 'IOHIDSystem', '-d', '4'], { encoding: 'utf8', timeout: 3000 });
    const m = /"HIDIdleTime" = (\d+)/.exec(out);
    return m ? Math.round(Number(m[1]) / 1e6) : -1;
  } catch {
    return -1;
  }
}

/** 2 分钟内动过键鼠就算「用户正在用电脑」 */
const USER_ACTIVE_MS = 120000;
function userRecentlyActive() {
  const idle = hidIdleMs();
  return idle >= 0 && idle < USER_ACTIVE_MS;
}

// 本次清理自己拉起来的应用：只有这些可以无条件关；别人的要等用户离开才清
const launchedByUs = new Set();

async function purgeNotes(report) {
  const count = await countNotes();
  report.push({ kind: 'note-count', count });
  if (count <= 0) return 0;
  if (!forceNotes) {
    report.push({ kind: 'note-skip', note: '当前文件夹有 ' + count + ' 条笔记；清理需要 --force（只删带 [AGENT-TEST] 标记的笔记；历史测试词要 --force-all，不动用户笔记）' });
    return 0;
  }
  // 第一层：只删带显式标记 [AGENT-TEST] 的（写测试数据时都会带）
  const marked = await deleteMarkedTestNotes(count);
  if (marked.readable > 0) {
    let removed = marked.removed;
    let legacyRemoved = 0;
    // 历史测试词（后台控制验证等）可能和用户自建笔记同名，默认不参与删除；
    // 只有显式 --force-all 才放开
    if (forceAllNotes) {
      const legacy = await deleteMarkedTestNotes(count, { words: LEGACY_TEST_WORDS });
      legacyRemoved = legacy.readable > 0 ? legacy.removed : 0;
      removed += legacyRemoved;
    }
    report.push({ kind: 'note-deleted', removed, readable: marked.readable, legacyRemoved });
    return removed;
  }
  // 第二层：这个 Notes 版本列表完全读不到标题。按条数删有可能误伤，必须显式 --force-all
  if (forceAllNotes) {
    const removed = await deleteTopNotes(count);
    report.push({ kind: 'note-deleted-fallback', removed, note: '列表标题读不到，按 --force-all 删了最上面 ' + removed + ' 条' });
    return removed;
  }
  report.push({ kind: 'note-unreadable', note: '列表标题读不到，无法确认哪条是测试笔记；未删除。确需按条数删请加 --force-all' });
  return 0;
}

async function cleanupNotes(report) {
  // 用户正在用电脑时连启动备忘录都别做：清理不该让人看到窗口弹出来
  const gate = shouldRunNoteCleanup({ userActive: userRecentlyActive(), force: forceNotes || forceAllNotes });
  if (!gate.run) { report.push({ kind: 'note-skip-active', note: gate.reason }); return; }
  const launch = await ensureAppRunning({ bundleId: 'com.apple.Notes', appName: 'Notes', processName: 'Notes' }, { waitMs: 6000 });
  if (launch.launched) launchedByUs.add('com.apple.Notes');
  await sleep(1000);
  if (dryRun) { report.push({ kind: 'note-dry-run' }); return; }
  await purgeNotes(report);
  // 「最近删除」没法安全自动化：Notes 辅助功能读不到标题、侧边栏行也无法脚本选中，
  // 只能提示用户手动清（或等 30 天系统自动清）
  report.push({ kind: 'note-trash', note: '最近删除需手动清空：打开备忘录 → 最近删除 → 删除全部' });
  if (!launch.launched) report.push({ kind: 'note-app', note: 'Notes 本来就在运行，未关闭' });
}

async function cleanupTextEdit(report) {
  const running = osa('application "TextEdit" is running') === 'true';
  if (!running) { report.push({ kind: 'textedit', running: false }); return; }
  const count = Number(osa('tell application "TextEdit" to count documents')) || 0;
  for (let i = count; i >= 1; i -= 1) {
    // 判定必须同时满足「未命名」和「正文是测试格式」：只看正文里有没有关键词是不够的，
    // 用户自己的草稿粘一段带"后台测试"的文字就会被 saving no 丢掉（数据丢失）。
    const name = osa('tell application "TextEdit" to get name of document ' + i).replace(/^__ERR__$/, '');
    const text = osa('tell application "TextEdit" to get text of document ' + i).replace(/^__ERR__$/, '');
    const decision = isDisposableTestDocument({ name, text });
    if (!decision.ok) {
      report.push({ kind: 'textedit-keep', index: i, note: decision.reason });
      continue;
    }
    report.push({ kind: 'textedit-doc', index: i, marker: true, dryRun });
    if (!dryRun) osa('tell application "TextEdit" to close document ' + i + ' saving no');
    await sleep(250);
  }
  if (!dryRun) {
    const left = Number(osa('tell application "TextEdit" to count documents')) || 0;
    const decision = shouldQuitApp({ launchedByUs: launchedByUs.has('com.apple.TextEdit'), userActive: userRecentlyActive() });
    if (left === 0 && decision.quit) {
      await quitApp({ bundleId: 'com.apple.TextEdit', appName: 'TextEdit', processName: 'TextEdit' });
      report.push({ kind: 'textedit-quit', left });
    } else if (left === 0) {
      report.push({ kind: 'textedit-keep', note: decision.reason });
    }
  }
}

async function quitTestApps(report) {
  if (dryRun) return;
  // 只关「本次清理自己拉起来的」；不是我们开的、且用户还在用，就别动人家应用。
  // 用户已经离开时，才把测试残留的应用收拾掉。
  const apps = [
    { bundleId: 'com.apple.calculator', appName: '计算器', processName: 'Calculator' },
    { bundleId: 'com.apple.Notes', appName: 'Notes', processName: 'Notes' },
  ];
  const userActive = userRecentlyActive();
  for (const app of apps) {
    const decision = shouldQuitApp({ launchedByUs: launchedByUs.has(app.bundleId), userActive });
    if (!decision.quit) {
      report.push({ kind: 'app-keep', app: app.appName, note: decision.reason });
      continue;
    }
    const q = await quitApp(app);
    if (q.mode !== 'already-stopped') report.push({ kind: 'quit', app: app.appName, mode: q.mode, note: decision.reason });
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
  const report = [];
  await cleanupNotes(report);
  await cleanupTextEdit(report);
  await quitTestApps(report);
  await reportOnly(report);
  const after = await frontName();
  console.log(JSON.stringify({ dryRun, front: { before, after }, report }, null, 1));
  await closeOcuMcp().catch(() => {});
}

main().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });