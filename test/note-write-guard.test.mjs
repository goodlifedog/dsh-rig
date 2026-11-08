'use strict';
// 备忘录写入判定：新建没成功时绝不能写（set_value 是覆盖语义，会盖掉用户正在编辑的笔记）
import test from 'node:test';
import assert from 'node:assert/strict';
import { decideNoteWrite } from '../core/note-write-guard.mjs';

test('新建成功 + 前台没变 + 有文本区 → 允许写', () => {
  assert.equal(decideNoteWrite({ newNoteOk: true, frontUnchanged: true, hasArea: true }).ok, true);
});

test('新建没成功 → 不写（防止覆盖用户当前笔记）', () => {
  const r = decideNoteWrite({ newNoteOk: false, hasArea: true });
  assert.equal(r.ok, false);
  assert.match(r.reason, /新建备忘录没成功/);
});

test('新建时前台被抢 → 不写（可能写错窗口）', () => {
  const r = decideNoteWrite({ newNoteOk: true, frontUnchanged: false, hasArea: true });
  assert.equal(r.ok, false);
  assert.match(r.reason, /前台被抢/);
});

test('没有可写文本区 → 不写（环境状态，不是能力失败）', () => {
  const r = decideNoteWrite({ newNoteOk: true, hasArea: false });
  assert.equal(r.ok, false);
  assert.match(r.reason, /没有可写文本区/);
});

test('缺省参数按不安全处理', () => {
  assert.equal(decideNoteWrite().ok, false);
  assert.equal(decideNoteWrite(null).ok, false);
});
