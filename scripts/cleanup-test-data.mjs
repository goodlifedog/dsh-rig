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
import { countNotes, deleteTopNotes, deleteMarkedTestNotes } from '../core/note-cleanup.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dryRun = process.argv.includes('--dry-run');
const forceNotes = process.argv.includes('--force') || process.argv.includes('--force-all') || process.env.NOTES_CLEANUP_FORCE === '1';
// 只有明确加 --force-all 才允许退回「按条数删最上面几条」；普通 --force 只删带测试标记的笔记
const forceAllNotes = process.argv.includes('--force-all');
const TEST_NOTE_RE = /\[\s*AGENT-TEST\s*\]|后台控制验证|后台写入|后台测试|pta 测试/i;

function osa(script, timeoutMs = 20000) {
  try {
    return String(execFileSync('/usr/bin/osascript', ['-e', script], { timeout: timeoutMs })).trim();
  } catch {
    return '__ERR__';
  }
}

async function purgeNotes(report) {
  const count = await countNotes();
  report.push({ kind: 'note-count', count });
  if (count <= 0) return 0;
  if (!forceNotes) {
    report.push({ kind: 'note-skip', note: '当前文件夹有 ' + count + ' 条笔记；清理需要 --force（只删带 [AGENT-TEST] 标记或历史测试词的笔记，不动用户笔记）' });
    return 0;
  }
  // 第一层：按标题标记删（写测试数据时都会带 [AGENT-TEST]）
  const marked = await deleteMarkedTestNotes(count);
  if (marked.readable > 0) {
    report.push({ kind: 'note-deleted', removed: marked.removed, readable: marked.readable });
    return marked.removed;
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
  const launch = await ensureAppRunning({ bundleId: 'com.apple.Notes', appName: 'Notes', processName: 'Notes' }, { waitMs: 6000 });
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
    const text = osa('tell application "TextEdit" to get text of document ' + i);
    const marker = TEST_NOTE_RE.test(text);
    // 只关"正文里带测试标记"的文稿；空文稿可能是用户自己刚打开的，不动
    if (!marker) continue;
    report.push({ kind: 'textedit-doc', index: i, marker, dryRun });
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

async function quitTestApps(report) {
  if (dryRun) return;
  // 清完就退出测试应用：Notes 自动保存，关掉不会丢用户内容；留着会一直躺在后台
  const apps = [
    { bundleId: 'com.apple.calculator', appName: '计算器', processName: 'Calculator' },
    { bundleId: 'com.apple.Notes', appName: 'Notes', processName: 'Notes' },
  ];
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