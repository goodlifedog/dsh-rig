'use strict';
// task-86：小窗跨会话泄漏的纯逻辑（窗口归属/连续异常/窗口审计）。
// 不启动 Electron、不碰真实窗口。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import policy from '../overlay/session-policy.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const {
  DEFAULT_ORPHAN_DESTROY_STREAK,
  isSessionAllowedToBeVisible,
  nextViolationStreak,
  shouldDestroyWindow,
  summarizeWindowAudit,
} = policy;

test('窗口可见判定：会话必须存在、窗口可用、state.visible、未 suppress、门控允许', () => {
  const allowed = {
    sessionExists: true,
    windowUsable: true,
    stateVisible: true,
    suppress: false,
    gateAllowed: true,
  };
  assert.equal(isSessionAllowedToBeVisible(allowed), true);
  // 任一条件不满足都必须不可见（fail-closed）
  assert.equal(isSessionAllowedToBeVisible({ ...allowed, sessionExists: false }), false);
  assert.equal(isSessionAllowedToBeVisible({ ...allowed, windowUsable: false }), false);
  assert.equal(isSessionAllowedToBeVisible({ ...allowed, stateVisible: false }), false);
  assert.equal(isSessionAllowedToBeVisible({ ...allowed, suppress: true }), false);
  assert.equal(isSessionAllowedToBeVisible({ ...allowed, gateAllowed: false }), false);
  assert.equal(isSessionAllowedToBeVisible({}), false);
  assert.equal(isSessionAllowedToBeVisible(), false);
});

test('连续异常计数：异常累加、恢复正常归零、脏输入不放大', () => {
  assert.equal(nextViolationStreak(0, true), 1);
  assert.equal(nextViolationStreak(2, true), 3);
  assert.equal(nextViolationStreak(5, false), 0);
  assert.equal(nextViolationStreak(-3, true), 1);
  assert.equal(nextViolationStreak(NaN, true), 1);
  assert.equal(nextViolationStreak('4', true), 5);
  assert.equal(nextViolationStreak(undefined, false), 0);
});

test('销毁阈值：默认连续 3 轮；阈值非法/未达到都不销毁', () => {
  assert.equal(DEFAULT_ORPHAN_DESTROY_STREAK, 3);
  assert.equal(shouldDestroyWindow(2), false);
  assert.equal(shouldDestroyWindow(3), true);
  assert.equal(shouldDestroyWindow(4), true);
  assert.equal(shouldDestroyWindow(3, 5), false);
  assert.equal(shouldDestroyWindow(5, 5), true);
  assert.equal(shouldDestroyWindow(9, 0), true, '非法阈值退回默认 3');
  assert.equal(shouldDestroyWindow(0), false);
  assert.equal(shouldDestroyWindow(NaN), false);
});

test('窗口审计：可见窗口数 vs 允许会话数一致时 mismatch=false', () => {
  const audit = summarizeWindowAudit({
    windows: [
      { visible: true, allowed: true },
      { visible: false, allowed: false },
      { visible: false, allowed: true },
    ],
    allowedSessions: 1,
    stateVisibleSessions: 1,
  });
  assert.deepEqual(audit, {
    windowsTotal: 3,
    windowsVisible: 1,
    allowedSessions: 1,
    stateVisibleSessions: 1,
    orphanVisible: 0,
    mismatch: false,
  });
});

test('窗口审计：多出可见窗口/孤儿可见窗口都判 mismatch', () => {
  const extra = summarizeWindowAudit({
    windows: [
      { visible: true, allowed: true },
      { visible: true, allowed: true },
    ],
    allowedSessions: 1,
    stateVisibleSessions: 2,
  });
  assert.equal(extra.windowsVisible, 2);
  assert.equal(extra.allowedSessions, 1);
  assert.equal(extra.orphanVisible, 0);
  assert.equal(extra.mismatch, true, '可见窗口数多于允许会话数');

  const orphan = summarizeWindowAudit({
    windows: [
      { visible: true, allowed: true },
      { visible: true, allowed: false },
    ],
    allowedSessions: 2,
    stateVisibleSessions: 2,
  });
  assert.equal(orphan.windowsVisible, 2);
  assert.equal(orphan.orphanVisible, 1);
  assert.equal(orphan.mismatch, true, '有窗口不属于任何允许显示的会话');
});

test('窗口审计：空输入/脏输入安全返回 0，不把隐藏窗口算成泄漏', () => {
  const empty = summarizeWindowAudit();
  assert.deepEqual(empty, {
    windowsTotal: 0,
    windowsVisible: 0,
    allowedSessions: 0,
    stateVisibleSessions: 0,
    orphanVisible: 0,
    mismatch: false,
  });
  const hidden = summarizeWindowAudit({
    windows: [{ visible: false, allowed: false }, null, undefined],
    allowedSessions: 0,
    stateVisibleSessions: 3,
  });
  assert.equal(hidden.windowsTotal, 1);
  assert.equal(hidden.windowsVisible, 0);
  assert.equal(hidden.orphanVisible, 0);
  assert.equal(hidden.mismatch, false);
});
test('main.js 接线：attachTick 每轮清扫、boot 启动 1s 校验、/health 暴露窗口审计', () => {
  const source = fs.readFileSync(path.join(HERE, '..', 'overlay', 'main.js'), 'utf8');
  assert.match(source, /sweepOrphanWindows\('attachTick'\)/, 'attachTick 每轮要清孤儿窗口');
  assert.match(source, /startWindowGuard\(\)/, 'boot 要启动 1s 窗口校验定时器');
  assert.match(source, /windowAudit: windowAuditSnapshot\(\)/, '/health 要暴露 windowAudit');
  assert.match(source, /windowsVisible: safeWindowVisible\(s\.win\)/, '/sessions/health 要暴露实际窗口可见性');
  assert.match(source, /windowAllowed: isSessionWindowAllowed\(s\)/, '要暴露会话是否允许可见');
  assert.match(source, /if \(!allow\) \{[\s\S]{0,600}win\.hide\(\)/, 'showOverlay 门控失败必须真正 hide');
});
