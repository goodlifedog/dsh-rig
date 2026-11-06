'use strict';
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSalary } from '../core/lib/salary.mjs';

test('解析月薪区间', () => {
  assert.deepEqual(parseSalary('Java 8-10K 本科'), { min: 8, max: 10, unit: 'K/月' });
  assert.deepEqual(parseSalary('15-20K·14薪 本科'), { min: 15, max: 20, unit: 'K/月' });
});

test('解析单值与日薪', () => {
  assert.deepEqual(parseSalary('12K 本科'), { min: 12, max: 12, unit: 'K/月' });
  const day = parseSalary('180-200元/天 4个月 本科');
  assert.equal(day.min, 4);
  assert.equal(day.max, 4);
});

test('没有薪资时返回 null', () => {
  assert.equal(parseSalary('Java开发工程师 本科'), null);
  assert.equal(parseSalary(''), null);
});
