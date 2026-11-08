'use strict';
// 前台风险名单：用户最在意「不要切屏」，所以名单必须只按证据加、能过期、能清，
// 而且读不到/坏文件时不能把功能带崩。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  emptyRiskState,
  parseRiskState,
  isRisky,
  noteSteal,
  clearRisk,
  riskSummary,
  saveRisk,
  loadRisk,
  createRiskGate,
  seedFromMatrixRows,
  partitionRisky,
} from '../core/front-risk.mjs';

const DAY = 24 * 60 * 60 * 1000;

test('坏文件/空内容当空名单，不抛错', () => {
  assert.deepEqual(parseRiskState(''), emptyRiskState());
  assert.deepEqual(parseRiskState('not json'), emptyRiskState());
  assert.deepEqual(parseRiskState('{"apps":null}'), emptyRiskState());
  assert.deepEqual(parseRiskState('[1,2]'), emptyRiskState());
});

test('解析时丢掉没有次数/过期时间的脏条目', () => {
  const state = parseRiskState(JSON.stringify({ apps: { A: { count: 2, expiresAt: 123 }, B: { count: 0 }, C: {} } }));
  assert.deepEqual(Object.keys(state.apps), ['A']);
});

test('记一次抢前台 → 立刻生效；过期后不再生效', () => {
  const now = 1_800_000_000_000;
  const state = noteSteal(emptyRiskState(), 'Ghostty', now);
  assert.equal(isRisky(state, 'Ghostty', now), true);
  assert.equal(isRisky(state, 'Ghostty', now + 31 * DAY), false, '默认 30 天后过期，避免永久误伤');
  assert.equal(isRisky(state, '别的应用', now), false);
});

test('阈值可调：默认 1 次就跳过，调高要攒够次数', () => {
  const now = Date.now();
  const once = noteSteal(emptyRiskState(), 'QQ', now);
  assert.equal(isRisky(once, 'QQ', now), true);
  assert.equal(isRisky(once, 'QQ', now, { threshold: 2 }), false);
  const twice = noteSteal(once, 'QQ', now);
  assert.equal(isRisky(twice, 'QQ', now, { threshold: 2 }), true);
});

test('noteSteal 不改原对象（纯函数），count 可一次补多条历史证据', () => {
  const base = emptyRiskState();
  const seeded = noteSteal(base, 'Steam', Date.now(), { count: 3 });
  assert.deepEqual(base.apps, {});
  assert.equal(seeded.apps.Steam.count, 3);
});

test('clear：清单个 / 清全部', () => {
  let state = noteSteal(emptyRiskState(), 'A', Date.now());
  state = noteSteal(state, 'B', Date.now());
  assert.deepEqual(Object.keys(clearRisk(state, 'A').apps), ['B']);
  assert.deepEqual(Object.keys(clearRisk(state).apps), []);
});

test('summary：生效的排前面，带剩余天数', () => {
  const now = Date.now();
  let state = noteSteal(emptyRiskState(), 'Old', now - 40 * DAY);
  state = noteSteal(state, 'New', now);
  const list = riskSummary(state, now);
  assert.equal(list[0].app, 'New');
  assert.equal(list[0].active, true);
  assert.equal(list[1].active, false);
  assert.ok(list[0].daysLeft > 0);
});

test('读写文件：600 权限、原子写入、读坏文件返回空', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'front-risk-'));
  const file = path.join(dir, 'front-risk.json');
  try {
    const state = noteSteal(emptyRiskState(), 'Gemini', Date.now());
    saveRisk(state, file);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(isRisky(loadRisk(file), 'Gemini'), true);
    fs.writeFileSync(file, '{oops');
    assert.deepEqual(loadRisk(file), emptyRiskState());
    assert.deepEqual(loadRisk(path.join(dir, 'missing.json')), emptyRiskState());
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('门控：shouldSkip/note/clear 走同一份文件；enabled=false 时全部放行且不写盘', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'front-risk-gate-'));
  const file = path.join(dir, 'risk.json');
  try {
    const gate = createRiskGate({ file, now: () => 1_800_000_000_000 });
    assert.equal(gate.shouldSkip('ChatGPT'), false);
    gate.note('ChatGPT');
    assert.equal(gate.shouldSkip('ChatGPT'), true);
    gate.clear('ChatGPT');
    assert.equal(gate.shouldSkip('ChatGPT'), false);

    const offFile = path.join(dir, 'off.json');
    const off = createRiskGate({ file: offFile, enabled: false });
    off.note('Ghostty');
    assert.equal(off.shouldSkip('Ghostty'), false);
    assert.equal(fs.existsSync(offFile), false, '关闭时不该写盘');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('默认门控：AGENT_FRONT_RISK=off 时全部放行（保留强制重测的出口）', async () => {
  const { frontRiskGate, resetFrontRiskGate } = await import('../core/background.mjs');
  const prev = process.env.AGENT_FRONT_RISK;
  process.env.AGENT_FRONT_RISK = 'off';
  resetFrontRiskGate();
  assert.equal(frontRiskGate().shouldSkip('Ghostty'), false);
  if (prev === undefined) delete process.env.AGENT_FRONT_RISK; else process.env.AGENT_FRONT_RISK = prev;
  resetFrontRiskGate();
});

test('从历史矩阵报告补种：只认明确抢过前台的证据', () => {
  const now = Date.now();
  const rows = [
    { app: 'Ghostty', frontInchanged: true },
    { app: 'Ghostty', frontStolen: true },
    { app: 'ChatGPT', frontUnchanged: false },
    { app: 'Calculator', frontUnchanged: true },
    { app: 'iMovie', captureStoleFront: true },
    { app: 'Skipped', skipped: true },
    null,
  ];
  const state = seedFromMatrixRows(rows, { now });
  assert.equal(isRisky(state, 'Ghostty', now), true);
  assert.equal(state.apps.Ghostty.count, 1);
  assert.equal(isRisky(state, 'ChatGPT', now), true);
  assert.equal(isRisky(state, 'iMovie', now), true);
  assert.equal(isRisky(state, 'Calculator', now), false);
  assert.equal(isRisky(state, 'Skipped', now), false);
});
test('拆分探测列表：风险名单里的挑出来（按名字或 bundle），其余保留', () => {
  const now = Date.now();
  let state = noteSteal(emptyRiskState(), 'Ghostty', now);
  const { safe, risky } = partitionRisky([
    { name: 'Ghostty', bundle: 'com.mitchellh.ghostty' },
    { name: 'Calculator', bundle: 'com.apple.calculator' },
    { name: 'WeChat', bundle: 'com.tencent.xinWeChat' },
  ], state, now);
  assert.deepEqual(risky.map((a) => a.name), ['Ghostty']);
  assert.deepEqual(safe.map((a) => a.name), ['Calculator', 'WeChat']);
});

test('拆分为空/缺字段不崩', () => {
  assert.deepEqual(partitionRisky(null, emptyRiskState()).safe, []);
  const r = partitionRisky([null, { name: 'A' }], emptyRiskState());
  assert.deepEqual(r.safe.map((a) => a.name), ['A']);
});
