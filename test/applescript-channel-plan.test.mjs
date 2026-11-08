'use strict';
// H3：Safari/AppleScript 通道的纯判定 + 任务侧回归（全程不碰应用、不发 AppleEvent）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applescriptChannelPlan, AUTOMATION_SETTINGS_HINT } from '../core/applescript-driver.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

test('plan：未运行 → skip（环境跳过，不启动 Safari）', () => {
  const plan = applescriptChannelPlan({ running: false, permission: 'granted', needJs: true });
  assert.equal(plan.action, 'skip');
  assert.equal(plan.reason, 'not-running');
  assert.match(plan.message, /环境跳过/);
  assert.match(plan.message, /没在运行/);
  assert.match(plan.message, /不为了测试去启动/);
});

test('plan：在运行但未授权 → skip（提示去自动化设置，不弹框）', () => {
  for (const permission of ['needs-consent', 'denied', 'unknown', 'app-not-running', '']) {
    const plan = applescriptChannelPlan({ running: true, permission, needJs: true });
    assert.equal(plan.action, 'skip', permission + ' 应跳过');
    assert.equal(plan.reason, 'not-authorized');
    assert.match(plan.message, /授权/);
    assert.ok(plan.message.includes(AUTOMATION_SETTINGS_HINT), '要告诉用户去哪里授权');
  }
});

test('plan：在运行且已授权 → run；needJs 只影响文案', () => {
  const jsOn = applescriptChannelPlan({ running: true, permission: 'granted', needJs: true });
  assert.equal(jsOn.action, 'run');
  assert.equal(jsOn.reason, '');
  assert.match(jsOn.message, /JS/);
  assert.match(jsOn.message, /前置条件满足/);

  const jsOff = applescriptChannelPlan({ running: true, permission: 'granted', needJs: false });
  assert.equal(jsOff.action, 'run');
  assert.equal(jsOff.reason, '');
  assert.ok(!/Safari 页面 JS 通道/.test(jsOff.message));
});

test('plan：六种代表组合一览（running × permission）', () => {
  const cases = [
    { running: false, permission: 'needs-consent', action: 'skip', reason: 'not-running' },
    { running: false, permission: 'granted', action: 'skip', reason: 'not-running' },
    { running: true, permission: 'needs-consent', action: 'skip', reason: 'not-authorized' },
    { running: true, permission: 'denied', action: 'skip', reason: 'not-authorized' },
    { running: true, permission: 'unknown', action: 'skip', reason: 'not-authorized' },
    { running: true, permission: 'granted', action: 'run', reason: '' },
  ];
  for (const item of cases) {
    const plan = applescriptChannelPlan(item);
    assert.equal(plan.action, item.action, JSON.stringify(item));
    assert.equal(plan.reason, item.reason, JSON.stringify(item));
  }
});

test('plan：running 只认 true，缺省/异常值按未运行处理', () => {
  for (const running of [undefined, null, false, 0, 'true']) {
    const plan = applescriptChannelPlan({ running, permission: 'granted' });
    assert.equal(plan.action, 'skip');
    assert.equal(plan.reason, 'not-running');
  }
  assert.equal(applescriptChannelPlan({}).action, 'skip');
  assert.equal(applescriptChannelPlan(null).action, 'skip');
});

test('任务侧回归：applescript-channel 必须先走 plan 再决定是否探测 Safari JS（H3）', () => {
  const file = path.join(HERE, '..', 'core', 'tasks', 'applescript-channel.mjs');
  const src = fs.readFileSync(file, 'utf8');
  assert.match(src, /applescriptChannelPlan/, '任务必须使用统一的 plan');
  const planAt = src.indexOf('applescriptChannelPlan({');
  const callAt = src.indexOf('checkSafariJavaScript(');
  assert.ok(planAt >= 0, '没找到 plan 调用');
  assert.ok(callAt > planAt, '必须先按 plan 判断，再调用 checkSafariJavaScript');
  assert.doesNotMatch(src, /checkSafariJavaScript\(\)\s*\.catch/, '不允许无条件调用 Safari JS 探针');
  assert.match(src, /if \(safariPlan\.action === 'skip'\)/, 'skip 分支必须存在（环境跳过）');
});
