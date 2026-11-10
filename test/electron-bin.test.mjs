'use strict';
// Electron 解析：全局安装时 electron 在包根 node_modules，开发态在 overlay/node_modules
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { electronRequireBases, electronInstallHint, resolveElectronBinary } from '../core/electron-bin.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

test('解析顺序：先 overlay（开发态），再包根（全局安装）', () => {
  const bases = electronRequireBases('/pkg');
  assert.deepEqual(bases, ['/pkg/overlay/package.json', '/pkg/package.json']);
});

test('overlay 有 electron 时优先用它', () => {
  const r = resolveElectronBinary({
    rootDir: '/pkg',
    requireResolve: (id, opts) => {
      assert.equal(id, 'electron');
      if (opts.paths[0] === '/pkg/overlay') return '/pkg/overlay/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron';
      throw new Error('should not reach root');
    },
  });
  assert.equal(r.path, '/pkg/overlay/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');
  assert.equal(r.from, '/pkg/overlay/package.json');
});

test('overlay 没有 electron 时回落到包根 node_modules（全局安装）', () => {
  const r = resolveElectronBinary({
    rootDir: '/usr/local/lib/node_modules/dsh-rig',
    requireResolve: (id, opts) => {
      if (opts.paths[0].includes('/overlay')) throw new Error('MODULE_NOT_FOUND');
      return '/usr/local/lib/node_modules/dsh-rig/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron';
    },
  });
  assert.match(r.path, /node_modules\/electron\/dist\/Electron\.app/);
  assert.match(r.from, /dsh-rig\/package\.json$/);
});

test('两处都没有时返回空路径，并给可操作的安装提示', () => {
  const r = resolveElectronBinary({ rootDir: '/pkg', requireResolve: () => { throw new Error('MODULE_NOT_FOUND'); } });
  assert.equal(r.path, '');
  assert.equal(r.tried.length, 2);
  const hint = electronInstallHint();
  assert.match(hint, /npm i -g dsh-rig/);
  assert.match(hint, /npm install/);
});

test('回归：service.mjs 不再写死 overlay/node_modules/electron 路径', () => {
  const source = fs.readFileSync(path.join(ROOT, 'core', 'service.mjs'), 'utf8');
  assert.equal(source.includes("path.join(ROOT, 'overlay/node_modules/electron"), false, '不能写死 overlay 路径');
  assert.equal(source.includes("path.join(ROOT, 'overlay', 'node_modules', 'electron'"), false, '不能写死 overlay 路径');
  assert.match(source, /overlayElectron\(\)/);
});

test('回归：overlay/start.mjs 走统一解析，而不是只 require 本地 electron', () => {
  const source = fs.readFileSync(path.join(ROOT, 'overlay', 'start.mjs'), 'utf8');
  assert.match(source, /resolveElectronBinary\(\)/);
  assert.equal(source.includes("require('electron')"), false);
});
