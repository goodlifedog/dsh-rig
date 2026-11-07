'use strict';
// 操控策略判定：探测结果 → 该怎么控，不能靠人肉看报告
import test from 'node:test';
import assert from 'node:assert/strict';
import { recommendStrategy, STRATEGY_LABELS } from '../core/app-strategy.mjs';

test('关键工具：不接管', () => {
  const r = recommendStrategy({ readable: true, buttons: 3 }, { special: { status: '不动', detail: '代理工具' } });
  assert.equal(r.mode, 'no-touch');
  assert.ok(r.reasons[0].includes('代理工具'));
});

test('专用通道：走独立实例', () => {
  const r = recommendStrategy({ readable: true }, { special: { status: '专用方案', detail: 'headless 实例' } });
  assert.equal(r.mode, 'dedicated');
  assert.ok(r.reasons[0].includes('headless'));
});

test('没装 / 没测 / 数据为空：都是未判定', () => {
  assert.equal(recommendStrategy({ readable: true }, { installed: false }).mode, 'unknown');
  assert.equal(recommendStrategy(null).mode, 'unknown');
  assert.equal(recommendStrategy({ skipped: true }).mode, 'unknown');
});

test('树可读且有按钮：元素级驱动', () => {
  const r = recommendStrategy({ readable: true, nodes: 125, buttons: 20, capture: 'offscreen', textFields: 1 });
  assert.equal(r.mode, 'ax');
  assert.equal(r.canType, true, '有输入框就要标出能打字');
  assert.ok(r.reasons[0].includes('125'));
});

test('树可读但零按钮：只读状态', () => {
  const r = recommendStrategy({ readable: true, nodes: 9, buttons: 0, capture: 'live' });
  assert.equal(r.mode, 'ax-read');
  assert.equal(r.canType, false);
});

test('探测中抢过前台：策略里要提示复查', () => {
  const r = recommendStrategy({ readable: true, nodes: 40, buttons: 5, frontUnchanged: false });
  assert.equal(r.mode, 'ax');
  assert.ok(r.reasons.some((x) => x.includes('抢过前台')));
});

test('读不到树但画面能回显：画面+坐标', () => {
  const live = recommendStrategy({ readable: false, capture: 'live', windowReady: true });
  const off = recommendStrategy({ readable: false, capture: 'offscreen', windowReady: false });
  assert.equal(live.mode, 'visual');
  assert.equal(off.mode, 'visual');
  assert.ok(off.reasons[0].includes('AX 窗口数为 0'));
});

test('启动失败 / 窗口起不来 / 什么都拿不到：应用侧限制', () => {
  assert.equal(recommendStrategy({ readable: false, capture: 'none', launch: 'error' }).mode, 'blocked');
  assert.equal(recommendStrategy({ readable: false, capture: 'none', windowReady: false }).mode, 'blocked');
  assert.equal(recommendStrategy({ readable: false, capture: 'none', launch: 'launched', windowReady: true }).mode, 'blocked');
});

test('每个模式都有中文标签', () => {
  for (const mode of ['ax', 'ax-read', 'visual', 'dedicated', 'no-touch', 'blocked', 'unknown']) {
    assert.ok(STRATEGY_LABELS[mode], mode + ' 缺标签');
  }
});
