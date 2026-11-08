'use strict';
// 应用预设：分门类批量探测用，条目写错会在单测里暴露
import test from 'node:test';
import assert from 'node:assert/strict';
import { PRESETS, presetNames, presetApps } from '../core/app-presets.mjs';

// 允许带空格的 process（系统应用的可执行名本身就带空格，pgrep -x 能匹配，属"必要"例外）
const PROCESS_ALLOW_SPACE = new Set(['System Settings']);

test('预设门类齐全', () => {
  assert.deepEqual(presetNames(), [
    'calendar',
    'dev',
    'im',
    'mail',
    'media',
    'office',
    'photos',
    'reading',
    'system',
    'tools',
  ]);
});

test('新增门类：mail / calendar / reading / photos 及 media 里的 Music', () => {
  // bundle/process 来自各应用 Info.plist（CFBundleIdentifier / CFBundleExecutable），不是猜的；
  // name 用**本地化显示名**——CGWindowList 的 owner 是「邮件/日历/预览…」，用英文名匹配不到窗口
  // （实测同一台机器上「备忘录/文本编辑」的 owner 也是中文）。
  const expected = {
    mail: [{ name: '邮件', bundle: 'com.apple.mail', process: 'Mail' }],
    calendar: [
      { name: '日历', bundle: 'com.apple.iCal', process: 'Calendar' },
      { name: '提醒事项', bundle: 'com.apple.reminders', process: 'Reminders' },
    ],
    reading: [{ name: '预览', bundle: 'com.apple.Preview', process: 'Preview' }],
    photos: [{ name: '照片', bundle: 'com.apple.Photos', process: 'Photos' }],
  };
  for (const [preset, apps] of Object.entries(expected)) {
    assert.ok(PRESETS[preset], preset + ' 门类不存在');
    assert.deepEqual(presetApps(preset), apps, preset + ' 门类内容不对');
  }
  // Music 并入 media，原有两个创作类应用不挪走
  assert.deepEqual(presetApps('media'), [
    { name: 'iMovie', bundle: 'com.apple.iMovieApp', process: 'iMovie' },
    { name: 'GarageBand', bundle: 'com.apple.garageband10', process: 'GarageBand' },
    { name: '音乐', bundle: 'com.apple.Music', process: 'Music' },
  ]);
});

test('新增门类的 bundle 都是 com.apple.* 系统应用', () => {
  for (const preset of ['mail', 'calendar', 'reading', 'photos']) {
    for (const app of PRESETS[preset]) {
      assert.ok(app.bundle.startsWith('com.apple.'), preset + ' 的 ' + app.name + ' 不是系统应用：' + app.bundle);
    }
  }
});

test('每个条目都有 name / bundle / process', () => {
  for (const [preset, list] of Object.entries(PRESETS)) {
    assert.ok(list.length > 0, preset + ' 不能是空的');
    for (const app of list) {
      assert.ok(app.name && typeof app.name === 'string', preset + ' 有条目缺 name');
      assert.ok(/^[a-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(app.bundle), preset + ' 的 ' + app.name + ' bundle 不像反向域名：' + app.bundle);
      assert.ok(app.process && typeof app.process === 'string', preset + ' 的 ' + app.name + ' 缺 process');
      // process 是 pgrep -x 的匹配串，通常不应带空格（「系统设置」这类系统应用的可执行名确实有空格）
      if (!PROCESS_ALLOW_SPACE.has(app.process)) {
        assert.ok(/^[A-Za-z0-9._+-]+$/.test(app.process), preset + ' 的 ' + app.name + ' process 含空格或非法字符：' + app.process);
      }
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
