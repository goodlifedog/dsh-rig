'use strict';
// 小窗「刚创建就无条件显示」是真实 bug：用户正在别的应用/别的 Space 时会看到它冒出来。
// 这里锁住 ready-to-show 的显示条件。
import test from 'node:test';
import assert from 'node:assert/strict';
import sessionGate from '../overlay/session-gate.js';

const { shouldShowOnReady, matchesTitle } = sessionGate;

const base = { hostVisible: true, front: 'com.deepseek.dsh', hostBundles: ['com.deepseek.dsh'], titleMatched: true, hasActivity: true };

test('宿主在前台且有活动 → 显示', () => {
  assert.equal(shouldShowOnReady(base), true);
});

test('用户切到别的应用 → 不显示', () => {
  assert.equal(shouldShowOnReady({ ...base, front: 'com.apple.Preview' }), false);
});

test('宿主窗口不可见（最小化/别的 Space）→ 不显示', () => {
  assert.equal(shouldShowOnReady({ ...base, hostVisible: false }), false);
});

test('会话标题对不上（切到别的 DSH 会话）→ 不显示', () => {
  assert.equal(shouldShowOnReady({ ...base, titleMatched: false }), false);
});

test('新建窗口但还没有任何活动 → 不显示（等第一次状态/日志再出现）', () => {
  assert.equal(shouldShowOnReady({ ...base, hasActivity: false }), false);
});

test('前台读不到（空）→ 不据此硬拦', () => {
  assert.equal(shouldShowOnReady({ ...base, front: '' }), true);
});

test('标题门控本身：完全一致才匹配，前缀相同不算', () => {
  assert.equal(matchesTitle('规划布局探讨', '规划布局探讨 — DeepSeek Harness'), true);
  assert.equal(matchesTitle('规划布局探讨', '规划布局探讨（二） — DeepSeek Harness'), false);
});
