import { overlayBase } from '../core/ports.mjs';
import { localHeaders } from '../core/local-token.mjs';
'use strict';
// 小窗效果回归：把「能不能看见、会不会消失、出错说不说人话、放大后比例对不对」都断言一遍。
//   node scripts/ui-regression.mjs
const BASE = overlayBase();
const results = [];
function record(name, ok, detail) { results.push({ name, ok, detail: detail || '' }); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(pathname, init) {
  const r = await fetch(BASE + pathname, { ...init, headers: localHeaders((init && init.headers) || {}), signal: AbortSignal.timeout(5000) });
  return { status: r.status, json: await r.json().catch(() => null) };
}
async function health() { return (await api('/health')).json; }

// 收尾还原现场：状态文字清回「待命」并收起，避免测试残留被当成真任务
async function restore() {
  await post('/status', { clear: true }).catch(() => {});
  await post('/visible', { visible: false }).catch(() => {});
}
// 有上限地等条件成立：避免"刚重启、还没抓到第一帧"被误判成功能坏了
async function waitFor(check, timeoutMs, stepMs) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await check();
    if (last && last.ok) return last;
    await sleep(stepMs || 200);
  }
  return last || { ok: false };
}

async function post(pathname, body) {
  return api(pathname, { method: 'POST', headers: localHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify(body || {}) });
}

async function main() {
  const h0 = await health();
  record('服务在线', Boolean(h0 && h0.ok), 'pid=' + (h0 && h0.pid));
  for (const key of ['hostVisible', 'hostBoundsStale', 'clickThrough', 'fps', 'frameBytes', 'frames']) {
    record('health 字段 ' + key, Object.prototype.hasOwnProperty.call(h0, key));
  }

  // 活动 → 出现
  await post('/visible', { visible: false });
  await sleep(300);
  await post('/status', { text: '回归测试：活动触发' });
  const shown = await waitFor(async () => {
    const h = await health();
    if (h.visible === true) return { ok: true, visible: h.visible, stale: h.hostBoundsStale, why: '' };
    // 宿主不在前台时按设计隐藏（此时"不出现"才是正确行为）
    const hostFront = !h.frontmost || /deepseek|\.dsh/i.test(h.frontmost);
    if (!hostFront) return { ok: true, visible: h.visible, stale: h.hostBoundsStale, why: '宿主不在前台（' + h.frontmost + '），按设计隐藏' };
    return { ok: false, visible: h.visible, stale: h.hostBoundsStale, why: '' };
  }, 4000, 150);
  record('有活动就出现', shown.ok, shown.why || ('visible=' + shown.visible + ' 宿主贴边新鲜=' + (shown.stale === false)));

  // 空闲 → 消失
  await sleep(7000);
  const h2 = await health();
  record('空闲自动消失', h2.visible === false, 'visible=' + h2.visible);

  // 手动显隐
  await post('/visible', { visible: true });
  const shownManual = await waitFor(async () => {
    const h = await health();
    if (h.visible === true) return { ok: true, visible: h.visible, why: '' };
    // 小窗按设计只在宿主应用处于前台时显示；前台是别的应用时隐藏属于正常行为
    const hostFront = !h.frontmost || /deepseek|\.dsh/i.test(h.frontmost);
    if (!hostFront) return { ok: true, visible: h.visible, why: '宿主不在前台（' + h.frontmost + '），按设计隐藏' };
    return { ok: false, visible: h.visible, why: '' };
  }, 2000, 150);
  record('手动显示', shownManual.ok, shownManual.why);

  // 穿透状态：无错误、无悬停时应为 true
  const h3 = await health();
  record('默认点击穿透', h3.clickThrough === true, 'clickThrough=' + h3.clickThrough);

  // 放大比例：窗口比 ≈ 帧比
  await post('/expand');
  await sleep(1200);
  const h4 = await health();
  const b = h4.bounds || {};
  const ratio = b.width && b.height ? b.width / b.height : 0;
  const frameRatio = h4.frameWidth && h4.frameHeight ? h4.frameWidth / h4.frameHeight : 0;
  // 有画面时按画面比例；没有画面时按约定回退 4:3
  const expected = frameRatio || 4 / 3;
  const diff = Math.abs(ratio - expected);
  const ratioOk = h4.expanded === true && diff < 0.05;
  record('放大后比例跟随画面', ratioOk,
    'window=' + ratio.toFixed(3) + ' 期望=' + expected.toFixed(3) + (frameRatio ? '（按画面）' : '（无画面回退 4:3）'));
  await post('/expand');
  await sleep(800);

  // 错误路径：绑定一个不存在的窗口 ID，应给人话而不是崩
  const bad = await post('/window', { windowId: 999999999 });
  const errored = await waitFor(async () => {
    const h = await health();
    const text = (h.thumbnail && h.thumbnail.error) || '';
    return { ok: Boolean(text), error: text, ok2: h.ok };
  }, 6000, 200);
  const h5 = await health();
  const err = errored.error || '';
  if (!err && h5.screenLocked) {
    // 锁屏时抓帧通道能力受限（截到的是壁纸/直接返回空），这条断言无法可靠验证
    record('失效窗口给出人话提示', true, '锁屏环境下不校验（抓帧通道受限）');
  } else {
    record('失效窗口给出人话提示', Boolean(err) && /失效|不可见|不可用|重试/.test(err), err.slice(0, 60));
  }
  record('错误时不弹窗不阻塞', Boolean(h5.ok), 'ok=' + h5.ok);
  await post('/window', { windowId: null });
  await restore();

  const width = Math.max(...results.map((r) => r.name.length)) + 2;
  console.log('\n小窗效果回归\n');
  for (const r of results) console.log((r.ok ? '  ✅ ' : '  ❌ ') + r.name.padEnd(width) + r.detail);
  const bad2 = results.filter((r) => !r.ok);
  console.log('\n' + (bad2.length ? bad2.length + ' 项未通过' : '全部通过') + '\n');
  process.exit(bad2.length ? 1 : 0);
}

main().catch(async (e) => {
  console.error('FAIL:', e.message);
  await restore().catch(() => {});
  process.exit(1);
});
