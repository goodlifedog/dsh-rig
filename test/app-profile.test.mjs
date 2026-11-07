'use strict';
// 应用包画像：不启动应用，只看包结构判断运行时族
// 重点回归：Chrome/Edge 把 Helper (Renderer) 埋在框架内部，只扫顶层 Frameworks 会误判成原生
import test from 'node:test';
import assert from 'node:assert/strict';
import { listRendererHelpers, profileApp } from '../core/app-profile.mjs';

const CHROME = '/Applications/Google Chrome.app';
const HELPER = CHROME + '/Contents/Frameworks/Google Chrome Framework.framework/Versions/1/Helpers/Google Chrome Helper (Renderer).app';

function fakeExec({ helper = '', links = '', exe = 'Chrome' } = {}) {
  return async (cmd, args) => {
    if (cmd === '/usr/bin/find') {
      if (helper instanceof Error) throw helper;
      return { stdout: helper + '\n' };
    }
    if (cmd === '/usr/bin/otool') return { stdout: links };
    if (cmd === '/usr/libexec/PlistBuddy') return { stdout: exe + '\n' };
    throw new Error('unexpected cmd ' + cmd + ' ' + (args || []).join(' '));
  };
}

function fakeDeps(extra = {}) {
  return {
    readdir: async () => [],
    readdirNames: async () => [],
    readdirRecursive: async () => [],
    access: async () => { throw new Error('ENOENT'); },
    readFile: async () => '',
    ...extra,
  };
}

test('Chrome 的 Helper 埋在框架内部也能找到，从而认成 chromium', async () => {
  assert.deepEqual(await listRendererHelpers(CHROME, { exec: fakeExec({ helper: HELPER }) }), [HELPER]);
  const profile = await profileApp(CHROME, {
    ...fakeDeps({ readdir: async () => ['Google Chrome Framework.framework'] }),
    exec: fakeExec({ helper: HELPER }),
  });
  assert.equal(profile.type, 'chromium');
  assert.ok(profile.evidence.some((e) => e.includes('Helper (Renderer)')), JSON.stringify(profile.evidence));
});

test('找不到 Helper 时不报错，就返回空数组（原生应用没有这东西）', async () => {
  assert.deepEqual(await listRendererHelpers('/Applications/Finder.app', { exec: fakeExec({ helper: '' }) }), []);
  assert.deepEqual(await listRendererHelpers('/Applications/Finder.app', { exec: fakeExec({ helper: new Error('find failed') }) }), []);
});

test('Electron：框架 + app.asar 仍然认成 electron（别被新的 chromium 判定抢走）', async () => {
  const profile = await profileApp('/Applications/Some.app', {
    ...fakeDeps({
      readdir: async () => ['Electron Framework.framework'],
      access: async () => undefined,
    }),
    exec: fakeExec({ helper: '', exe: 'Some' }),
  });
  assert.equal(profile.type, 'electron');
});

test('原生应用：没有框架、没有 Helper、没有 asar，落到 native', async () => {
  const profile = await profileApp('/Applications/Calculator.app', {
    ...fakeDeps({ readdir: async () => [] }),
    exec: fakeExec({ helper: '', exe: 'Calculator' }),
  });
  assert.equal(profile.type, 'native');
});
