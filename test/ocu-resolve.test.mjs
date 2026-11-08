'use strict';
// 发布就绪：克隆 → npm install 就能用。这里锁死 ocu 的查找顺序与「找不到时的提示」。
// 全部用临时目录伪造 node_modules / third_party 结构，不依赖本机是否装过 ocu。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  resolveOcu,
  dependencyOcu,
  bundledOcu,
  requireOcu,
} from '../core/platform.mjs';

// 用 fileURLToPath：仓库路径里有中文，URL.pathname 是百分号编码的，直接读会 ENOENT
const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 建一个临时项目根：按需放 node_modules 里的依赖 / third_party 里的随包副本 */
function makeRoot({ dep = false, bundled = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ocu-resolve-'));
  if (dep) {
    const bin = path.join(root, 'node_modules', 'open-computer-use', 'bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, 'ocu'), '#!/bin/sh\n');
  }
  if (bundled) {
    const bin = path.join(root, 'third_party', 'open-computer-use', 'bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, 'ocu'), '#!/bin/sh\n');
  }
  return root;
}

const opts = (root, extra = {}) => Object.assign({ root, homedir: path.join(root, 'home'), env: {} }, extra);

test('查找顺序 1：OCU_BIN 环境变量最优先（即使依赖和随包副本都在）', () => {
  const root = makeRoot({ dep: true, bundled: true });
  assert.equal(resolveOcu(opts(root, { env: { OCU_BIN: '/custom/bin/ocu' } })), '/custom/bin/ocu');
});

test('查找顺序 2：node_modules/open-computer-use 优先于 third_party（克隆即用的默认路径）', () => {
  const root = makeRoot({ dep: true, bundled: true });
  const got = resolveOcu(opts(root));
  assert.equal(got, path.join(root, 'node_modules', 'open-computer-use', 'bin', 'ocu'));
});

test('查找顺序 3：没有依赖时用 third_party 随包副本（打包 .app 的路径）', () => {
  const root = makeRoot({ bundled: true });
  const got = resolveOcu(opts(root));
  assert.equal(got, path.join(root, 'third_party', 'open-computer-use', 'bin', 'ocu'));
});

test('查找顺序 4：都没有时 macOS 回退 ~/.local/bin/ocu（旧全局安装路径）', () => {
  const root = makeRoot();
  const home = path.join(root, 'home');
  assert.equal(resolveOcu(opts(root, { platform: 'darwin' })), path.join(home, '.local', 'bin', 'ocu'));
});

test('查找顺序 4b：Windows 回退 %APPDATA%/npm/ocu.cmd，文件不在就交回 PATH 查找', () => {
  const root = makeRoot();
  const appData = path.join(root, 'AppData');
  fs.mkdirSync(path.join(appData, 'npm'), { recursive: true });
  fs.writeFileSync(path.join(appData, 'npm', 'ocu.cmd'), '@echo off\n');
  assert.equal(
    resolveOcu(opts(root, { platform: 'win32', env: { APPDATA: appData } })),
    path.join(appData, 'npm', 'ocu.cmd'),
  );
  // 文件不存在：退回 'ocu.cmd' 让系统按 PATH 找，而不是返回一个不存在的绝对路径
  assert.equal(resolveOcu(opts(root, { platform: 'win32', env: { APPDATA: path.join(root, 'nope') } })), 'ocu.cmd');
});

test('不支持的平台返回 null（requireOcu 据此报错）', () => {
  const root = makeRoot();
  assert.equal(resolveOcu(opts(root, { platform: 'linux' })), null);
});

test('dependencyOcu / bundledOcu：不存在时返回 null，不会伪造路径', () => {
  const root = makeRoot();
  assert.equal(dependencyOcu({ root }), null);
  assert.equal(bundledOcu({ root }), null);
});

test('requireOcu：找不到时的提示要能直接照做（npm i open-computer-use）', () => {
  const root = makeRoot();
  assert.throws(
    () => requireOcu(opts(root, { platform: 'linux' })),
    (err) => {
      assert.match(String(err.message), /npm i open-computer-use/, '提示里必须有本地安装命令');
      assert.match(String(err.message), /npm i -g open-computer-use/, '全局安装也要提一句');
      return true;
    },
  );
});

test('requireOcu：找得到就返回路径，不抛', () => {
  const root = makeRoot({ dep: true });
  assert.equal(requireOcu(opts(root)), path.join(root, 'node_modules', 'open-computer-use', 'bin', 'ocu'));
});

test('真实仓库：默认参数下 resolveOcu 指向一个真实存在的文件或旧全局路径', () => {
  const got = resolveOcu();
  assert.ok(got, '当前环境（macOS）至少应给出 ~/.local/bin/ocu 这个回退路径');
  if (got.includes('node_modules')) assert.ok(fs.existsSync(got), '解析到依赖路径时必须真实存在：' + got);
});

// ---------- 发布物清单（npm pack 白名单） ----------

test('package.json files 白名单：含运行时/脚本/第三方许可，排除台账与日志', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
  const files = pkg.files || [];
  for (const need of ['core/', 'scripts/', 'overlay/', 'third_party/open-computer-use/LICENSE',
    'third_party/open-computer-use/NOTICE.md', 'third_party/open-computer-use/THIRD_PARTY_NOTICES.md']) {
    assert.ok(files.includes(need), '白名单应包含 ' + need);
  }
  for (const forbidden of ['logs/', 'reports/', 'flow/', 'test/']) {
    assert.ok(!files.includes(forbidden), '白名单不应包含 ' + forbidden);
  }
  // 内部台账即使出现在文件树里也不会被打进包：白名单是「只列这些」而不是「排除这些」
  assert.ok(files.every((f) => !/^logs|^reports|^flow/.test(f)), 'files 里不应出现台账目录');
});

test('package.json 发布元数据齐全（bin/repository/homepage/bugs/publishConfig/dependencies）', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
  assert.equal(pkg.bin['dsh-rig'], './core/cli.mjs');
  assert.ok(fs.readFileSync(path.join(REPO, 'core/cli.mjs'), 'utf8').startsWith('#!'), 'bin 入口要有 shebang');
  assert.match(pkg.repository.url, /github\.com\/goodlifedog\/dsh-rig/);
  assert.match(pkg.homepage, /github\.com\/goodlifedog\/dsh-rig/);
  assert.match(pkg.bugs.url, /\/issues$/);
  assert.equal(pkg.publishConfig.access, 'public');
  assert.match(pkg.dependencies['open-computer-use'], /^\^?1\./);
  assert.ok(pkg.keywords.length >= 12, 'keywords 至少 12 个，当前 ' + pkg.keywords.length);
});
