'use strict';
// 探测计划解析 + 按名字找应用：以后加应用不用手写 JSON
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseProbeArgs, probeEnv, resolveProbeNames } from '../core/app-probe-plan.mjs';
import { matchAppByNames, scanDirs } from '../core/app-scan.mjs';

test('默认参数：跑默认列表并刷新清点', () => {
  const p = parseProbeArgs([]);
  assert.equal(p.mode, 'default');
  assert.equal(p.refresh, true);
  assert.equal(p.error, '');
  assert.deepEqual(probeEnv(p), {});
});

test('按名字探测：逗号分隔，空格去掉', () => {
  const p = parseProbeArgs(['GarageBand, UURemote']);
  assert.equal(p.mode, 'apps');
  assert.deepEqual(p.names, ['GarageBand', 'UURemote']);
});

test('按预设探测', () => {
  const p = parseProbeArgs(['--preset', 'tools']);
  assert.equal(p.mode, 'preset');
  assert.equal(p.preset, 'tools');
  assert.equal(probeEnv(p).MATRIX_PRESET, 'tools');
});

test('--preset=tools 这种等号写法也认', () => {
  assert.equal(parseProbeArgs(['--preset=tools']).preset, 'tools');
});

test('名字和预设不能同时给', () => {
  const p = parseProbeArgs(['GarageBand', '--preset', 'tools']);
  assert.ok(p.error.includes('不能同时'));
});

test('--preset 缺值要报错', () => {
  assert.ok(parseProbeArgs(['--preset']).error.includes('后面要给'));
});

test('不认识的参数要报错，不能默默忽略', () => {
  assert.ok(parseProbeArgs(['--bogus']).error.includes('不认识'));
});

test('--keep 关掉自动收尾，--no-refresh 不刷新清点', () => {
  const p = parseProbeArgs(['--keep', '--no-refresh']);
  assert.equal(p.keep, true);
  assert.equal(p.refresh, false);
  assert.equal(probeEnv(p).MATRIX_QUIT, '0');
});

test('按名字挑应用：显示名、bundle、可执行名都能命中', () => {
  const installed = [
    { name: 'GarageBand', bundle: 'com.apple.garageband10', process: 'GarageBand' },
    { name: 'UURemote', bundle: 'com.netease.uuremote', process: 'UURemote' },
    { name: 'Pages Creator Studio', bundle: 'com.apple.Pages', process: 'Pages' },
  ];
  const a = matchAppByNames(installed, ['garageband']);
  assert.equal(a.matched.length, 1);
  assert.equal(a.matched[0].bundle, 'com.apple.garageband10');
  const b = matchAppByNames(installed, ['com.netease.uuremote']);
  assert.equal(b.matched[0].name, 'UURemote');
  const c = matchAppByNames(installed, ['Pages']);
  assert.equal(c.matched[0].bundle, 'com.apple.Pages');
});

test('按名字挑应用：找不到的如实列出来，不静默跳过', () => {
  const r = matchAppByNames([{ name: 'A', bundle: 'a.b', process: 'A' }], ['A', '不存在的']);
  assert.equal(r.matched.length, 1);
  assert.deepEqual(r.missing, ['不存在的']);
});

test('按名字挑应用：同一个应用不会匹配两次', () => {
  const installed = [{ name: 'QQ', bundle: 'com.tencent.qq', process: 'QQ' }];
  const r = matchAppByNames(installed, ['QQ', 'qq']);
  assert.equal(r.matched.length, 1);
  assert.deepEqual(r.missing, ['qq']);
});

test('扫描目录：注入假的 plist 读取，不依赖真实安装', async () => {
  const fakeReaddir = async () => [
    { name: 'Foo.app', isDirectory: () => true },
    { name: 'notes.txt', isDirectory: () => false },
    { name: 'Broken.app', isDirectory: () => true },
  ];
  const readInfo = async (appPath) => (appPath.endsWith('Foo.app')
    ? { bundle: 'com.example.foo', exe: 'Foo', display: 'Foo 应用' }
    : { bundle: '', exe: '', display: '' });
  const apps = await scanDirs(['/fake'], { readdir: fakeReaddir, readInfo });
  assert.equal(apps.length, 1, '没有 bundle 的目录要跳过');
  assert.equal(apps[0].bundle, 'com.example.foo');
  assert.equal(apps[0].name, 'Foo 应用');
});

// ---------- 按名字解析：英文名 / 预设中文显示名 / bundle / 进程名 都认 ----------

const PRESETS_FIXTURE = [
  { name: '邮件', bundle: 'com.apple.mail', process: 'Mail' },
  { name: '日历', bundle: 'com.apple.iCal', process: 'Calendar' },
  { name: 'FastZip', bundle: 'cn.better365.FastZip', process: 'FastZip' },
  { name: '没装的', bundle: 'com.example.none', process: 'None' },
];
const INSTALLED_FIXTURE = [
  { name: 'Mail', bundle: 'com.apple.mail', process: 'Mail' },
  { name: 'Calendar', bundle: 'com.apple.iCal', process: 'Calendar' },
  { name: 'FastZip', bundle: 'cn.better365.FastZip', process: 'FastZip' },
  { name: 'Finder', bundle: 'com.apple.finder', process: 'Finder' },
];

test('resolveProbeNames：输入预设中文显示名 → 用中文名返回（矩阵要按本地化窗口 owner 匹配）', () => {
  const r = resolveProbeNames({ names: ['邮件'], installed: INSTALLED_FIXTURE, presets: PRESETS_FIXTURE });
  assert.deepEqual(r, { matched: [{ name: '邮件', bundle: 'com.apple.mail', process: 'Mail' }], missing: [] });
});

test('resolveProbeNames：输入英文名/进程名/bundle 也能命中预设', () => {
  for (const input of ['Mail', 'mail', 'com.apple.mail']) {
    const r = resolveProbeNames({ names: [input], installed: INSTALLED_FIXTURE, presets: PRESETS_FIXTURE });
    assert.equal(r.matched.length, 1, input);
    assert.equal(r.matched[0].name, '邮件', input + ' 应返回预设中文显示名');
  }
});

test('resolveProbeNames：不在预设里的已装应用按安装清单原名返回', () => {
  const r = resolveProbeNames({ names: ['Finder'], installed: INSTALLED_FIXTURE, presets: PRESETS_FIXTURE });
  assert.deepEqual(r.matched, [{ name: 'Finder', bundle: 'com.apple.finder', process: 'Finder' }]);
});

test('resolveProbeNames：没装的应用进 missing；重复输入去重', () => {
  const missing = resolveProbeNames({ names: ['没装的'], installed: INSTALLED_FIXTURE, presets: PRESETS_FIXTURE });
  assert.deepEqual(missing.matched, []);
  assert.deepEqual(missing.missing, ['没装的']);

  const dup = resolveProbeNames({ names: ['邮件', 'Mail', 'com.apple.mail'], installed: INSTALLED_FIXTURE, presets: PRESETS_FIXTURE });
  assert.equal(dup.matched.length, 1, '同一个应用只应解析一次');
});

test('resolveProbeNames：空输入/非法输入不崩', () => {
  assert.deepEqual(resolveProbeNames({}), { matched: [], missing: [] });
  assert.deepEqual(resolveProbeNames({ names: [null, '', '  '], installed: [], presets: [] }), { matched: [], missing: [] });
});
