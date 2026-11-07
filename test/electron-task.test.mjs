'use strict';
// electron-task 里两个「不启动 Electron 就能测」的函数：端口文件解析与可执行文件定位。
// 这个模块 500+ 行、是 overlay 能跑起来的关键，之前没有任何单测引用。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readDevToolsActivePort, resolveElectronBinary } from '../core/electron-task.mjs';


function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'etask-'));
}

test('DevToolsActivePort：正常文件解析出端口与路径', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'DevToolsActivePort'), '54321\n/devtools/browser/abc-123\n');
  const r = readDevToolsActivePort(dir);
  assert.equal(r.port, 54321);
  assert.equal(r.browserPath, '/devtools/browser/abc-123');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('DevToolsActivePort：文件不存在返回 null（不抛错，调用方靠它轮询）', () => {
  const dir = tmpDir();
  assert.equal(readDevToolsActivePort(dir), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('DevToolsActivePort：内容非法（端口 0 / 非数字）返回 null', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'DevToolsActivePort');
  fs.writeFileSync(file, '0\n/abc\n');
  assert.equal(readDevToolsActivePort(dir), null);
  fs.writeFileSync(file, 'not-a-port\n/abc\n');
  assert.equal(readDevToolsActivePort(dir), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('resolveElectronBinary：显式路径存在时优先用它', () => {
  const dir = tmpDir();
  const fake = path.join(dir, 'electron');
  fs.writeFileSync(fake, '#!/bin/sh\n');
  assert.equal(resolveElectronBinary(fake), fake);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('resolveElectronBinary：显式路径不存在时，退到随包 Electron 或报可读错误', () => {
  const missing = path.join(os.tmpdir(), 'definitely-not-electron-' + Date.now());
  // 装没装 overlay 依赖会让这条走向不同：装了退到随包那份，没装才抛错。两种都算对。
  let resolved = null;
  let error = null;
  try { resolved = resolveElectronBinary(missing); } catch (e) { error = e; }
  if (resolved) {
    assert.notEqual(resolved, missing);
    assert.equal(fs.existsSync(resolved), true, '退到的路径必须真的存在');
  } else {
    assert.ok(error, '既没返回路径也没报错，说明分支漏了');
    assert.match(error.message, /找不到 Electron 可执行文件/);
    assert.match(error.message, /npm install/);
  }
});
