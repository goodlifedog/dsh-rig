'use strict';
import test from 'node:test';
import assert from 'node:assert/strict';
import { coordinateClickPolicy } from '../core/user-chrome.mjs';
import {
  rand,
  makeRng,
  jitterPoint,
  buildTrajectory,
  playTrajectory,
  humanType,
  preActionPause,
  betweenActions,
  typoChar,
} from '../core/humanize.mjs';

// ---------- 随机源 ----------

test('rand 落在闭区间内且不是常数', () => {
  const rng = makeRng(7);
  const vals = Array.from({ length: 500 }, () => rand(10, 20, rng));
  for (const v of vals) assert.ok(v >= 10 && v <= 20, '越界: ' + v);
  assert.ok(new Set(vals).size > 100, '取值太集中');
});

test('makeRng 同 seed 可复现、不同 seed 不同', () => {
  const a = makeRng(123);
  const b = makeRng(123);
  const c = makeRng(124);
  const seqA = Array.from({ length: 20 }, () => a());
  const seqB = Array.from({ length: 20 }, () => b());
  const seqC = Array.from({ length: 20 }, () => c());
  assert.deepEqual(seqA, seqB);
  assert.notDeepEqual(seqA, seqC);
});

test('typoChar 只从给定候选里挑', () => {
  const rng = makeRng(3);
  for (let i = 0; i < 200; i++) assert.ok('ab'.includes(typoChar(rng, 'ab')));
});

// ---------- 落点抖动 ----------

test('jitterPoint 抖动半径有界（1000 次）', () => {
  const rng = makeRng(11);
  for (let i = 0; i < 1000; i++) {
    const p = jitterPoint(300, 500, 3, rng);
    assert.ok(Math.abs(p.x - 300) <= 3, 'x 抖出界: ' + (p.x - 300));
    assert.ok(Math.abs(p.y - 500) <= 3, 'y 抖出界: ' + (p.y - 500));
    assert.equal(p.x, Math.round(p.x), '落点必须是整数像素');
  }
});

test('jitterPoint 确实在抖、radius=0 时精确', () => {
  const rng = makeRng(12);
  const set = new Set();
  for (let i = 0; i < 200; i++) {
    const p = jitterPoint(100, 100, 3, rng);
    set.add(p.x + ',' + p.y);
  }
  assert.ok(set.size > 20, '抖动退化成了固定点');
  assert.deepEqual(jitterPoint(100, 100, 0), { x: 100, y: 100 });
});

// ---------- 移动轨迹 ----------

const P = (x, y) => ({ x, y });

test('buildTrajectory 首点=起点、末点=目标点、步数在范围内', () => {
  const rng = makeRng(21);
  const from = P(20, 40);
  const to = P(420, 300);
  const path = buildTrajectory(from, to, { rng });
  assert.deepEqual(path[0], { x: 20, y: 40, ms: 0 });
  assert.deepEqual(path[path.length - 1], { x: 420, y: 300, ms: 0 });
  assert.ok(path.length > 7, '步数太少，像瞬移: ' + path.length);
  assert.ok(path.length <= 61, '步数太多');
});

test('buildTrajectory 是分步移动：相邻点到点不重复、总步长不突变', () => {
  const rng = makeRng(22);
  const path = buildTrajectory(P(100, 100), P(700, 100), { rng });
  let maxStep = 0;
  for (let i = 1; i < path.length; i++) {
    const d = Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y);
    assert.ok(d > 0, '第 ' + i + ' 步没动');
    maxStep = Math.max(maxStep, d);
  }
  assert.ok(maxStep < 120, '单步跨度过大，像瞬移: ' + maxStep);
});

test('buildTrajectory 真的走曲线（多 seed 统计偏离直线）', () => {
  let curved = 0;
  const straight = 40; // 0 -> 400 的水平线，垂直偏离即弧度
  for (let seed = 1; seed <= 20; seed++) {
    const path = buildTrajectory(P(0, straight), P(400, straight), { rng: makeRng(seed), bend: 0.5 });
    const maxDev = Math.max(...path.map((p) => Math.abs(p.y - straight)));
    if (maxDev > 4) curved++;
  }
  assert.ok(curved >= 15, '轨迹近直线，几乎没有弧度: ' + curved + '/20');
});

test('buildTrajectory 沿目标方向基本单调推进（不回退）', () => {
  const path = buildTrajectory(P(0, 0), P(400, 0), { rng: makeRng(23) });
  for (let i = 1; i < path.length; i++) {
    assert.ok(path[i].x >= path[i - 1].x - 3, '第 ' + i + ' 步往回走了');
  }
});

test('buildTrajectory 每步耗时：两端慢、中段快，且不为 0', () => {
  const path = buildTrajectory(P(0, 0), P(280, 0), { rng: makeRng(24) });
  const ms = path.slice(1, -1).map((p) => p.ms); // 末步是落地停顿，单独断言
  for (const t of ms) assert.ok(t >= 6 && t <= 32, '单步耗时越界: ' + t);
  const n = ms.length;
  const head = ms.slice(0, Math.max(1, Math.round(n * 0.15)));
  const mid = ms.slice(Math.round(n * 0.4), Math.round(n * 0.6));
  const avg = (a) => a.reduce((s, v) => s + v, 0) / a.length;
  assert.ok(avg(head) > avg(mid), '起步没有减速: ' + avg(head) + ' vs ' + avg(mid));
  assert.equal(path[path.length - 1].ms, 0, '末步落地后不应再等');
});

// ---------- 轨迹播放 ----------

test('playTrajectory 逐步等待并逐点交给 emit', async () => {
  const rng = makeRng(31);
  const from = P(10, 10);
  const to = P(310, 210);
  const path = buildTrajectory(from, to, { rng });
  const waits = [];
  const emitted = [];
  const meta = await playTrajectory(path, {
    sleepFn: async (ms) => { waits.push(Math.round(ms)); },
    emit: (p, i) => { emitted.push([i, p.x, p.y]); },
  });
  const expectWait = path.reduce((s, p) => s + p.ms, 0);
  assert.equal(waits.length, path.filter((p) => p.ms).length);
  assert.ok(Math.abs(waits.reduce((s, v) => s + v, 0) - expectWait) <= path.length, '等待总时长与轨迹不符');
  assert.equal(emitted.length, path.length);
  assert.deepEqual(meta.end, to);
  assert.equal(meta.steps, path.length);
  assert.ok(meta.movedPx > 100);
});

test('playTrajectory 不传 emit 也能只走节奏', async () => {
  const path = buildTrajectory(P(0, 0), P(100, 0), { rng: makeRng(32) });
  const waits = [];
  const meta = await playTrajectory(path, { sleepFn: async (ms) => { waits.push(ms); } });
  assert.ok(meta.waitedMs > 0);
  assert.ok(waits.length > 0);
});

// ---------- 停顿区间 ----------

test('preActionPause / betweenActions 落在区间内', async () => {
  const rng = makeRng(41);
  const pre = [];
  const between = [];
  for (let i = 0; i < 200; i++) {
    await preActionPause(1, { rng, sleepFn: async (ms) => { pre.push(ms); } });
    await betweenActions(1, { rng, sleepFn: async (ms) => { between.push(ms); } });
  }
  for (const ms of pre) assert.ok(ms >= 90 && ms <= 260, 'preActionPause 越界: ' + ms);
  for (const ms of between) assert.ok(ms >= 180 && ms <= 520, 'betweenActions 越界: ' + ms);
});

// ---------- 分段输入 ----------

function recorder() {
  const buffer = { text: '' };
  const calls = [];
  const delays = [];
  const typeFn = async (part) => { calls.push(part); buffer.text += part; };
  const sleepFn = async (ms) => { delays.push(ms); };
  return { buffer, calls, delays, typeFn, sleepFn };
}

test('humanType 按码点分段：不会切坏 emoji，最终内容与原文一致', async () => {
  const text = '中文🙂测试abc🚀结束';
  const r = recorder();
  const meta = await humanType(r.typeFn, text, { rng: makeRng(51), sleepFn: r.sleepFn, minDelay: 0, maxDelay: 0, pauseChance: 0 });
  assert.equal(r.buffer.text, text, '拼回来和原文不一致');
  assert.equal(meta.chars, Array.from(text).length);
  for (const part of r.calls) {
    assert.ok(Array.from(part).length >= 1 && Array.from(part).length <= 3, '分段长度越界: ' + JSON.stringify(part));
  }
});

test('humanType 段间延迟在区间内，长停顿也落在区间内', async () => {
  const text = '这是一段用于验证停顿区间的文字共二十个字';
  const r = recorder();
  await humanType(r.typeFn, text, { rng: makeRng(52), sleepFn: r.sleepFn, minDelay: 40, maxDelay: 130, pauseChance: 1, pauseMs: [260, 620] });
  const inShort = r.delays.filter((ms) => ms >= 40 && ms <= 130).length;
  const inPause = r.delays.filter((ms) => ms >= 260 && ms <= 620).length;
  assert.ok(inShort > 0, '没有段间延迟');
  assert.ok(inPause > 0, 'pauseChance=1 时没有长停顿');
  for (const ms of r.delays) assert.ok((ms >= 40 && ms <= 130) || (ms >= 260 && ms <= 620), '延迟越界: ' + ms);
});

// ---------- 打错字 + 退格纠错 ----------

test('humanType 会偶发打错字并退格纠正，最终内容仍然正确', async () => {
  const text = '拟人输入测试ABC';
  const r = recorder();
  const backspaces = [];
  const meta = await humanType(r.typeFn, text, {
    rng: makeRng(61),
    sleepFn: r.sleepFn,
    minDelay: 0,
    maxDelay: 0,
    pauseChance: 0,
    typoChance: 1, // 每段都打一次错，确保必然触发
    typoPool: 'xyz',
    backspace: async (n) => {
      backspaces.push(n);
      const chars = Array.from(r.buffer.text);
      chars.splice(chars.length - n, n);
      r.buffer.text = chars.join('');
    },
  });
  assert.equal(r.buffer.text, text, '纠错后内容不对: ' + JSON.stringify(r.buffer.text));
  assert.ok(backspaces.length > 0, '没有触发退格');
  assert.equal(meta.typos, backspaces.length);
  for (const n of backspaces) assert.equal(n, 1, '删字数与打错字数不符');
  // 每次打错后 buffer 里应当出现过来自 typoPool 的字符
  assert.ok(meta.typoDetail.every((t) => 'xyz'.includes(t.wrong)));
});

// ---------- 坐标点击政策（禁止对用户 App 截图） ----------

test('坐标点击默认被拒：用户 App 不允许截图', () => {
  const p = coordinateClickPolicy();
  assert.equal(p.allowed, false);
  assert.match(p.reason, /截图/);
  assert.equal(coordinateClickPolicy({ app: 'Google Chrome', human: true }).allowed, false);
});

test('只有显式 pixels / allowScreenshot 才放行坐标点击', () => {
  assert.equal(coordinateClickPolicy({ pixels: true }).allowed, true);
  assert.equal(coordinateClickPolicy({ allowScreenshot: true }).allowed, true);
  assert.equal(coordinateClickPolicy({ allowScreenshot: false }).allowed, false);
});

test('humanType 不传 backspace 时不会打错字', async () => {
  const text = '没有纠错能力就不要故意打错';
  const r = recorder();
  const meta = await humanType(r.typeFn, text, { rng: makeRng(62), sleepFn: r.sleepFn, minDelay: 0, maxDelay: 0, pauseChance: 0, typoChance: 1 });
  assert.equal(r.buffer.text, text);
  assert.equal(meta.typos, 0);
});
