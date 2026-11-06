'use strict';
// 会话隔离检查：小窗只能出现在「召唤它的那个会话」里，切走要立刻藏、切回要很快出现。
//   node scripts/session-scope-check.mjs
const BASE = 'http://127.0.0.1:7788';
const A = 'scope-a';
const B = 'scope-b';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rows = [];
function record(name, ok, detail) { rows.push({ name, ok, detail: detail === undefined ? '' : String(detail) }); }

async function api(pathname, init) {
  const r = await fetch(BASE + pathname, { ...init, signal: AbortSignal.timeout(5000) });
  return { status: r.status, json: await r.json().catch(() => null) };
}
const post = (pathname, body) => api(pathname, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }).then((r) => r.json);
const health = (session) => api('/health?session=' + encodeURIComponent(session)).then((r) => r.json);

async function waitFor(check, timeoutMs, stepMs) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await check();
    if (last && last.ok) return last;
    await sleep(stepMs || 100);
  }
  return last || { ok: false };
}

async function cleanup() {
  for (const session of [A, B]) {
    await post('/close', { session }).catch(() => {});
  }
}

async function main() {
  const probe = await health('__none__');
  record('小窗服务在线', Boolean(probe && probe.ok), probe ? '不存在的 session 返回 exists=' + probe.exists + '（按需建窗，不误建）' : '无法连接');
  const title = probe && probe.dshTitle;
  if (!title) {
    record('读得到当前会话标题', false, '拿不到 dshTitle，无法判断归属');
    return;
  }
  record('读得到当前会话标题', true, title);

  await cleanup();
  await sleep(300);

  // A = 当前会话（标题对得上）：应该看得见
  await post('/status', { session: A, text: '会话隔离检查：本会话', titleHint: title });
  await post('/visible', { session: A, visible: true });
  const shownA = await waitFor(async () => {
    const h = await health(A);
    return { ok: h.visible === true && h.matched === true, visible: h.visible, matched: h.matched };
  }, 4000, 100);
  record('召唤它的会话里可见', shownA.ok, 'visible=' + shownA.visible + ' matched=' + shownA.matched);

  // B = 另一个会话（标题对不上）：必须藏起来，哪怕显式要求显示
  await post('/status', { session: B, text: '会话隔离检查：别的会话', titleHint: title + '（另一个会话）' });
  await post('/visible', { session: B, visible: true });
  const hiddenB = await waitFor(async () => {
    const h = await health(B);
    return { ok: h.visible === false, visible: h.visible, matched: h.matched };
  }, 3000, 100);
  record('别的会话里不可见', hiddenB.ok, 'visible=' + hiddenB.visible + ' matched=' + hiddenB.matched);

  // B 的活动不能把 A 顶掉：A 仍然可见
  const stillA = await health(A);
  record('别的会话活动不影响本会话', stillA.visible === true, 'A.visible=' + stillA.visible);

  // 切走：把 A 的归属改成别的会话，模拟用户切到别的会话——应该很快消失
  const before = Date.now();
  await post('/status', { session: A, text: '会话隔离检查：已切走', titleHint: title + '（另一个会话）' });
  const hid = await waitFor(async () => {
    const h = await health(A);
    return { ok: h.visible === false, visible: h.visible };
  }, 3000, 50);
  const hideMs = Date.now() - before;
  record('切走后消失', hid.ok && hideMs <= 1000, 'visible=' + hid.visible + ' 用时=' + hideMs + 'ms（要求 ≤1000ms）');

  // 切回：归属改回当前会话，应较快重新出现
  const t2 = Date.now();
  await post('/status', { session: A, text: '会话隔离检查：切回来', titleHint: title });
  const back = await waitFor(async () => {
    const h = await health(A);
    return { ok: h.visible === true, visible: h.visible };
  }, 3000, 50);
  const showMs = Date.now() - t2;
  record('切回后重新出现', back.ok && showMs <= 1500, 'visible=' + back.visible + ' 用时=' + showMs + 'ms（要求 ≤1500ms）');

  await post('/status', { session: A, clear: true });
  await post('/visible', { session: A, visible: false });
}

const width = Math.max(...rows.map((r) => r.name.length)) + 2;
main()
  .catch((e) => { console.error('FAIL:', e.message); process.exitCode = 1; })
  .finally(async () => {
    await cleanup();
    console.log('\n会话隔离检查\n');
    for (const r of rows) console.log((r.ok ? '  ✅ ' : '  ❌ ') + r.name.padEnd(width) + r.detail);
    const bad = rows.filter((r) => !r.ok);
    console.log('\n' + (bad.length ? bad.length + ' 项未通过' : '全部通过') + '\n');
    if (bad.length && !process.exitCode) process.exitCode = 1;
  });
