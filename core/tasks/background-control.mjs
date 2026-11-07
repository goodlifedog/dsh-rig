#!/usr/bin/env node
/**
 * 后台控制验收：启动软件、点击、写入，全程不抢前台，并把真实窗口回显到小窗。
 *
 *   node core/tasks/background-control.mjs
 *
 * 结论以 JSON 输出：每个动作都带「操作前后前台是否一致」的证据。
 */
import { ensureAppRunning, frontName, state, find, click, setValue } from '../background.mjs';
import { closeOcuMcp } from '../ocu-mcp.mjs';

const OVERLAY = process.env.OVERLAY_URL || 'http://127.0.0.1:7788';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const S_NOTES = 'bg-notes';
const S_CALC = 'bg-calc';

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
function record(name, ok, extra) {
  steps.push(Object.assign({ name, ok }, extra || {}));
  console.log((ok ? '  ✅ ' : '  ❌ ') + name + (extra && extra.detail ? '  ' + extra.detail : ''));
}

async function main() {
  const frontAtStart = await frontName();
  console.log('起点前台:', frontAtStart);

  // 1. 后台启动备忘录（冷启动，最容易把前台顶掉的一步）
  const launch = await ensureAppRunning({ bundleId: 'com.apple.Notes', appName: '备忘录' });
  record('后台启动备忘录（open -g，不激活）', launch.frontUnchanged !== false && !launch.error, {
    frontUnchanged: launch.frontUnchanged !== false,
    detail: launch.launched ? '冷启动成功，前台仍是 ' + launch.front : '本来就在运行',
  });
  await sleep(1500);

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
    record('真实窗口回显（备忘录）', h && h.thumbnail && h.thumbnail.state === 'live', {
      detail: 'windowId=' + notesWin.windowId + ' state=' + (h && h.thumbnail && h.thumbnail.state),
    });
  } else {
    record('真实窗口回显（备忘录）', false, { detail: '窗口列表里没有备忘录' });
  }

  // 3. 后台新建备忘录
  const btns = await find('备忘录', { role: 'AXButton', limit: 25 });
  const newBtn = btns.find((b) => String(b.title || '').includes('新建备忘录'));
  if (newBtn) {
    const r = await click('备忘录', newBtn.index);
    record('后台点击「新建备忘录」', r.ok && r.frontUnchanged, { frontUnchanged: r.frontUnchanged, detail: r.error || '' });
    await sleep(700);
  } else {
    record('后台点击「新建备忘录」', false, { detail: '找不到按钮' });
  }

  // 4. 后台写入正文并校验
  const areas = await find('备忘录', { role: 'AXTextArea', limit: 5 });
  const area = areas[0];
  const text = '后台控制验证：' + new Date().toLocaleTimeString('zh-CN');
  if (area) {
    const w = await setValue('备忘录', area.index, text);
    record('后台写入正文（AX set_value）', w.ok && w.frontUnchanged, { frontUnchanged: w.frontUnchanged, detail: w.error || '' });
    await sleep(500);
    const tree = await state('备忘录');
    record('读回正文校验', tree.includes('后台控制验证'), { detail: tree.includes(text) ? '内容一致' : '内容不完全一致' });
  } else {
    record('后台写入正文（AX set_value）', false, { detail: '找不到文本区' });
  }

  // 5. 计算器：后台点击按钮
  const calcBtns = await find('计算器', { role: 'AXButton', limit: 40 });
  const seven = calcBtns.find((b) => /^(7|Seven)$/.test(String(b.title || b.identifier || '')));
  if (seven) {
    const before = (await state('计算器')).match(/文本\s*[\u200e]?\s*(-?[\d.,]+)/);
    const r = await click('计算器', seven.index);
    await sleep(400);
    const after = (await state('计算器')).match(/文本\s*[\u200e]?\s*(-?[\d.,]+)/);
    const changed = before && after && before[1] !== after[1];
    record('后台点击计算器按钮', r.ok && r.frontUnchanged && Boolean(changed), {
      frontUnchanged: r.frontUnchanged,
      detail: (before && before[1]) + ' → ' + (after && after[1]),
    });
  } else {
    record('后台点击计算器按钮', false, { detail: '找不到按钮 7' });
  }

  // 6. 文本编辑：后台设值
  const textAreas = await find('文本编辑', { role: 'AXTextArea', limit: 5 });
  if (textAreas[0]) {
    const w = await setValue('文本编辑', textAreas[0].index, '后台写入：' + new Date().toLocaleTimeString('zh-CN'));
    record('后台写入文本编辑（AX set_value）', w.ok && w.frontUnchanged, { frontUnchanged: w.frontUnchanged, detail: w.error || '' });
  } else {
    record('后台写入文本编辑（AX set_value）', false, { detail: '找不到文本区' });
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
  console.log('小窗已收起');
  await closeOcuMcp().catch(() => {});
  if (!report.ok) process.exitCode = 1;
}

main().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
