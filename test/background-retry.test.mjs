'use strict';
// 瞬时错误重试与"按文字点击"：索引过期是实机常见问题
import test from 'node:test';
import assert from 'node:assert/strict';
import { withRetry, clickByText, isTransientAxError } from '../core/background.mjs';

test('瞬时错误会重试，第二次成功', async () => {
  let calls = 0;
  const r = await withRetry(async () => {
    calls += 1;
    return calls === 1 ? { ok: false, reason: 'Query index has expired' } : { ok: true, value: 42 };
  }, { retries: 1, delayMs: 10 });
  assert.equal(r.ok, true);
  assert.equal(calls, 2);
});

test('非瞬时错误不重试（找不到就是找不到，别浪费时间）', async () => {
  let calls = 0;
  const r = await withRetry(async () => {
    calls += 1;
    return { ok: false, reason: '元素不存在' };
  }, { retries: 3, delayMs: 10 });
  assert.equal(r.ok, false);
  assert.equal(calls, 1);
});

test('抛出的瞬时异常也会重试', async () => {
  let calls = 0;
  const r = await withRetry(async () => {
    calls += 1;
    if (calls === 1) throw new Error('AX timeout');
    return { ok: true };
  }, { retries: 1, delayMs: 10 });
  assert.equal(r.ok, true);
  assert.equal(calls, 2);
});

test('重试次数用完返回最后一次失败', async () => {
  let calls = 0;
  const r = await withRetry(async () => {
    calls += 1;
    return { ok: false, reason: 'timeout' };
  }, { retries: 2, delayMs: 5 });
  assert.equal(r.ok, false);
  assert.equal(calls, 3, '首次 + 2 次重试');
});

test('瞬时错误判定覆盖常见文案', () => {
  for (const msg of ['Query index 123 has expired', 'no longer available', '元素索引失效', 'AX timeout', '请求超时']) {
    assert.equal(isTransientAxError(msg), true, msg);
  }
  for (const msg of ['找不到元素', '权限不足', '应用未运行']) {
    assert.equal(isTransientAxError(msg), false, msg);
  }
});

test('按文字点击：第一次索引过期，重新查后点成功', async () => {
  let findCalls = 0;
  let clickCalls = 0;
  const r = await clickByText('计算器', '7', {
    deps: {
      find: async () => { findCalls += 1; return [{ index: 100 + findCalls, title: '7' }]; },
      click: async () => {
        clickCalls += 1;
        return clickCalls === 1 ? { ok: false, error: 'Query index has expired' } : { ok: true, frontUnchanged: true };
      },
    },
  });
  assert.equal(r.ok, true);
  assert.equal(r.attempts, 2);
  assert.equal(findCalls, 2, '索引过期后应重新查询');
});

test('按文字点击：完全匹配优先于包含匹配', async () => {
  const clicked = [];
  const r = await clickByText('备忘录', '保存', {
    deps: {
      find: async () => [{ index: 1, title: '保存并退出' }, { index: 2, title: '保存' }],
      click: async (app, idx) => { clicked.push(idx); return { ok: true, frontUnchanged: true }; },
    },
  });
  assert.equal(r.ok, true);
  assert.equal(clicked[0], 2);
});

test('按文字点击：找不到时如实返回，不乱点', async () => {
  let clicked = 0;
  const r = await clickByText('访达', '不存在的按钮', {
    deps: { find: async () => [], click: async () => { clicked += 1; return { ok: true }; } },
  });
  assert.equal(r.ok, false);
  assert.ok(/没找到/.test(r.reason));
  assert.equal(clicked, 0);
});

test('按文字点击：非瞬时失败不重试', async () => {
  let clickCalls = 0;
  const r = await clickByText('某应用', '按钮', {
    deps: {
      find: async () => [{ index: 5, title: '按钮' }],
      click: async () => { clickCalls += 1; return { ok: false, error: '权限不足' }; },
    },
  });
  assert.equal(r.ok, false);
  assert.equal(clickCalls, 1);
});
