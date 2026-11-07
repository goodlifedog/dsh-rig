'use strict';
// 任务清单生成：从文件头注释取用途，写操作任务要标 ⚠️。
import test from 'node:test';
import assert from 'node:assert/strict';
import { taskDescription, buildTaskCatalog } from '../scripts/tasks-doc.mjs';

test('从文件头注释取第一行正文', () => {
  const src = '#!/usr/bin/env node\n/**\n * 应用能力矩阵：逐个应用探明后台能力。\n *\n * 更多说明\n */\nconsole.log(1);';
  assert.equal(taskDescription(src), '应用能力矩阵：逐个应用探明后台能力');
});

test('没有文件头注释时返回空串（清单里会标缺说明）', () => {
  assert.equal(taskDescription('console.log(1)'), '');
  assert.equal(taskDescription(''), '');
});

test('清单给写操作任务加 ⚠️，其余不加', () => {
  const md = buildTaskCatalog([
    ['background-control', '/**\n * 后台控制验收\n */'],
    ['app-matrix', '/**\n * 应用能力矩阵\n */'],
  ]);
  assert.match(md, /\| `background-control` \| ⚠️ 后台控制验收 \|/);
  assert.match(md, /\| `app-matrix` \| 应用能力矩阵 \|/);
});

test('缺说明的任务在清单里明确标出，不静默留空', () => {
  const md = buildTaskCatalog([['mystery', 'no header']]);
  assert.match(md, /文件头没写用途说明/);
});
