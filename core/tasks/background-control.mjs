#!/usr/bin/env node
import { overlayBase } from '../ports.mjs';
/**
 * 后台控制验收：启动软件、点击、写入，全程不抢前台，并把真实窗口回显到小窗。
 *
 *   node core/tasks/background-control.mjs
 *
 * 结论以 JSON 输出：每个动作都带「操作前后前台是否一致」的证据。
 */
import { ensureAppRunning, isAppRunning, frontName, state, find, click, setValue, smartType, smartTypeWithCache, clickByText, quitApp } from '../background.mjs';
import { checkTextEditWritable } from '../text-edit-guard.mjs';
import { decideNoteWrite } from '../note-write-guard.mjs';
import { hidIdleMs } from '../front-watch.mjs';
import { shouldDeferForActiveUser } from '../user-activity.mjs';
import { installEmergencyAppCleanup } from '../task-emergency-cleanup.mjs';
import { quitAppSync } from '../sync-quit.mjs';
import { closeOcuMcp } from '../ocu-mcp.mjs';
import { countNotes, deleteTestNotes } from '../note-cleanup.mjs';
import { isScreenLocked } from '../platform.mjs';
import { tokenHeadersFor } from '../local-token.mjs';
import { fileURLToPath } from 'node:url';
import { foreignAcceptanceOwner } from '../acceptance-lock.mjs';

const OVERLAY = overlayBase();
const ACCEPTANCE_LOCK = fileURLToPath(new URL('../../reports/.acceptance.lock', import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const S_NOTES = 'bg-notes';
const S_CALC = 'bg-calc';

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
function record(name, ok, extra) {
  steps.push(Object.assign({ name, ok }, extra || {}));
  console.log((ok ? '  ✅ ' : '  ❌ ') + name + (extra && extra.detail ? '  ' + extra.detail : ''));
}

/** 记一条"环境不满足、这次不测"：不算失败，但要在日志里写清"环境跳过"，出口分类才认 */
function recordSkipped(name, detail) {
  steps.push({ name, ok: true, skipped: true, detail });
  console.log('  SKIP ' + name + '  环境跳过：' + detail);
}

async function main() {
  // 锁屏下 AX 整体不可用（ocu 会报 NSPOSIXErrorDomain Code=2），这是环境限制不是失败
  if (await isScreenLocked()) {
    console.log('环境跳过：屏幕已锁，锁屏下 AX/抓图都不可用，等解锁后再跑');
    return;
  }
  // 另一个验收正在跑时不要掺和：两边会互相抢前台/互关应用，报告全变假失败
  const foreignAcc = await foreignAcceptanceOwner(ACCEPTANCE_LOCK);
  if (foreignAcc) {
    console.log('环境跳过：另一个验收正在进行（pid ' + foreignAcc.pid + '），避免互相干扰');
    return;
  }
  // 你在打字/点鼠标时不做：这个任务会点「新建备忘录」、往文本区写字，
  // 即使操作的是后台应用，也可能把你正在写的焦点切到测试笔记上。
  const activity = shouldDeferForActiveUser(await hidIdleMs());
  if (activity.defer) {
    console.log('环境跳过：' + activity.reason);
    return;
  }
  const frontAtStart = await frontName();
  console.log('起点前台:', frontAtStart);

  // 1. 后台启动备忘录（冷启动，最容易把前台顶掉的一步）
  const launch = await ensureAppRunning({ bundleId: 'com.apple.Notes', appName: '备忘录' });
  // 计算器也自己拉起来：干净环境里它可能没开，不拉起的话后面「点按钮」会假失败
  const calcLaunch = await ensureAppRunning({ bundleId: 'com.apple.calculator', appName: '计算器' });
  const launchedByUs = [];
  if (launch.launched) launchedByUs.push({ bundleId: 'com.apple.Notes', appName: '备忘录', processName: 'Notes' });
  if (calcLaunch.launched) launchedByUs.push({ bundleId: 'com.apple.calculator', appName: '计算器', processName: 'Calculator' });
  // 被中途杀掉（验收中止/Ctrl-C）时，也把自己拉起的应用关掉，别留给用户
  installEmergencyAppCleanup({ list: () => launchedByUs, quit: (app) => quitApp(app), quitSync: quitAppSync });
  record('后台启动备忘录（open -g，不激活）', launch.frontUnchanged !== false && !launch.error, {
    frontUnchanged: launch.frontUnchanged !== false,
    detail: launch.launched ? '冷启动成功，前台仍是 ' + launch.front : '本来就在运行',
  });
  await sleep(1500);
  // 记下测试写入前的笔记数量：结束时只删"自己新增的条数"，绝不批量删用户笔记
  const notesBefore = await countNotes();

  // 2. 把备忘录真实窗口绑到小窗（回显）
  const dshTitle = (await getJson(OVERLAY + '/health?session=__none__'))?.dshTitle || '';
  const windows = (await getJson(OVERLAY + '/windows'))?.windows || [];
  const notesWin = windows.find((w) => /备忘录|Notes/.test(w.owner || w.title || ''));
  const calcWin = windows.find((w) => /计算器/.test(w.owner || w.title || ''));

  if (notesWin) {
    await post('/status', { session: S_NOTES, text: '备忘录：后台操作中', titleHint: dshTitle });
    await post('/window', { session: S_NOTES, windowId: notesWin.windowId });
    await post('/visible', { session: S_NOTES, visible: true });
    if (calcWin) {
      await post('/status', { session: S_CALC, text: '计算器：后台操作中', titleHint: dshTitle });
      await post('/window', { session: S_CALC, windowId: calcWin.windowId });
      await post('/visible', { session: S_CALC, visible: true });
    }
    await sleep(1200);
    const h = await getJson(OVERLAY + '/health?session=' + S_NOTES);
    const state = (h && h.thumbnail && h.thumbnail.state) || 'none';
    if (state === 'live') {
      record('真实窗口回显（备忘录）', true, { detail: 'windowId=' + notesWin.windowId + ' state=live' });
    } else {
      // offscreen = 窗口在别的桌面/不在当前空间，系统只给纯色帧：这是环境状态，不是能力缺失
      recordSkipped('真实窗口回显（备忘录）', '窗口状态=' + state + '（不在当前桌面或被遮挡），跳过画面回显');
    }
  } else {
    record('真实窗口回显（备忘录）', false, { detail: '窗口列表里没有备忘录' });
  }

  // 3. 后台新建备忘录
  // 按文字点击：索引过期会自动重查一次（实机常见）
  const newNote = await clickByText('备忘录', '新建备忘录');
  record('后台点击「新建备忘录」', newNote.ok && newNote.frontUnchanged !== false, {
    frontUnchanged: newNote.frontUnchanged !== false,
    detail: newNote.ok ? ('尝试 ' + newNote.attempts + ' 次') : newNote.reason,
  });
  await sleep(700);

  // 4. 后台写入正文并校验
  const areas = await find('备忘录', { role: 'AXTextArea', limit: 5 });
  const area = areas[0];
  // 写入前必须确认"新建备忘录"真的成功了：如果这一步失败，第一个 AXTextArea 很可能
  // 就是用户正在编辑的那条笔记，set_value 是覆盖语义，写进去等于把用户内容盖掉。
  const noteDecision = decideNoteWrite({
    newNoteOk: newNote.ok,
    frontUnchanged: newNote.frontUnchanged,
    hasArea: Boolean(area),
  });
  // 标题带显式标记：清理时只删带标记的笔记，不靠"删最上面几条"猜
  const text = '[AGENT-TEST] 后台控制验证：' + new Date().toLocaleTimeString('zh-CN');
  if (!noteDecision.ok) {
    recordSkipped('后台写入正文', noteDecision.reason);
  } else {
    // 智能输入：先 AX 设值，读回不通过再降级到后台键入
    const w = await smartTypeWithCache('备忘录', { elementIndex: area.index, text });
    const frontOk = (w.attempts || []).every((a) => a.frontUnchanged !== false);
    record('后台写入正文（自动选择输入方式）', w.ok && frontOk, {
      frontUnchanged: frontOk,
      detail: '方式=' + w.method + (w.attempts.length > 1 ? '，尝试 ' + w.attempts.map((a) => a.method).join('→') : ''),
    });
    await sleep(400);
    const tree = await state('备忘录');
    record('读回正文校验', tree.includes('后台控制验证'), { detail: tree.includes(text) ? '内容一致' : '内容不完全一致' });
  }

  // 5. 计算器：后台点击按钮
  // 先按 AC 归零，否则「显示值本来就是 7」时点击 7 看不出来变化（验收实测偶发 7 → 7）
  const calcBtns = await find('计算器', { role: 'AXButton', limit: 40 });
  const label = (b) => String(b && (b.title || b.identifier || b.name) || '');
  const clearBtn = calcBtns.find((b) => /^(AC|Clear|全部清除|清除)$/i.test(label(b).trim()));
  if (clearBtn) {
    await click('计算器', clearBtn.index);
    await sleep(300);
  }
  const seven = calcBtns.find((b) => /^(7|Seven)$/.test(label(b).trim()));
  if (seven) {
    // 点击可能落空（AX 偶尔不生效）：最多试 3 次，直到显示值真的变了
    let before = (await state('计算器')).match(/文本\s*[\u200e]?\s*(-?[\d.,]+)/);
    let after = before;
    let r = { ok: false, frontUnchanged: true };
    for (let attempt = 0; attempt < 3; attempt += 1) {
      r = await click('计算器', seven.index);
      await sleep(400);
      after = (await state('计算器')).match(/文本\s*[\u200e]?\s*(-?[\d.,]+)/);
      if (before && after && before[1] !== after[1]) break;
      before = after;   // 下一次基线用上一次结果
      if (!r.frontUnchanged) break;   // 抢了前台就别再试
    }
    const changed = before && after && before[1] !== after[1];
    record('后台点击计算器按钮', r.ok && r.frontUnchanged && Boolean(changed), {
      frontUnchanged: r.frontUnchanged,
      detail: (before && before[1]) + ' → ' + (after && after[1]),
    });
  } else {
    record('后台点击计算器按钮', false, { detail: '找不到按钮 7' });
  }

  // 6. 文本编辑：后台设值
  // P0（审计 #10）：TextEdit 没运行就跳过——不在没运行的情况下 find/读 AX，更不自动启动，
  // 否则这一步会把 TextEdit 拉起来并可能留在前台（收尾只关 Notes/Calculator）。
  const textEditRunning = await isAppRunning({ bundleId: 'com.apple.TextEdit', appName: '文本编辑', processName: 'TextEdit' });
  if (!textEditRunning) {
    recordSkipped('后台写入文本编辑（AX set_value）', '文本编辑未运行，跳过（不自动启动，避免拉起窗口）');
  } else {
    const textAreas = await find('文本编辑', { role: 'AXTextArea', limit: 5 });
    if (textAreas[0]) {
      // set_value 是覆盖语义：用户开着有内容的文稿时，写进去就等于把人家内容盖掉。
      // 只允许写「未命名且内容为空」的文稿，否则跳过（评审 P0）。
      const guard = await checkTextEditWritable();
      if (!guard.ok) {
        recordSkipped('后台写入文本编辑（AX set_value）', '文本编辑里有用户内容，跳过写入以免覆盖：' + guard.reason);
      } else {
        const w = await setValue('文本编辑', textAreas[0].index, '后台写入：' + new Date().toLocaleTimeString('zh-CN'));
        record('后台写入文本编辑（AX set_value）', w.ok && w.frontUnchanged, { frontUnchanged: w.frontUnchanged, detail: w.error || '' });
      }
    } else {
      recordSkipped('后台写入文本编辑（AX set_value）', '文本编辑冷启动是打开面板，没有文稿窗口');
    }
  }

  const frontAtEnd = await frontName();
  const frontOk = frontAtStart === frontAtEnd;
  record('全程前台未被抢占', frontOk, { detail: frontAtStart + ' → ' + frontAtEnd });

  const report = {
    ok: steps.every((s) => s.ok),
    frontAtStart,
    frontAtEnd,
    steps,
  };
  console.log('\n' + JSON.stringify(report, null, 2));

  const keepMs = Number(process.env.BG_KEEP_MS || 10000);
  if (keepMs > 0) await sleep(keepMs);

  for (const s of [S_NOTES, S_CALC]) {
    await post('/window', { session: s, windowId: null });
    await post('/status', { session: s, clear: true });
    await post('/visible', { session: s, visible: false });
  }
  // 自己写进去的测试笔记自己删，别把脏数据留给用户（BG_KEEP_NOTE=1 时保留，便于排查）
  if (process.env.BG_KEEP_NOTE === '1') {
    console.log('已按 BG_KEEP_NOTE=1 保留测试笔记，未清理');
  } else {
    const notesAfter = await countNotes();
    const delta = notesBefore >= 0 && notesAfter >= 0 ? Math.max(0, notesAfter - notesBefore) : 0;
    // 按标记删（只删自己写的那条），不再直接删顶部 N 条。
    // H-1：这里刻意不传 allowTopFallback —— 标题读不到时 deleteTestNotes 返回 0，
    // 任务路径永不走 top-fallback，避免把用户测试期间新建的笔记当成测试笔记删掉。
    const cleaned = await deleteTestNotes({ count: delta });
    console.log('已清理测试笔记：' + cleaned + ' 条（测试前 ' + notesBefore + ' 条 → 测试后 ' + notesAfter + ' 条）');
  }
  // 自己拉起的应用自己关：否则每跑一次就留下一个备忘录/计算器
  for (const app of launchedByUs) {
    const q = await quitApp(app).catch(() => ({ quit: false, mode: 'error' }));
    console.log('已关闭本次启动的 ' + app.appName + '：' + (q.mode || (q.quit ? 'quit' : 'needs-confirm')));
  }
  console.log('小窗已收起');
  await closeOcuMcp().catch(() => {});
  if (!report.ok) process.exitCode = 1;
}

main().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });