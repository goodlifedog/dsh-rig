'use strict';
// 应用能力缓存：成功方式优先、失败方式降级，纯函数可测
import test from 'node:test';
import assert from 'node:assert/strict';
import { methodOrder, recordMethod, loadCache, saveCache } from '../core/capabilities.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('没记录过的应用返回 null（调用方用默认顺序）', () => {
  assert.equal(methodOrder({}, '新应用', 'type'), null);
  assert.equal(methodOrder({ '某应用': {} }, '某应用', 'type'), null);
});

test('记录成功：该方法提到最前', () => {
  let cache = {};
  cache = recordMethod(cache, '备忘录', 'type', 'set_value', true);
  assert.deepEqual(methodOrder(cache, '备忘录', 'type'), ['set_value', 'type_text']);
  cache = recordMethod(cache, '备忘录', 'type', 'type_text', true);
  assert.deepEqual(methodOrder(cache, '备忘录', 'type'), ['type_text', 'set_value'], '最近成功的排前面');
});

test('记录失败：该方法挪到最后', () => {
  let cache = {};
  cache = recordMethod(cache, '文本编辑', 'type', 'type_text', false);
  assert.deepEqual(methodOrder(cache, '文本编辑', 'type'), ['set_value', 'type_text'], '失败的排后面');
  cache = recordMethod(cache, '文本编辑', 'type', 'set_value', false);
  assert.deepEqual(methodOrder(cache, '文本编辑', 'type'), ['type_text', 'set_value']);
});

test('重复记录不产生重复项', () => {
  let cache = {};
  cache = recordMethod(cache, '应用A', 'type', 'set_value', true);
  cache = recordMethod(cache, '应用A', 'type', 'set_value', true);
  assert.deepEqual(methodOrder(cache, '应用A', 'type'), ['set_value', 'type_text']);
});

test('点击意图与输入意图分开记', () => {
  let cache = {};
  cache = recordMethod(cache, '计算器', 'click', 'click', true);
  assert.deepEqual(methodOrder(cache, '计算器', 'click'), ['click']);
  assert.equal(methodOrder(cache, '计算器', 'type'), null);
});

test('读写缓存文件：不存在时返回空对象', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-test-'));
  const file = path.join(dir, 'sub', 'capabilities.json');
  assert.deepEqual(loadCache(file), {});
  let cache = recordMethod({}, '备忘录', 'type', 'set_value', true);
  assert.equal(saveCache(file, cache), true);
  const back = loadCache(file);
  assert.deepEqual(methodOrder(back, '备忘录', 'type'), ['set_value', 'type_text']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('缓存文件损坏时不崩，按空缓存处理', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-bad-'));
  const file = path.join(dir, 'capabilities.json');
  fs.writeFileSync(file, '{不是 JSON');
  assert.deepEqual(loadCache(file), {});
  fs.rmSync(dir, { recursive: true, force: true });
});
