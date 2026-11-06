'use strict';
import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreJob } from '../core/lib/score.mjs';

const C = { salaryMin: 5, salaryMax: 12 };

test('应届 + 薪资合适 + 方向匹配 = 高分', () => {
  const r = scoreJob({ title: 'Java开发工程师 8-10K 本科 在校/应届' }, C);
  assert.ok(r.score >= 70, '实际 ' + r.score);
});

test('要求硕士被压分', () => {
  const r = scoreJob({ title: '算法工程师 30-50K 硕士' }, C);
  assert.ok(r.score < 0, '实际 ' + r.score);
});

test('要求 3-5 年被压分', () => {
  const r = scoreJob({ title: 'Java 15-20K 3-5年' }, C);
  assert.ok(r.score < 20, '实际 ' + r.score);
});

test('薪资超过上限要扣分', () => {
  const low = scoreJob({ title: 'Java 8-10K' }, C).score;
  const high = scoreJob({ title: 'Java 25-35K' }, C).score;
  assert.ok(high < low, 'high=' + high + ' low=' + low);
});

test('外包公司扣分', () => {
  const a = scoreJob({ title: 'Java 8-10K 本科' }, C).score;
  const b = scoreJob({ title: 'Java 8-10K 本科 外包' }, C).score;
  assert.equal(a - b, 15);
});
  