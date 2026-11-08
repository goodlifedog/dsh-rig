'use strict';
// ocu 界面树解析：节点计数（行首编号）
import test from 'node:test';
import assert from 'node:assert/strict';
import { countElements } from '../core/agentd.mjs';

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
