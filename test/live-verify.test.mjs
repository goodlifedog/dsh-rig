'use strict';
// 解锁验收的编排层：分类必须把「环境跳过」和「真失败」分开，否则又会出现假绿/假红
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyLiveStep, summarizeLiveSteps, midRunStopReason } from '../core/live-verify.mjs';

test('分类：退 0 且无 ❌ → PASS', () => {
  assert.equal(classifyLiveStep({ code: 0, out: '全部通过' }).status, 'PASS');
});

test('分类：有环境跳过字样 → SKIP（不算失败）', () => {
  const v = classifyLiveStep({ code: 0, out: '环境跳过：屏幕已锁，稍后再跑' });
  assert.equal(v.status, 'SKIP');
  assert.match(v.detail, /环境跳过/);
});

test('分类：有 ❌ → FAIL，并带上出问题的行', () => {
  const v = classifyLiveStep({ code: 1, out: '  ✅ a\n  ❌ 后台点击失败\n' });
  assert.equal(v.status, 'FAIL');
  assert.match(v.detail, /后台点击失败/);
});

test('分类：超时 → FAIL；非 0 退出 → FAIL', () => {
  assert.equal(classifyLiveStep({ code: null, out: '', timedOut: true, limitMs: 5000 }).status, 'FAIL');
  const v = classifyLiveStep({ code: 2, out: 'something' });
  assert.equal(v.status, 'FAIL');
  assert.match(v.detail, /退出码 2/);
});

test('汇总：跳过不计失败，有失败才 ok=false', () => {
  const s = summarizeLiveSteps([
    { name: 'a', status: 'PASS' },
    { name: 'b', status: 'SKIP' },
  ]);
  assert.equal(s.total, 2);
  assert.equal(s.passed, 1);
  assert.equal(s.skipped, 1);
  assert.equal(s.failed, 0);
  assert.equal(s.ok, true);
  assert.match(s.text, /通过 1，环境跳过 1，失败 0/);

  const bad = summarizeLiveSteps([{ name: 'a', status: 'FAIL' }]);
  assert.equal(bad.ok, false);
  assert.equal(bad.failed, 1);
});

test('中途停止：锁屏优先，其次用户回来；都没有就继续', () => {
  assert.match(midRunStopReason({ locked: true, userActive: true }), /屏幕已锁/);
  assert.match(midRunStopReason({ locked: false, userActive: true }), /用户回到电脑前/);
  assert.equal(midRunStopReason({ locked: false, userActive: false }), '');
  assert.equal(midRunStopReason(), '');
});
test('分类：既有通过行又有环境跳过行 → PASS（不能整步误判成跳过）', () => {
  const out = [
    '  PASS  overlay 在线',
    '  PASS  任务 multi-app',
    '  SKIP  任务 form-fill  环境跳过（任务自报环境跳过）',
    '结果: 共 13 项，通过 10，环境跳过 3，失败 0',
  ].join('\n');
  const v = classifyLiveStep({ code: 0, out });
  assert.equal(v.status, 'PASS');
  assert.match(v.detail, /部分子项环境跳过/);
});

test('分类：出现「存在失败项」这种硬失败 → FAIL，不被环境跳过豁免', () => {
  const out = '  PASS  a\n  FAIL  b\n结果: 存在失败项';
  assert.equal(classifyLiveStep({ code: 0, out }).status, 'FAIL');
});

test('分类：只有通过行没有环境跳过 → PASS 且不带多余说明', () => {
  const v = classifyLiveStep({ code: 0, out: 'PASS 4 项\n全部通过' });
  assert.equal(v.status, 'PASS');
  assert.equal(v.detail, '');
});
