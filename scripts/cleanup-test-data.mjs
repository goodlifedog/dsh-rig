#!/usr/bin/env node
/**
 * 清理测试留下的数据：备忘录里的测试笔记、文本编辑里的空/测试文稿、测试用应用。
 *
 *   npm run cleanup:test
 *   npm run cleanup:test -- --dry-run
 *   npm run cleanup:test -- --force-all            # 允许退回「按条数删顶部 N 条」
 *   CLEANUP_MAX_TOP=3 npm run cleanup:test -- --force-all
 *   CLEANUP_ALLOW_LARGE=1 npm run cleanup:test -- --force-all   # 显式突破硬上限（默认 5）
 *   CLEANUP_QUIT_RESIDUAL=1 npm run cleanup:test              # 旧行为：用户离开时也关非本次启动的残留应用（默认不再关）
 *
 * 只删能确认是测试产生的：备忘录标题/正文匹配 后台控制验证 / 后台写入 / 后台测试；
 * 文本编辑里未命名且为空或含上述标记的文稿。用户自己的内容不碰。
 * Chrome 标签页 / 聊天记录只报告不删除。
 */
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { ensureAppRunning, frontName, isAppRunning, quitApp } from '../core/background.mjs';
import { closeOcuMcp } from '../core/ocu-mcp.mjs';
import { countNotes, deleteTopNotes, deleteMarkedTestNotes, LEGACY_TEST_WORDS } from '../core/note-cleanup.mjs';
import { shouldQuitApp, shouldRunNoteCleanup } from '../core/cleanup-policy.mjs';
import { resolveMaxTop, resolveTopDelete } from '../core/cleanup-limits.mjs';
import { isDisposableTestDocument } from '../core/text-edit-guard.mjs';
import { createAppleEventPreflight } from '../core/appleevent-preflight.mjs';
import { isDirectRun } from '../core/direct-run.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dryRun = process.argv.includes('--dry-run');
const forceNotes = process.argv.includes('--force') || process.argv.includes('--force-all') || process.env.NOTES_CLEANUP_FORCE === '1';
// 只有明确加 --force-all 才允许退回「按条数删最上面几条」；普通 --force 只删带测试标记的笔记
const forceAllNotes = process.argv.includes('--force-all');
// L4：按条数删的硬上限。默认最多删 5 条；N 超过上限直接拒绝，
// 只有显式 CLEANUP_ALLOW_LARGE=1 才放行（报告里会写清条数与原因）。
const CLEANUP_MAX_TOP = resolveMaxTop(process.env.CLEANUP_MAX_TOP);
const CLEANUP_ALLOW_LARGE = process.env.CLEANUP_ALLOW_LARGE === '1';
// L4b：默认只关「本次清理自己启动的」应用；非本次启动的一律保留（用户回来发现应用被关是打扰）。
// 只有排障时显式 CLEANUP_QUIT_RESIDUAL=1（只认 '1'）才恢复旧行为：用户离开时清理残留应用。
const CLEANUP_QUIT_RESIDUAL = process.env.CLEANUP_QUIT_RESIDUAL === '1';

function osa(script, timeoutMs = 20000) {
  try {
    return String(execFileSync('/usr/bin/osascript', ['-e', script], { timeout: timeoutMs })).trim();
  } catch {
    return '__ERR__';
  }
}

// ---------- H2 缺口 C：TextEdit / Chrome 的 AppleEvent 先静默预检 ----------
// 这个脚本会 tell TextEdit 读/关测试文稿、tell Chrome 读标签；首次未授权的机器上
// 直接发会弹「自动化」授权框。复用 core/appleevent-preflight.mjs（task-57）的静默预检：
//   granted / unknown / 超时 / 探测抛错 → 行为与改造前完全一致（osa 参数逐字不变）；
//   denied / needs-consent → 不发任何 AppleEvent、什么都不删不关，报告里明确写环境跳过。
export const TEXTEDIT_BUNDLE_ID = 'com.apple.TextEdit';
export const CHROME_BUNDLE_ID = 'com.google.Chrome';

/** 预检结论 → 是否允许发 AppleEvent（只有明确 allowed===false 才拦；unknown 仍尝试）。 */
export function gateAllows(gate) {
  return !(gate && gate.allowed === false);
}

/** 跳过时打印/写报告的一行原因。 */
export function gateSkipReason(gate, action) {
  const warning = gate && gate.warning;
  return warning || (action + '：自动化未授权，已跳过该 AppleEvent（不弹授权框）');
}

/**
 * 预检一次（注入 fake 便于单测）；预检自身抛错按 unknown 放行，不能因此拦住清理原逻辑。
 * @returns {Promise<{allowed:boolean, status:string, warning?:string}>}
 */
async function preflightOrAllow(preflight, bundleId, action) {
  try {
    const result = await preflight({ action, bundleId });
    return result && typeof result === 'object' ? result : { allowed: true, status: 'unknown' };
  } catch (error) {
    return { allowed: true, status: 'unknown', error: String((error && error.message) || error).slice(0, 120) };
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

/**
 * 清理测试笔记（可注入 countNotes 便于单测 M1 的未授权报告）。
 * @param {Array<object>} report
 * @param {{countNotes?:Function}} [options]
 */
export async function purgeNotes(report, options = {}) {
  const opts = options || {};
  const count = await (typeof opts.countNotes === 'function' ? opts.countNotes : countNotes)();
  report.push({ kind: 'note-count', count });
  // countNotes 返回 -1 = 未授权/读不到笔记列表：明确记一条环境跳过，
  // 否则 deleted.notes=0 会被读成「没有测试笔记=清理成功」（M1）。
  if (count < 0) {
    report.push({
      kind: 'note-skipped',
      envSkip: true,
      status: 'unavailable',
      deleted: 0,
      reason: '读不到 Notes 笔记列表（自动化未授权或 Notes 不可用），未删除任何笔记；授权后重跑 npm run cleanup:test',
    });
    return 0;
  }
  if (count === 0) return 0;
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
  // 第二层：这个 Notes 版本列表完全读不到标题。按条数删有可能误伤，必须显式 --force-all；
  // 而且要先过 L4 硬上限：删之前把「将删条数 / 触发原因 / 当前笔记总数」打进报告。
  if (forceAllNotes) {
    const plan = resolveTopDelete({
      requested: count,
      noteTotal: count,
      maxTop: CLEANUP_MAX_TOP,
      allowLarge: CLEANUP_ALLOW_LARGE,
    });
    report.push({
      kind: 'note-delete-plan',
      mode: 'top-fallback',
      trigger: '列表标题读不到 + --force-all',
      requested: plan.requested,
      willDelete: plan.count,
      noteTotal: plan.noteTotal,
      limit: plan.limit,
      allowLarge: CLEANUP_ALLOW_LARGE,
      reason: plan.reason,
    });
    if (!plan.allowed) {
      report.push({ kind: 'note-delete-refused', requested: plan.requested, limit: plan.limit, reason: plan.reason });
      return 0;
    }
    const removed = await deleteTopNotes(plan.count);
    report.push({
      kind: 'note-deleted-fallback',
      requested: plan.requested,
      removed,
      limit: plan.limit,
      note: '列表标题读不到，按 --force-all 删了最上面 ' + removed + ' 条（' + plan.reason + '）',
    });
    return removed;
  }
  report.push({ kind: 'note-unreadable', note: '列表标题读不到，无法确认哪条是测试笔记；未删除。确需按条数删请加 --force-all' });
  return 0;
}

/**
 * 顶层清理汇总（M1，纯函数便于单测）：任一通路跳过就算 skipped。
 * envSkip 只统计「环境/授权原因跳过」；app-not-running 也算没验证，计入 skipped/envSkip。
 * @param {Array<object>} report cleanup-test-data 的 report 数组
 * @param {{notes?:number,textEdit?:number,chrome?:number}} deleted
 */
export function summarizeCleanup(report = [], deleted = {}) {
  const list = Array.isArray(report) ? report : [];
  const skippedEntries = list.filter((r) => r && (r.envSkip === true || r.skipped));
  const envSkip = skippedEntries.length > 0;
  const skippedKinds = [...new Set(skippedEntries.map((r) => String((r && r.kind) || 'unknown')))];
  return {
    skipped: skippedEntries.length > 0,
    envSkip,
    skippedKinds,
    deleted: {
      notes: Math.max(0, Number((deleted && deleted.notes) || 0)),
      textEdit: Math.max(0, Number((deleted && deleted.textEdit) || 0)),
      chrome: Math.max(0, Number((deleted && deleted.chrome) || 0)),
    },
  };
}

async function cleanupNotes(report) {
  // 用户正在用电脑时连启动备忘录都别做：清理不该让人看到窗口弹出来
  const gate = shouldRunNoteCleanup({ userActive: userRecentlyActive(), force: forceNotes || forceAllNotes });
  if (!gate.run) { report.push({ kind: 'note-skip-active', note: gate.reason }); return 0; }
  const launch = await ensureAppRunning({ bundleId: 'com.apple.Notes', appName: 'Notes', processName: 'Notes' }, { waitMs: 6000 });
  if (launch.launched) launchedByUs.add('com.apple.Notes');
  await sleep(1000);
  // dry-run 永远不删：连 purgeNotes 都不调用，只报告会做什么。
  if (dryRun) { report.push({ kind: 'note-dry-run', note: 'dry-run：只报告，不删除任何笔记' }); return 0; }
  const removed = await purgeNotes(report);
  // 「最近删除」没法安全自动化：Notes 辅助功能读不到标题、侧边栏行也无法脚本选中，
  // 只能提示用户手动清（或等 30 天系统自动清）
  report.push({ kind: 'note-trash', note: '最近删除需手动清空：打开备忘录 → 最近删除 → 删除全部' });
  if (!launch.launched) report.push({ kind: 'note-app', note: 'Notes 本来就在运行，未关闭' });
  return removed;
}

/**
 * 关闭 TextEdit 里的测试文稿。发 AppleEvent 前先静默预检自动化授权（H2 缺口 C）。
 * denied/needs-consent → 什么都不读不关（deleted=0），报告 textedit-skipped + 打印一行原因。
 * granted/unknown/超时 → 行为与改造前完全一致（osa 参数逐字不变）。
 *
 * @param {Array<object>} report
 * @param {{deps?:{osa?:Function, sleep?:Function, quitApp?:Function, userActive?:Function, shouldQuitApp?:Function}, preflight?:Function}} [options]
 * @returns {Promise<{deleted:number, skipped:boolean}>}
 */
export async function cleanupTextEdit(report, options = {}) {
  const opts = options || {};
  const deps = opts.deps || {};
  const runOsa = deps.osa || osa;
  const pause = deps.sleep || sleep;
  const isRunning = typeof deps.isAppRunning === 'function' ? deps.isAppRunning : isAppRunning;

  // M3：先查进程（ps/pgrep，无 TCC），没运行就不发 AppleEvent——避免把 TextEdit 拉起来/弹授权框。
  let running = false;
  try {
    // 只传 processName：isAppRunning 走 pgrep（无 TCC），不会因 appName/bundleId 分支退回 osascript AppleEvent
    running = Boolean(await isRunning({ processName: 'TextEdit' }));
  } catch {
    running = false;
  }
  if (!running) {
    report.push({
      kind: 'textedit-skipped',
      skipped: 'app-not-running',
      envSkip: true,
      bundleId: TEXTEDIT_BUNDLE_ID,
      deleted: 0,
      reason: 'TextEdit 未运行，未发 AppleEvent',
    });
    return { deleted: 0, skipped: true };
  }

  const preflight = typeof opts.preflight === 'function'
    ? opts.preflight
    : createAppleEventPreflight({ bundleId: TEXTEDIT_BUNDLE_ID });
  const action = '读取/关闭 TextEdit 测试文稿';
  const gate = await preflightOrAllow(preflight, TEXTEDIT_BUNDLE_ID, action);
  if (!gateAllows(gate)) {
    const reason = gateSkipReason(gate, action);
    report.push({
      kind: 'textedit-skipped',
      envSkip: true,
      bundleId: TEXTEDIT_BUNDLE_ID,
      status: gate.status || 'denied',
      deleted: 0,
      reason,
    });
    console.warn('[!] ' + reason);
    return { deleted: 0, skipped: true };
  }
  const count = Number(runOsa('tell application "TextEdit" to count documents')) || 0;
  let deleted = 0;
  for (let i = count; i >= 1; i -= 1) {
    // 判定必须同时满足「未命名」和「正文是测试格式」：只看正文里有没有关键词是不够的，
    // 用户自己的草稿粘一段带"后台测试"的文字就会被 saving no 丢掉（数据丢失）。
    const name = runOsa('tell application "TextEdit" to get name of document ' + i).replace(/^__ERR__$/, '');
    const text = runOsa('tell application "TextEdit" to get text of document ' + i).replace(/^__ERR__$/, '');
    const decision = isDisposableTestDocument({ name, text });
    if (!decision.ok) {
      report.push({ kind: 'textedit-keep', index: i, note: decision.reason });
      continue;
    }
    report.push({ kind: 'textedit-doc', index: i, marker: true, dryRun });
    if (!dryRun) {
      runOsa('tell application "TextEdit" to close document ' + i + ' saving no');
      deleted += 1;
    }
    await pause(250);
  }
  if (!dryRun) {
    const left = Number(runOsa('tell application "TextEdit" to count documents')) || 0;
    const userActive = (deps.userActive || userRecentlyActive)();
    const decideQuit = deps.shouldQuitApp || shouldQuitApp;
    const decision = decideQuit({ launchedByUs: launchedByUs.has('com.apple.TextEdit'), userActive, quitResidual: CLEANUP_QUIT_RESIDUAL });
    if (left === 0 && decision.quit) {
      await (deps.quitApp || quitApp)({ bundleId: 'com.apple.TextEdit', appName: 'TextEdit', processName: 'TextEdit' });
      report.push({ kind: 'textedit-quit', left });
    } else if (left === 0) {
      report.push({ kind: 'textedit-keep', note: decision.reason });
    }
  }
  return { deleted, skipped: false };
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
  const keptResidual = [];
  for (const app of apps) {
    const mine = launchedByUs.has(app.bundleId);
    const decision = shouldQuitApp({ launchedByUs: mine, userActive, quitResidual: CLEANUP_QUIT_RESIDUAL });
    if (!decision.quit) {
      report.push({ kind: 'app-keep', app: app.appName, launchedByUs: mine, note: decision.reason });
      if (!mine) keptResidual.push(app.appName);
      continue;
    }
    // quitApp 内部自带 pid 复核：先 isAppRunning(bundleId)，退不掉时再 pgrep + ps comm 校验
    // 目标进程才 kill（core/background.mjs:947 / 972-984），pid 被复用会返回 pid-mismatch 不杀。
    const q = await quitApp(app);
    if (q.mode !== 'already-stopped') {
      report.push({
        kind: 'quit',
        app: app.appName,
        mode: q.mode,
        launchedByUs: mine,
        pidRecheck: q.mode === 'pid-mismatch' ? 'mismatch-refused' : 'quitApp-isRunning+ps-comm',
        note: decision.reason,
      });
    }
  }
  if (keptResidual.length) {
    report.push({
      kind: 'app-residual-kept',
      count: keptResidual.length,
      apps: keptResidual,
      note: '保留 ' + keptResidual.length + ' 个非本次启动的应用（默认不关，避免打扰用户）；如需按旧策略清理请设置 CLEANUP_QUIT_RESIDUAL=1',
    });
  }
}

/**
 * 只读报告：Chrome 标签页（不删除任何东西）。发 AppleEvent 前同样先静默预检（H2 缺口 C）。
 * denied/needs-consent → 不读标签，报告 chrome-skipped + 打印一行原因。
 *
 * @param {Array<object>} report
 * @param {{deps?:{osa?:Function}, preflight?:Function}} [options]
 * @returns {Promise<{read:boolean, skipped:boolean}>}
 */
export async function reportOnly(report, options = {}) {
  const opts = options || {};
  const deps = opts.deps || {};
  const runOsa = deps.osa || osa;
  const isRunning = typeof deps.isAppRunning === 'function' ? deps.isAppRunning : isAppRunning;
  let running = false;
  try {
    running = Boolean(await isRunning({ processName: 'Google Chrome' }));
  } catch {
    running = false;
  }
  if (!running) {
    report.push({
      kind: 'chrome-skipped',
      skipped: 'app-not-running',
      envSkip: true,
      bundleId: CHROME_BUNDLE_ID,
      reason: 'Chrome 未运行，未发 AppleEvent',
    });
    report.push({ kind: 'chatgpt', note: '聊天记录不在本次清理范围（用户数据，需要确认后再动）' });
    return { read: false, skipped: true };
  }

  const preflight = typeof opts.preflight === 'function'
    ? opts.preflight
    : createAppleEventPreflight({ bundleId: CHROME_BUNDLE_ID });
  const action = '读取 Chrome 标签页';
  const gate = await preflightOrAllow(preflight, CHROME_BUNDLE_ID, action);
  if (!gateAllows(gate)) {
    const reason = gateSkipReason(gate, action);
    report.push({
      kind: 'chrome-skipped',
      envSkip: true,
      bundleId: CHROME_BUNDLE_ID,
      status: gate.status || 'denied',
      reason,
    });
    console.warn('[!] ' + reason);
  } else {
    const urls = runOsa('tell application "Google Chrome" to get URL of every tab of every window', 8000);
    if (urls && urls !== '__ERR__') {
      const list = urls.split(', ').filter(Boolean);
      const suspicious = list.filter((u) => /zhipin|boss|127\.0\.0\.1|localhost|data:text/i.test(u));
      report.push({ kind: 'chrome-tabs', total: list.length, suspicious: suspicious.slice(0, 5) });
    }
  }
  report.push({ kind: 'chatgpt', note: '聊天记录不在本次清理范围（用户数据，需要确认后再动）' });
  return { read: gateAllows(gate), skipped: !gateAllows(gate) };
}

async function main() {
  const before = await frontName();
  const report = [];
  // deleted 计数：未授权时 TextEdit/Chrome 一律跳过，这里必须是 0；dry-run 也必须是 0
  const deleted = { notes: 0, textEdit: 0, chrome: 0 };
  deleted.notes = await cleanupNotes(report);
  const text = await cleanupTextEdit(report);
  deleted.textEdit = text.deleted;
  await quitTestApps(report);
  await reportOnly(report); // Chrome 只报告不删除，所以 chrome 恒为 0
  const after = await frontName();
  // 顶层明确 skipped/envSkip：任一通路跳过（未授权/应用未运行/读不到）都不算「清理成功」（M1）
  const summary = summarizeCleanup(report, deleted);
  console.log(JSON.stringify({
    dryRun,
    front: { before, after },
    deleted: summary.deleted,
    skipped: summary.skipped,
    envSkip: summary.envSkip,
    skippedKinds: summary.skippedKinds,
    report,
  }, null, 1));
  await closeOcuMcp().catch(() => {});
}

// 导入本模块（单测拿纯函数/带预检的清理函数）时不要真的跑清理；
// npm run cleanup:test 直接执行本脚本时 argv[1] 指向它（isDirectRun 会 realpath 归一后比较），照常执行。
const invokedDirectly = isDirectRun(import.meta.url);
if (invokedDirectly) {
  main().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
}