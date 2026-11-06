'use strict';
// 小窗效果回归：把「能不能看见、会不会消失、出错说不说人话、放大后比例对不对」都断言一遍。
//   node scripts/ui-regression.mjs
const BASE = 'http://127.0.0.1:7788';
const results = [];
function record(name, ok, detail) { results.push({ name, ok, detail: detail || '' }); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(pathname, init) {
  const r = await fetch(BASE + pathname, { ...init, signal: AbortSignal.timeout(5000) });
  return { status: r.status, json: await r.json().catch(() => null) };
}
async function health() { return (await api('/health')).json; }
async function post(pathname, body) {
  return api(pathname, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
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
  await sleep(1200);
  const h1 = await health();
  record('有活动就出现', h1.visible === true, 'visible=' + h1.visible);

  // 空闲 → 消失
  await sleep(7000);
  const h2 = await health();
  record('空闲自动消失', h2.visible === false, 'visible=' + h2.visible);

  // 手动显隐
  await post('/visible', { visible: true });
  await sleep(700);
  const h3 = await health();
  record('手动显示', h3.visible === true);

  // 穿透状态：无错误、无悬停时应为 true
  record('默认点击穿透', h3.clickThrough === true, 'clickThrough=' + h3.clickThrough);

  // 放大比例：窗口比 ≈ 帧比
  await post('/expand');
  await sleep(1200);
  const h4 = await health();
  const b = h4.bounds || {};
  const ratio = b.width && b.height ? b.width / b.height : 0;
  const frameRatio = h4.frameWidth && h4.frameHeight ? h4.frameWidth / h4.frameHeight : 0;
  const diff = frameRatio ? Math.abs(ratio - frameRatio) : 1;
  record('放大后比例跟随画面', h4.expanded === true && diff < 0.05,
    'window=' + ratio.toFixed(3) + ' frame=' + frameRatio.toFixed(3));
  await post('/expand');
  await sleep(800);

  // 错误路径：绑定一个不存在的窗口 ID，应给人话而不是崩
  const bad = await post('/window', { windowId: 999999999 });
  await sleep(1500);
  const h5 = await health();
  const err = (h5.thumbnail && h5.thumbnail.error) || '';
  record('失效窗口给出人话提示', Boolean(err) && /失效|不可见|不可用|重试/.test(err), err.slice(0, 60));
  record('错误时不弹窗不阻塞', Boolean(h5.ok), 'ok=' + h5.ok);
  await post('/window', { windowId: null });

  const width = Math.max(...results.map((r) => r.name.length)) + 2;
  console.log('\n小窗效果回归\n');
  for (const r of results) console.log((r.ok ? '  ✅ ' : '  ❌ ') + r.name.padEnd(width) + r.detail);
  const bad2 = results.filter((r) => !r.ok);
  console.log('\n' + (bad2.length ? bad2.length + ' 项未通过' : '全部通过') + '\n');
  process.exit(bad2.length ? 1 : 0);
}

main().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
