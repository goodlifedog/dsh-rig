'use strict';
// 应用预设：分门类批量探测用，条目写错会在单测里暴露
import test from 'node:test';
import assert from 'node:assert/strict';
import { PRESETS, presetNames, presetApps } from '../core/app-presets.mjs';

test('预设门类齐全', () => {
  assert.deepEqual(presetNames(), ['dev', 'im', 'media', 'office', 'system', 'tools']);
});

test('每个条目都有 name / bundle / process', () => {
  for (const [preset, list] of Object.entries(PRESETS)) {
    assert.ok(list.length > 0, preset + ' 不能是空的');
    for (const app of list) {
      assert.ok(app.name && typeof app.name === 'string', preset + ' 有条目缺 name');
      assert.ok(/^[a-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(app.bundle), preset + ' 的 ' + app.name + ' bundle 不像反向域名：' + app.bundle);
      assert.ok(app.process && typeof app.process === 'string', preset + ' 的 ' + app.name + ' 缺 process');
    }
  }
});

test('同一个应用不会在两个门类里重复出现', () => {
  const seen = new Map();
  for (const [preset, list] of Object.entries(PRESETS)) {
    for (const app of list) {
      assert.ok(!seen.has(app.bundle), app.bundle + ' 同时出现在 ' + seen.get(app.bundle) + ' 和 ' + preset);
      seen.set(app.bundle, preset);
    }
  }
});

test('presetApps 返回副本，改了不影响预设', () => {
  const list = presetApps('im');
  list[0].name = '被改了';
  assert.notEqual(presetApps('im')[0].name, '被改了');
});

test('未知预设：报错并列出可用名字', () => {
  assert.throws(() => presetApps('nope'), (e) => {
    assert.equal(e.code, 'UNKNOWN_PRESET');
    for (const name of presetNames()) assert.ok(e.message.includes(name));
    return true;
  });
});
