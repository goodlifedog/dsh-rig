'use strict';
import test from 'node:test';
import assert from 'node:assert/strict';
import { decideRetry, isTransient, NO_RETRY } from '../core/retry-policy.mjs';
import { ENV_RULES } from '../core/run-classify.mjs';

test('成功不需要重试', () => {
  assert.equal(decideRetry({ ok: true, text: '', attempt: 0, maxAttempts: 2 }).retry, false);
});

test('Chrome 启动超时属于临时失败，会重试且带退避', () => {
  const d = decideRetry({ ok: false, code: 1, text: 'FAIL: 等待 Chrome 调试端口超时：xxx', attempt: 0, maxAttempts: 2 });
  assert.equal(d.retry, true);
  assert.equal(d.delayMs, 3000);
  const d2 = decideRetry({ ok: false, code: 1, text: 'FAIL: 等待 Chrome 调试端口超时', attempt: 1, maxAttempts: 2 });
  assert.equal(d2.delayMs, 6000);
});

test('重试次数用完就不再试', () => {
  const d = decideRetry({ ok: false, code: 1, text: '等待 Chrome 调试端口超时', attempt: 2, maxAttempts: 2 });
  assert.equal(d.retry, false);
  assert.equal(d.reason, '已用完重试次数');
});

test('环境类和用户行为类绝不重试', () => {
  const cases = [
    'FAIL: 目标应用当前就是前台，为避免干扰用户',
    'FAIL: 没有 BOSS 职位页标签',
    'FAIL: 锁屏中，跳过前台与窗口数校验',
    'FAIL: 读不到 Google Chrome 的界面树',
  ];
  for (const text of cases) {
    const d = decideRetry({ ok: false, code: 1, text, attempt: 0, maxAttempts: 3 });
    assert.equal(d.retry, false, text);
    assert.equal(isTransient(text), false, text);
  }
});

test('普通断言失败不重试（免得把真 bug 反复跑）', () => {
  const d = decideRetry({ ok: false, code: 1, text: 'FAIL: 断言不成立：页面标题不对', attempt: 0, maxAttempts: 3 });
  assert.equal(d.retry, false);
  assert.equal(d.reason, '不是临时性失败');
});

test('重试规则与失败分类共用同一份环境规则（防两边分叉）', () => {
  const sources = new Set(NO_RETRY.map((re) => re.source));
  for (const [re] of ENV_RULES) {
    assert.ok(sources.has(re.source), '环境规则没同步到重试策略：' + re.source);
  }
  // 反向：分类器已经删掉的规则（页面结构变化）不应该还留在不重试列表里
  assert.ok(!NO_RETRY.some((re) => /改成了指定关键词/.test(re.source)), '旧规则不该复活');
});

test('被超时杀掉值得再给一次机会', () => {
  const d = decideRetry({ ok: false, code: null, text: '', attempt: 0, maxAttempts: 1 });
  assert.equal(d.retry, true);
  assert.equal(d.reason, '被超时终止');
});
