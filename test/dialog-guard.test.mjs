import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyDialog, pickSafeButton } from '../core/dialog-guard.mjs';

test('权限类弹窗不自动点，交给人处理', () => {
  const v = classifyDialog('“Desktop Agent”想要控制您的电脑 辅助功能');
  assert.equal(v.kind, 'permission');
  assert.equal(v.autoClick, false);
});

test('普通错误弹窗可以自动点掉', () => {
  const v = classifyDialog('应用意外退出 是否发送报告');
  assert.equal(v.kind, 'benign');
  assert.equal(v.autoClick, true);
});

test('只点安全按钮，不碰危险项', () => {
  assert.equal(pickSafeButton(['好', '发送报告']), '好');
  assert.equal(pickSafeButton(['允许', '拒绝']), '');
  assert.equal(pickSafeButton([]), '');
});
test('默认只处理自家进程，不去点用户的 Chrome', async () => {
  const mod = await import('../core/dialog-guard.mjs');
  assert.deepEqual(mod.DEFAULT_TARGETS, ['Electron', 'Desktop Agent']);
  assert.ok(!mod.DEFAULT_TARGETS.includes('Google Chrome'));
});

test('权限文案覆盖「想要控制」「想要录制」这类系统弹窗', () => {
  assert.equal(classifyDialog('“X”想要控制您的电脑').kind, 'permission');
  assert.equal(classifyDialog('“X”想要录制屏幕内容').kind, 'permission');
});

test('点按钮前做安全校验：危险名字不执行', async () => {
  const mod = await import('../core/dialog-guard.mjs');
  assert.equal(await mod.clickDialogButton('App"x', 1, '好'), false);
  assert.equal(await mod.clickDialogButton('App', 1, '好"); rm -rf ~'), false);
});

test('dry-run 不真的点，只报告', async () => {
  const mod = await import('../core/dialog-guard.mjs');
  const rows = await mod.scanOnce({ targets: [], dryRun: true });
  assert.ok(Array.isArray(rows));
  assert.ok(rows.every((r) => r.clicked === false));
});
