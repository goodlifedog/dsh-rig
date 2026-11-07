'use strict';
// 运行时画像：按包结构/链接框架判断"这一族应用该怎么控"，而不是逐个应用试
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyRuntime,
  chooseDriverChain,
  countSdefCommands,
  describeProfile,
} from '../core/app-runtime.mjs';
import { findByBundle, scanDirs } from '../core/app-scan.mjs';

test('Electron：框架或 app.asar 任一命中都算', () => {
  assert.equal(classifyRuntime(['Electron Framework.framework']).type, 'electron');
  assert.equal(classifyRuntime([], { hasAsar: true }).type, 'electron');
});

test('Chromium 系：Chromium Embedded Framework', () => {
  assert.equal(classifyRuntime(['Chromium Embedded Framework.framework']).type, 'chromium');
});

test('Flutter / Qt / Java 各自能认出来', () => {
  assert.equal(classifyRuntime(['FlutterMacOS.framework']).type, 'flutter');
  assert.equal(classifyRuntime(['QtCore.framework']).type, 'qt');
  assert.equal(classifyRuntime([], { hasJvmRuntime: true }).type, 'java');
  assert.equal(classifyRuntime(['libjvm.dylib']).type, 'java');
});

test('只链接系统 WebKit 不算 Web 应用（GarageBand 这类会误判）', () => {
  const r = classifyRuntime(['/System/Library/Frameworks/WebKit.framework/Versions/A/WebKit']);
  assert.equal(r.type, 'native');
  assert.ok(r.evidence.some((e) => e.includes('WebKit')));
});

test('什么都没认出来：按原生处理，不能留空', () => {
  const r = classifyRuntime([]);
  assert.equal(r.type, 'native');
  assert.ok(r.evidence.length > 0);
});

test('驱动链：原生先 AX 再画面，最后一定有画面兜底', () => {
  const chain = chooseDriverChain({ type: 'native' });
  assert.deepEqual(chain.map((c) => c.driver), ['ax', 'visual']);
});

test('驱动链：Electron 多一条 CDP，且排在 AX 后面', () => {
  const chain = chooseDriverChain({ type: 'electron' });
  assert.deepEqual(chain.map((c) => c.driver), ['ax', 'cdp', 'visual']);
});

test('驱动链：有脚本字典才排 AppleScript 通道', () => {
  const withDict = chooseDriverChain({ type: 'native', applescript: { commands: 25 } });
  assert.ok(withDict.some((c) => c.driver === 'applescript'));
  const without = chooseDriverChain({ type: 'native', applescript: { commands: 0 } });
  assert.ok(!without.some((c) => c.driver === 'applescript'));
});

test('驱动链：未知类型按原生处理，不至于空手', () => {
  const chain = chooseDriverChain({ type: '外星运行时' });
  assert.equal(chain[0].driver, 'ax');
  assert.equal(chain[chain.length - 1].driver, 'visual');
});

test('数脚本命令：去重并忽略没有 name 的项', () => {
  const xml = '<command name="a"/><command name="b"/><command name="a"/><command />';
  assert.equal(countSdefCommands(xml), 2);
  assert.equal(countSdefCommands(''), 0);
});

test('画像文字里要写清运行时和驱动顺序', () => {
  const profile = { type: 'electron', evidence: ['包含 app.asar'], applescript: { available: false, commands: 0 } };
  const text = describeProfile(profile);
  assert.ok(text.includes('运行时：electron'));
  assert.ok(text.includes('驱动顺序：ax → cdp → visual'));
});

test('按 bundle 找应用：大小写不敏感，找不到给 null', () => {
  const installed = [{ name: 'Steam', bundle: 'com.valvesoftware.steam' }];
  assert.equal(findByBundle(installed, 'COM.VALVESOFTWARE.STEAM').name, 'Steam');
  assert.equal(findByBundle(installed, 'com.nope'), null);
  assert.equal(findByBundle(installed, ''), null);
});

test('扫描目录：符号链接的 .app 也要扫到（Safari 就在 /Applications 里做链接）', async () => {
  const fakeReaddir = async () => [
    { name: 'Safari.app', isDirectory: () => false, isSymbolicLink: () => true },
    { name: 'readme.md', isDirectory: () => false, isSymbolicLink: () => false },
  ];
  const apps = await scanDirs(['/fake'], {
    readdir: fakeReaddir,
    readInfo: async () => ({ bundle: 'com.apple.Safari', exe: 'Safari', display: 'Safari' }),
  });
  assert.equal(apps.length, 1);
  assert.equal(apps[0].bundle, 'com.apple.Safari');
});
test('Chromium 系自研壳：mojo / Renderer Helper 也算（微信、QQ 实测）', () => {
  assert.equal(classifyRuntime(['ConfSDKdyn.framework', 'libmmmojo.dylib']).type, 'chromium');
  assert.equal(classifyRuntime(['QQ Helper (Renderer).app', 'QQNT.framework']).type, 'chromium');
});

test('Chrome 系：Helper (Renderer) 带完整路径也能认出来，证据只写名字', () => {
  const helper = '/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Versions/1/Helpers/Google Chrome Helper (Renderer).app';
  const r = classifyRuntime(['Google Chrome Framework.framework', helper]);
  assert.equal(r.type, 'chromium');
  assert.equal(r.evidence[0], '包含 Google Chrome Helper (Renderer).app');
});

test('CEF 系：Chromium Embedded Framework / libcef 都算 chromium', () => {
  assert.equal(classifyRuntime(['Chromium Embedded Framework.framework']).type, 'chromium');
  assert.equal(classifyRuntime(['libcef.dylib']).type, 'chromium');
});

test('有 Helper (Renderer) 就不会被误判成 electron', () => {
  const helper = '/x/Contents/Frameworks/Electron Framework.framework/Versions/A/Helpers/Electron Helper (Renderer).app';
  const r = classifyRuntime(['Electron Framework.framework', helper]);
  assert.equal(r.type, 'electron', 'Electron 优先级最高，不能被 chromium 抢走');
});

test('每条通道都要写清使用前提', () => {
  for (const chainItem of chooseDriverChain({ type: 'electron' })) {
    assert.ok(chainItem.requires && chainItem.requires.length > 4, chainItem.driver + ' 缺前提说明');
  }
});
