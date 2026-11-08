'use strict';
// 小窗显示门控：task-27 把「未知前台/未知标题/宿主快照过期」统一改为 fail-closed。
// 这里锁住 ready-to-show 与活动驱动 showOverlay 共用的显示判定，以及 clear/expand 语义。
import test from 'node:test';
import assert from 'node:assert/strict';
import sessionGate from '../overlay/session-gate.js';

const {
  shouldShowOnReady,
  shouldShowNow,
  isHostSnapshotFresh,
  shouldCountStatusActivity,
  shouldIgnoreExpand,
  matchesTitle,
} = sessionGate;

const NOW = 1000000;
// 基准：宿主可见、快照 1 秒前刚拿到、前台是 DSH、标题已知且匹配、有活动
const base = {
  hostVisible: true,
  hostStale: false,
  hostCheckedAt: NOW - 1000,
  now: NOW,
  front: 'com.deepseek.dsh',
  hostBundles: ['com.deepseek.dsh'],
  self: 'com.github.Electron',
  titleKnown: true,
  titleMatched: true,
  hasActivity: true,
};

// ---------- shouldShowOnReady（ready-to-show） ----------

test('宿主在前台、快照新鲜、标题匹配且有活动 → 显示', () => {
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

test('前台读不到（空）→ fail-closed 不显示（task-27 R2）', () => {
  assert.equal(shouldShowOnReady({ ...base, front: '' }), false);
});

test('前台为 null/undefined → fail-closed 不显示', () => {
  assert.equal(shouldShowOnReady({ ...base, front: null }), false);
  assert.equal(shouldShowOnReady({ ...base, front: undefined }), false);
});

test('宿主标题还没读到（titleKnown=false）→ 不显示（task-27 R2）', () => {
  assert.equal(shouldShowOnReady({ ...base, titleKnown: false }), false);
});

test('宿主 bounds 是 stale → 不显示（task-27 R1）', () => {
  assert.equal(shouldShowOnReady({ ...base, hostStale: true }), false);
});

test('宿主快照时间戳为 0（从没拿到过）→ 不显示', () => {
  assert.equal(shouldShowOnReady({ ...base, hostCheckedAt: 0 }), false);
});

test('宿主快照超过 5 秒 → 不显示', () => {
  assert.equal(shouldShowOnReady({ ...base, hostCheckedAt: NOW - 5001 }), false);
});

test('宿主快照正好 5 秒 → 仍显示（边界）', () => {
  assert.equal(shouldShowOnReady({ ...base, hostCheckedAt: NOW - 5000 }), true);
});

test('前台就是 overlay 自己（self bundle）→ 显示', () => {
  assert.equal(shouldShowOnReady({ ...base, front: 'com.github.Electron' }), true);
});

// ---------- shouldShowNow（活动驱动 showOverlay 的统一门控） ----------

test('showOverlay：四条件全满足 → 显示', () => {
  const { hasActivity, ...input } = base;
  assert.equal(shouldShowNow(input), true);
});

test('showOverlay：hostVisible=false → 不显示（task-27 R1）', () => {
  const { hasActivity, ...input } = base;
  assert.equal(shouldShowNow({ ...input, hostVisible: false }), false);
});

test('showOverlay：hostStale=true → 不显示', () => {
  const { hasActivity, ...input } = base;
  assert.equal(shouldShowNow({ ...input, hostStale: true }), false);
});

test('showOverlay：快照过期 → 不显示', () => {
  const { hasActivity, ...input } = base;
  assert.equal(shouldShowNow({ ...input, hostCheckedAt: NOW - 60000 }), false);
});

test('showOverlay：前台未知 → 不显示（fail-closed）', () => {
  const { hasActivity, ...input } = base;
  assert.equal(shouldShowNow({ ...input, front: '' }), false);
});

test('showOverlay：前台不是宿主 → 不显示', () => {
  const { hasActivity, ...input } = base;
  assert.equal(shouldShowNow({ ...input, front: 'com.apple.Safari' }), false);
});

test('showOverlay：标题不匹配 → 不显示', () => {
  const { hasActivity, ...input } = base;
  assert.equal(shouldShowNow({ ...input, titleMatched: false }), false);
});

test('showOverlay：标题未知 → 不显示', () => {
  const { hasActivity, ...input } = base;
  assert.equal(shouldShowNow({ ...input, titleKnown: false }), false);
});

// ---------- 快照新鲜度纯函数 ----------

test('isHostSnapshotFresh：未传 hostCheckedAt 时按当前时间视为新鲜', () => {
  assert.equal(isHostSnapshotFresh({ hostVisible: true, now: NOW }), true);
});

test('isHostSnapshotFresh：时钟倒退（age < 0）按不新鲜处理', () => {
  assert.equal(isHostSnapshotFresh({ hostVisible: true, hostCheckedAt: NOW + 1, now: NOW }), false);
});

// ---------- clear / expand 语义 ----------

test('普通 /status 算活动，clear:true 不算活动（task-27 R4）', () => {
  assert.equal(shouldCountStatusActivity({}), true);
  assert.equal(shouldCountStatusActivity({ clear: false }), true);
  assert.equal(shouldCountStatusActivity({ clear: true }), false);
});

test('隐藏态 /expand 忽略；可见时允许；折叠始终允许（task-27 R6）', () => {
  assert.equal(shouldIgnoreExpand({ visible: false, expanded: false }), true);
  assert.equal(shouldIgnoreExpand({ visible: true, expanded: false }), false);
  // 隐藏态但已展开：允许折叠，避免卡在放大态
  assert.equal(shouldIgnoreExpand({ visible: false, expanded: true }), false);
  assert.equal(shouldIgnoreExpand({ visible: true, expanded: true }), false);
});

test('标题门控本身：完全一致才匹配，前缀相同不算', () => {
  assert.equal(matchesTitle('规划布局探讨', '规划布局探讨 — DeepSeek Harness'), true);
  assert.equal(matchesTitle('规划布局探讨', '规划布局探讨（二） — DeepSeek Harness'), false);
});
