import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyDialog, classifyDialogWithButtons, hasGrantButton, pickSafeButton } from '../core/dialog-guard.mjs';

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

test('非中英文系统的权限弹窗也不能被当成普通弹窗点掉', () => {
  // 德语：无障碍权限，文案含 Bedienungshilfen，按钮叫 OK/Systemeinstellungen öffnen
  const de = classifyDialogWithButtons('App möchte Ihren Computer steuern. Bedienungshilfen OK', ['OK', 'Systemeinstellungen öffnen']);
  assert.equal(de.kind, 'permission');
  // 法语：Accessibilité
  assert.equal(classifyDialog('Autoriser la commande ? Accessibilité').kind, 'permission');
  // 日语：アクセシビリティ
  assert.equal(classifyDialog('このコンピュータの制御を許可しますか？ アクセシビリティ').kind, 'permission');
});

test('文案不认识、但按钮是授权类 → 也不点（结构判定，不依赖语言）', () => {
  assert.equal(hasGrantButton(['OK', '取得']), true);
  assert.equal(hasGrantButton(['許可']), true);
  assert.equal(hasGrantButton(['Erlauben']), true);
  assert.equal(hasGrantButton(['关闭']), false);
  assert.equal(classifyDialogWithButtons('某段看不懂的提示', ['Erlauben', 'Später']).kind, 'permission');
  assert.equal(classifyDialogWithButtons('某段看不懂的提示', ['关闭', '稍后']).kind, 'unknown');
  assert.equal(classifyDialogWithButtons('某段看不懂的提示', ['关闭'], 'SecurityAgent').kind, 'permission', '系统进程弹窗一律不点');
});

test('陌生弹窗默认不动（宁可少点一个提示，也不代点授权）', () => {
  const v = classifyDialog('Some application wants something');
  assert.equal(v.kind, 'unknown');
  assert.equal(v.autoClick, false);
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
