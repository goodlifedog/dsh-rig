import { isScreenLocked, lockedSkipNotice } from '../platform.mjs';
'use strict';
// 验证「默认操作你自己的 Chrome」这条链路：只读 + 可选的后台点击，全程不切前台。
//   node core/runner.mjs run user-chrome-demo
//   CLICK_TEXT='某个文字' node core/runner.mjs run user-chrome-demo
import { ensureUserChrome, readState, find, clickText } from '../user-chrome.mjs';
import { getOcuMcp, closeOcuMcp } from '../ocu-mcp.mjs';

function frontmostFromList(text) {
  const line = (text || '').split('\n').find((l) => l.includes('[frontmost'));
  return line ? line.split('—')[0].trim() : null;
}

async function main() {
  // 锁屏下 AX/抓图不可用：这是环境限制，不是任务失败（手动跑也不该红）
  if (await isScreenLocked()) {
    console.log(lockedSkipNotice('user-chrome-demo.mjs'));
    return;
  }
  const mcp = await getOcuMcp();
  const before = frontmostFromList((await mcp.callTool('list_apps', {})).text);
  console.log('操作前前台:', before);

  const ensure = await ensureUserChrome();
  console.log('Chrome 就绪:', ensure.ok, ensure.started ? '(本次启动)' : '(已在运行)');

  const t0 = Date.now();
  const state = await readState({ maxNodes: 3000 });
  const readMs = Date.now() - t0;
  const firstLine = (state.text || '').split('\n').find((l) => l.includes('—')) || '';
  console.log('读界面:', readMs, 'ms |', firstLine.slice(0, 80));

  const target = process.env.CLICK_TEXT;
  let clickInfo = null;
  if (target) {
    const found = await find(target, { limit: 3 });
    console.log('匹配数:', found.matches.length);
    const r = await clickText(target, { limit: 3 });
    clickInfo = { ok: r.ok, x: r.x, y: r.y, error: r.error };
    console.log('sky_click:', JSON.stringify(clickInfo));
  }

  const after = frontmostFromList((await mcp.callTool('list_apps', {})).text);
  console.log('操作后前台:', after);
  const focusKept = before === after;
  console.log('前台是否保持不变:', focusKept);

  await closeOcuMcp();
  console.log(JSON.stringify({ ok: ensure.ok && focusKept && readMs > 0, readMs, focusKept, clicked: clickInfo, before, after }));
}

main().catch(async (e) => { await closeOcuMcp(); console.error('FAIL:', e.message); process.exit(1); });
