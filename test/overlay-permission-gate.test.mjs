'use strict';
// M1/M2 回归：抓图前的屏幕录制静默预检 + CGWindowList 标题全空的权限提示。
// 只测纯函数（decideCapturePermission / classifyWindowTitles），不执行 screencapture、不弹任何授权框。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const platform = require('../overlay/platform.js');
const { decideCapturePermission, classifyWindowTitles } = platform;

// ---------- M1：权限判定 ----------

test('M1 已授权 → 放行抓图，状态 granted', () => {
  const r = decideCapturePermission({ granted: true });
  assert.equal(r.status, 'granted');
  assert.equal(r.granted, true);
  assert.equal(r.proceed, true);
  assert.equal(r.message, '');
});

test('M1 未授权 → permission-missing，不抓图，文案是「缺少屏幕录制权限」', () => {
  const r = decideCapturePermission({ granted: false });
  assert.equal(r.status, 'permission-missing');
  assert.equal(r.granted, false);
  assert.equal(r.proceed, false);
  assert.equal(r.message, '缺少屏幕录制权限');
});

test('M1 拿不到结论（null/undefined/非布尔）→ unknown 但放行，不卡死抓帧', () => {
  for (const granted of [null, undefined, 'yes', 1]) {
    const r = decideCapturePermission({ granted });
    assert.equal(r.status, 'unknown', 'granted=' + JSON.stringify(granted));
    assert.equal(r.granted, null);
    assert.equal(r.proceed, true);
  }
});

test('M1 非 macOS → not-needed，直接放行（Windows 抓图不需要该权限）', () => {
  const r = decideCapturePermission({ granted: false, platform: 'win32' });
  assert.equal(r.status, 'not-needed');
  assert.equal(r.proceed, true);
});

// ---------- M2：窗口标题空值率 → 权限提示 ----------

test('M2 标题全空 → all-empty + suspectPermission，提示可能缺屏幕录制权限', () => {
  const r = classifyWindowTitles({ titles: ['', '   ', null, undefined] });
  assert.equal(r.status, 'all-empty');
  assert.equal(r.total, 4);
  assert.equal(r.empty, 4);
  assert.equal(r.emptyRatio, 1);
  assert.equal(r.allEmpty, true);
  assert.equal(r.suspectPermission, true);
  assert.match(r.message, /窗口标题全部为空/);
  assert.match(r.message, /可能缺少屏幕录制权限/);
});

test('M2 一半标题为空（默认阈值 0.5）→ mostly-empty + suspectPermission', () => {
  const r = classifyWindowTitles({ titles: ['Chrome', '', 'Notes', ''] });
  assert.equal(r.status, 'mostly-empty');
  assert.equal(r.empty, 2);
  assert.equal(r.emptyRatio, 0.5);
  assert.equal(r.suspectPermission, true);
  assert.match(r.message, /2\/4 个窗口标题为空/);
  assert.match(r.message, /可能缺少屏幕录制权限/);
});

test('M2 标题都正常 → normal，不报权限', () => {
  const r = classifyWindowTitles({ titles: ['Chrome', 'Notes', '计算器'] });
  assert.equal(r.status, 'normal');
  assert.equal(r.empty, 0);
  assert.equal(r.emptyRatio, 0);
  assert.equal(r.suspectPermission, false);
  assert.equal(r.message, '');
});

test('M2 少量标题为空（低于阈值）→ partial-empty，但不误报权限', () => {
  const titles = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', ''];
  const r = classifyWindowTitles({ titles });
  assert.equal(r.status, 'partial-empty');
  assert.equal(r.empty, 1);
  assert.equal(r.emptyRatio, 0.1);
  assert.equal(r.suspectPermission, false);
  assert.equal(r.message, '');
});

test('M2 limitRatio 可调：0.6 阈值下一半为空不算 mostly-empty', () => {
  const r = classifyWindowTitles({ titles: ['A', '', 'B', ''], limitRatio: 0.6 });
  assert.equal(r.status, 'partial-empty');
  assert.equal(r.suspectPermission, false);
});

test('M2 没有窗口 → no-windows，不报权限', () => {
  const r = classifyWindowTitles({ titles: [] });
  assert.equal(r.status, 'no-windows');
  assert.equal(r.total, 0);
  assert.equal(r.suspectPermission, false);
  assert.equal(r.message, '');
});

test('M2 空值/非法 titles 不抛异常', () => {
  for (const titles of [undefined, null, 'not-array', 123]) {
    const r = classifyWindowTitles({ titles });
    assert.equal(r.status, 'no-windows');
    assert.equal(r.suspectPermission, false);
  }
});
