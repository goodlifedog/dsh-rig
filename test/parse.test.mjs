'use strict';
// ocu 界面树解析：BOSS 岗位列表与节点计数
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseJobs, countElements } from '../core/agentd.mjs';

test('从界面树里解析岗位链接', () => {
  const text = [
    '  link [前端工程师（远程）](https://www.zhipin.com/job_detail/abc123.html?lid=x)',
    '  link [投递](https://www.zhipin.com/job_detail/abc123.html?lid=x)',
    '  link [后端工程师](https://www.zhipin.com/job_detail/def456.html)',
  ].join('\n');
  const jobs = parseJobs(text);
  assert.equal(jobs.length, 2, '同一链接只保留一条');
  assert.equal(jobs[0].title, '前端工程师（远程）');
  assert.ok(jobs[0].url.startsWith('https://www.zhipin.com/job_detail/abc123.html'));
  assert.equal(jobs[1].title, '后端工程师');
});

test('没有岗位链接时返回空数组', () => {
  assert.deepEqual(parseJobs('只是一些文本\nbutton [确定]'), []);
  assert.deepEqual(parseJobs(''), []);
});

test('节点计数只认行首编号', () => {
  const text = [
    '1 window 计算器',
    '  2 button AC',
    '    3 text 56',
    '这里是说明文字，不带编号',
    '  4 checkbox 已读',
  ].join('\n');
  assert.equal(countElements(text), 4);
});

test('空文本节点数为 0', () => {
  assert.equal(countElements(''), 0);
  assert.equal(countElements(null), 0);
});
