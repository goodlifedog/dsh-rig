'use strict';
// 探测计划解析 + 按名字找应用：以后加应用不用手写 JSON
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseProbeArgs, probeEnv } from '../core/app-probe-plan.mjs';
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
