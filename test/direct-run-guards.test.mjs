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

// 仍是手写守卫、但不在本次写作用域内的文件（已知缺口，建议另开任务统一；修好后可从清单删）
const KNOWN_GAPS = {
  'core/cdp.mjs': '本地函数 isDirectRun() 仍在用 pathToFileURL(argv[1]) 比较；写作用域外',
  'core/dialog-guard.mjs': '仍是 endsWith 名字守卫；写作用域外',
  'scripts/tasks-doc.mjs': '手写 path.resolve(argv[1]) 比较；写作用域外',
  'scripts/prune.mjs': '仍是 endsWith 名字守卫；写作用域外',
  'scripts/away-maintenance.mjs': '手写 path.resolve(argv[1]) 比较；写作用域外',
  'scripts/env-doc.mjs': '手写 path.resolve(argv[1]) 比较；写作用域外',
};

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

test('core 根部与 scripts/ 的剩余手写守卫只允许出现在已知缺口清单里', () => {
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
