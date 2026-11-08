'use strict';
// 静态回归（L1）：入口守卫统一走 core/direct-run.mjs 的 isDirectRun，
// 不许再手写「path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)」。
// 原因：import.meta.url 是 realpath，argv[1] 保留 symlink 路径，符号链接下守卫会判 false，
// 任务 main() 不执行却退出 0 —— 静默空跑 + 验收假绿。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// 本次收口的入口文件：任务书列的 18 个 + 同一类问题顺手统一的 greet-verify
const REQUIRED = [
  'core/acceptance.mjs',
  'core/runner.mjs',
  'scripts/cleanup-test-data.mjs',
  'core/tasks/cold-launch.mjs',
  'core/tasks/drive-agent.mjs',
  'core/tasks/drive-agent-cli.mjs',
  'core/tasks/browser-background.mjs',
  'core/tasks/boss-scan.mjs',
  'core/tasks/headless-demo.mjs',
  'core/tasks/user-active-demo.mjs',
  'core/tasks/app-matrix.mjs',
  'core/tasks/parallel-demo.mjs',
  'core/tasks/cdp-driver.mjs',
  'core/tasks/applescript-channel.mjs',
  'core/tasks/multi-app.mjs',
  'core/tasks/parallel-real-demo.mjs',
  'core/tasks/form-fill-local.mjs',
  'core/tasks/form-fill.mjs',
  'core/tasks/greet-verify.mjs',
];

// 已知缺口清单（现在为空）：task-75 把最后 6 处也收口了（cdp / dialog-guard / tasks-doc / env-doc /
// prune / away-maintenance）。保留这个机制是为了以后万一要留临时缺口时，必须显式登记并写理由，
// 而不是悄悄绕过静态回归。
const KNOWN_GAPS = {};

// 手写入口守卫的三种典型写法
const HAND_WRITTEN = [
  /path\.resolve\(\s*process\.argv\[1\]\s*\)/,
  /pathToFileURL\(\s*process\.argv\[1\]\s*\)/,
  /process\.argv\[1\]\s*\.endsWith\(/,
];

function read(file) {
  return fs.readFileSync(path.join(ROOT, file), 'utf8');
}

// 去掉注释再查：说明性注释里提到 argv[1] 不算违规
function stripComments(source) {
  return String(source)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

function handWritten(source) {
  const code = stripComments(source);
  return HAND_WRITTEN.filter((re) => re.test(code)).map((re) => re.source);
}

function listFiles(dir, prefix) {
  const abs = path.join(ROOT, dir);
  return fs.readdirSync(abs)
    .filter((f) => f.endsWith('.mjs'))
    .sort()
    .map((f) => prefix + '/' + f);
}

test('18 个入口文件（+ greet-verify）的守卫都走 isDirectRun', () => {
  assert.equal(REQUIRED.length, 19);
  for (const file of REQUIRED) {
    const src = read(file);
    assert.ok(/isDirectRun\(import\.meta\.url\)/.test(src), file + ' 没有用 isDirectRun(import.meta.url)');
    assert.deepEqual(handWritten(src), [], file + ' 还留着的手写入口守卫');
  }
});

test('core/tasks/*.mjs 不再手写 argv[1] 路径比较（新任务也必须统一）', () => {
  const files = listFiles('core/tasks', 'core/tasks');
  assert.ok(files.length > 10);
  for (const file of files) {
    assert.deepEqual(handWritten(read(file)), [], file + ' 出现手写入口守卫，请改用 core/direct-run.mjs 的 isDirectRun');
  }
});

test('core 根部与 scripts/ 不再出现手写入口守卫（确需留缺口必须登记）', () => {
  const files = [...listFiles('core', 'core'), ...listFiles('scripts', 'scripts')];
  for (const file of files) {
    const bad = handWritten(read(file));
    if (!bad.length) continue;
    assert.ok(
      Object.prototype.hasOwnProperty.call(KNOWN_GAPS, file),
      file + ' 出现手写入口守卫（' + bad.join(' / ') + '），请改用 core/direct-run.mjs 的 isDirectRun，或登记进已知缺口',
    );
  }
});

test('core/direct-run.mjs 用 realpath 归一两边路径，而不是字符串比较', () => {
  const src = read('core/direct-run.mjs');
  assert.match(src, /export function isDirectRun/);
  assert.match(src, /realpathSync\(/);
  assert.match(src, /fileURLToPath\(/);
  assert.match(src, /if \(!moduleUrl \|\| !argv1\) return false;/);
});

test('core/cdp.mjs 用共享 isDirectRun，本地同名函数已删除（避免重名遮蔽）', () => {
  const src = read('core/cdp.mjs');
  assert.match(src, /import \{ isDirectRun \} from '\.\/direct-run\.mjs';/);
  assert.match(src, /if \(isDirectRun\(import\.meta\.url\)\)/);
  // 本地同名函数必须删掉：否则 import 和 function 同名，行为会被本地实现盖掉
  assert.doesNotMatch(src, /function isDirectRun\s*\(/);
  assert.deepEqual(handWritten(src), []);
});

test('core/dialog-guard.mjs 的入口守卫也统一到 isDirectRun', () => {
  const src = read('core/dialog-guard.mjs');
  assert.match(src, /import \{ isDirectRun \} from '\.\/direct-run\.mjs';/);
  assert.match(src, /const isMain = isDirectRun\(import\.meta\.url\);/);
  assert.doesNotMatch(src, /\.endsWith\('dialog-guard\.mjs'\)/);
  assert.deepEqual(handWritten(src), []);
});

test('scripts 的 CLI 入口（tasks-doc / env-doc / prune）都走 isDirectRun', () => {
  for (const file of ['scripts/tasks-doc.mjs', 'scripts/env-doc.mjs', 'scripts/prune.mjs']) {
    const src = read(file);
    assert.match(src, /import \{ isDirectRun \} from '\.\.\/core\/direct-run\.mjs';/, file);
    assert.match(src, /const isMain = isDirectRun\(import\.meta\.url\);/, file);
    assert.deepEqual(handWritten(src), [], file);
  }
});

test('import 这些 CLI 模块不执行 main（守卫在测试进程里是 false，与 node --test 场景一致）', async () => {
  // 被 import 时守卫必须是 false：这些模块的 main 会读文件/删文件，import 阶段绝不能跑
  const [cdp, dialog, tasksDoc, envDoc] = await Promise.all([
    import('../core/cdp.mjs'),
    import('../core/dialog-guard.mjs'),
    import('../scripts/tasks-doc.mjs'),
    import('../scripts/env-doc.mjs'),
  ]);
  assert.equal(typeof cdp.CDP, 'function');
  assert.equal(typeof cdp.listTargets, 'function');
  assert.equal(typeof dialog.runOnce, 'function');
  assert.equal(typeof dialog.classifyDialog, 'function');
  assert.equal(typeof tasksDoc.buildTaskCatalog, 'function');
  assert.equal(typeof envDoc.buildEnvDoc, 'function');
});

test('CLI 直接执行仍然真的跑 main（prune --self-test 有输出，守卫 true）', () => {
  // prune 不带 --apply 只读不删；--self-test 走纯函数 planPrune 并打印一行
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'prune.mjs'), '--self-test'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /self-test 删除项/, '守卫为 false 时脚本会静默退出、不打印 self-test 行');
});
