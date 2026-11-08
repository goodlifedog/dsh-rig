'use strict';
// ocu doctor 权限字段的校验（M2 fail-closed）：纯函数，不跑真实 ocu、不探真实权限
import test from 'node:test';
import assert from 'node:assert/strict';
import { judgeDoctorReport, OCU_DOCTOR_TIMEOUT_MS } from '../core/permissions.mjs';

test('正常 JSON：两个权限都授权 → ok=true，没有缺项', () => {
  const r = judgeDoctorReport({ accessibilityTrusted: true, screenCaptureGranted: true, allGranted: true }, 'darwin');
  assert.equal(r.ok, true);
  assert.deepEqual(r.missing, []);
  assert.equal(r.platform, 'darwin');
});

test('任一权限为 false → ok=false 并报出具体缺项', () => {
  const r = judgeDoctorReport({ accessibilityTrusted: false, screenCaptureGranted: true, allGranted: false });
  assert.equal(r.ok, false);
  assert.deepEqual(r.missing, ['accessibility']);
  const r2 = judgeDoctorReport({ accessibilityTrusted: true, screenCaptureGranted: false, allGranted: false });
  assert.deepEqual(r2.missing, ['screenCapture']);
  const both = judgeDoctorReport({ accessibilityTrusted: false, screenCaptureGranted: false, allGranted: false });
  assert.deepEqual(both.missing, ['accessibility', 'screenCapture']);
});

test('字段缺失时现在会怎样：只给 allGranted → unknown，绝不当作已授权', () => {
  const r = judgeDoctorReport({ allGranted: true });
  assert.equal(r.ok, false, '只有汇总字段不能证明已授权');
  assert.deepEqual(r.missing, ['unknown']);
  assert.ok(r.note && r.note.includes('不可信'));
});

test('字段缺失时现在会怎样：只剩一个具体字段 → 另一项 unknown', () => {
  const r = judgeDoctorReport({ accessibilityTrusted: true });
  assert.equal(r.ok, false);
  assert.deepEqual(r.missing, ['unknown']);
});

test('单 key 缺失而另一个为 false → 具体缺项 + unknown（两项都报）', () => {
  const r = judgeDoctorReport({ accessibilityTrusted: false });
  assert.equal(r.ok, false);
  assert.deepEqual(r.missing, ['accessibility', 'unknown']);
});

test('字段非布尔 → 一律按 unknown（字符串 "true"/1/"yes" 都不算授权）', () => {
  for (const report of [
    { accessibilityTrusted: 'true', screenCaptureGranted: 'true', allGranted: 'yes' },
    { accessibilityTrusted: 1, screenCaptureGranted: 1, allGranted: 1 },
    { accessibilityTrusted: null, screenCaptureGranted: null, allGranted: null },
  ]) {
    const r = judgeDoctorReport(report);
    assert.equal(r.ok, false, JSON.stringify(report));
    assert.deepEqual(r.missing, ['unknown'], JSON.stringify(report));
  }
  // 具体字段可信但汇总字段不是 boolean：汇总字段不可信，同样按未知
  const mixed = judgeDoctorReport({ accessibilityTrusted: true, screenCaptureGranted: true, allGranted: 'true' });
  assert.equal(mixed.ok, false);
  assert.deepEqual(mixed.missing, ['unknown']);
});

test('allGranted=false 却又指不出具体缺项 → unknown（不猜是哪项）', () => {
  const r = judgeDoctorReport({ accessibilityTrusted: true, screenCaptureGranted: true, allGranted: false });
  assert.equal(r.ok, false);
  assert.deepEqual(r.missing, ['unknown']);
});

test('空输出 / doctor 非 0 / 结构不对 → unknown + error，不当已授权', () => {
  for (const bad of [null, undefined, '', 0, 'null', 'FAIL: ocu doctor exited 1', [], 42]) {
    const r = judgeDoctorReport(bad);
    assert.equal(r.ok, false, String(bad));
    assert.deepEqual(r.missing, ['unknown'], String(bad));
    assert.ok(r.error && r.error.includes('读不到权限状态'), String(bad));
  }
});

test('空对象（字段全缺）→ unknown，ok=false', () => {
  const r = judgeDoctorReport({});
  assert.equal(r.ok, false);
  assert.deepEqual(r.missing, ['unknown']);
});

test('allGranted 缺失但两个具体字段可信 → 以具体字段为准', () => {
  // 老版本 ocu 可能不输出汇总字段；具体字段才是事实来源
  const r = judgeDoctorReport({ accessibilityTrusted: true, screenCaptureGranted: true });
  assert.equal(r.ok, true);
  assert.deepEqual(r.missing, []);
});

test('返回结构兼容：ok/missing/platform 始终存在，unknown 只出现一次', () => {
  const r = judgeDoctorReport({ allGranted: false });
  assert.equal(typeof r.ok, 'boolean');
  assert.ok(Array.isArray(r.missing));
  assert.equal(typeof r.platform, 'string');
  assert.equal(r.missing.filter((m) => m === 'unknown').length, 1);
});

test('doctor 超时收敛到 5000ms（可注入，不再是 15000）', () => {
  assert.equal(OCU_DOCTOR_TIMEOUT_MS, 5000);
  assert.ok(OCU_DOCTOR_TIMEOUT_MS < 15000);
});
