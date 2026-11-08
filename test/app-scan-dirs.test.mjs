'use strict';
// 清点/探测的扫描目录必须一致，而且不能漏掉 ~/Applications——
// 漏了就会把装在用户目录里的应用误报成「没装/没测」，回答「还有哪些软件能适配」时直接答错。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { userAppDirs, allAppDirs, scanShortcutStubs, SYSTEM_APP_DIRS, FINDER_APP_PATH } from '../core/app-scan.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);

test('用户目录：/Applications 与 <home>/Applications 都要有', () => {
  const dirs = userAppDirs('/Users/tester');
  assert.ok(dirs.includes('/Applications'));
  assert.ok(dirs.includes('/Applications/Utilities'));
  assert.ok(dirs.includes('/Users/tester/Applications'), '缺 ~/Applications 会漏掉装在用户目录的应用');
});

test('用户目录：home 缺失时回退当前用户 home，不产出 undefined 路径', () => {
  const dirs = userAppDirs();
  assert.ok(dirs.every((d) => typeof d === 'string' && d.startsWith('/')));
  assert.ok(dirs.some((d) => d.endsWith('/Applications') && d !== '/Applications'), '应包含 <home>/Applications');
});

test('全量目录：含系统目录与 Finder 所在 CoreServices，且不重复', () => {
  const dirs = allAppDirs('/Users/tester');
  for (const d of SYSTEM_APP_DIRS) assert.ok(dirs.includes(d), '缺系统目录 ' + d);
  assert.ok(dirs.includes(path.dirname(FINDER_APP_PATH)), '缺 Finder 所在目录');
  assert.equal(new Set(dirs).size, dirs.length, '目录不能重复扫描');
});

test('全量目录：先用户目录再系统目录（报告里用户装的排前面）', () => {
  const dirs = allAppDirs('/Users/tester');
  assert.ok(dirs.indexOf('/Applications') < dirs.indexOf('/System/Applications'));
  assert.ok(dirs.includes('/Users/tester/Applications'));
});

test('扫描目录与脚本里的用法一致：不再硬编码只有 /Applications', () => {
  for (const file of ['scripts/app-inventory.mjs', 'scripts/apps-probe.mjs', 'scripts/app-resolve.mjs', 'scripts/app-runtime.mjs']) {
    const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
    assert.match(src, /userAppDirs|SYSTEM_APP_DIRS|allAppDirs/, file + ' 应该复用 core/app-scan.mjs 的目录定义');
  }
});

test('快捷方式壳：没有 bundle id 但有可执行文件的，单独列出来（不进接管统计）', async () => {
  const entries = [
    { name: 'Game.app', isDirectory: () => true, isSymbolicLink: () => false },
    { name: 'Real.app', isDirectory: () => true, isSymbolicLink: () => false },
    { name: 'notes.txt', isDirectory: () => false, isSymbolicLink: () => false },
  ];
  const stubs = await scanShortcutStubs(['/home/u/Applications'], {
    readdir: async () => entries,
    readInfo: async (p) => (p.includes('Game')
      ? { bundle: '', exe: 'run.sh', display: '' }
      : { bundle: 'com.example.real', exe: 'Real', display: 'Real' }),
  });
  assert.equal(stubs.length, 1);
  assert.equal(stubs[0].name, 'Game');
  assert.equal(stubs[0].exe, 'run.sh');
});

test('快捷方式壳：目录不存在时不抛错', async () => {
  const stubs = await scanShortcutStubs(['/no/such/dir'], { readdir: async () => { throw new Error('ENOENT'); } });
  assert.deepEqual(stubs, []);
});
