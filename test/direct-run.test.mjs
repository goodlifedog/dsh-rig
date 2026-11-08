'use strict';
// 入口守卫 isDirectRun：纯函数 + 真实 spawn/import 语义（不启动应用、不碰屏幕）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { isDirectRun } from '../core/direct-run.mjs';

const SELF = fileURLToPath(import.meta.url);
const SELF_URL = pathToFileURL(SELF).href;
const ROOT = path.resolve(path.dirname(SELF), '..');
const DIRECT_RUN_URL = new URL('../core/direct-run.mjs', import.meta.url).href;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-direct-run-'));
const ENTRY = path.join(TMP, 'entry.mjs');
const ENTRY_LOG = path.join(TMP, 'entry-import.log');
// 直接执行时往日志写一行；被 import 时什么也不做（用来证明「单测 import 没有副作用」）
fs.writeFileSync(ENTRY, [
  "import fs from 'node:fs';",
  "import { isDirectRun } from " + JSON.stringify(DIRECT_RUN_URL) + ';',
  'export const invokedDirectly = isDirectRun(import.meta.url);',
  'if (invokedDirectly) fs.appendFileSync(process.env.DSH_DIRECT_RUN_LOG, "ran\\n");',
  '',
].join('\n'));

test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

test('普通绝对路径（runner/daemon spawn 形态）→ true', () => {
  assert.equal(isDirectRun(SELF_URL, SELF), true);
});

test('不同文件 → false', () => {
  assert.equal(isDirectRun(SELF_URL, path.join(path.dirname(SELF), 'other-file.mjs')), false);
});

test('argv1 缺失/为空 → false', () => {
  assert.equal(isDirectRun(SELF_URL, ''), false);
  assert.equal(isDirectRun(SELF_URL, null), false);
  assert.equal(isDirectRun('', SELF), false);
  assert.equal(isDirectRun(null, SELF), false);
});

test('argv1 是相对路径 → path.resolve 兜底后相等 → true', () => {
  const entry = path.join(TMP, 'relative-shortcut.mjs');
  fs.writeFileSync(entry, '// 空模块，只用来验证相对路径归一\n');
  const cwd = process.cwd();
  process.chdir(TMP);
  try {
    assert.equal(isDirectRun(pathToFileURL(entry).href, 'relative-shortcut.mjs'), true);
    assert.equal(isDirectRun(pathToFileURL(entry).href, './relative-shortcut.mjs'), true);
  } finally {
    process.chdir(cwd);
  }
});

test('符号链接路径：realpath 归一后相等 → true（旧写法在这里是 false，正是 L1 假绿）', (t) => {
  const real = path.join(TMP, 'sym-real.mjs');
  const link = path.join(TMP, 'sym-link.mjs');
  fs.writeFileSync(real, '// 符号链接目标\n');
  try {
    fs.symlinkSync(real, link);
  } catch (e) {
    t.skip('本机无法创建符号链接：' + (e && e.code));
    return;
  }
  assert.equal(isDirectRun(pathToFileURL(real).href, link), true);
  assert.equal(isDirectRun(pathToFileURL(link).href, real), true);
  // 旧写法：字符串比较，symlink 与 realpath 不等 → false
  const oldStyle = path.resolve(link) === fileURLToPath(pathToFileURL(real));
  assert.equal(oldStyle, false, '旧写法在符号链接下应为 false（任务会静默空跑）');
});

test('路径不存在时退回 path.resolve：同一路径 true、不同路径 false', () => {
  const ghost = path.join(TMP, 'not-there-yet.mjs');
  assert.equal(isDirectRun(pathToFileURL(ghost).href, ghost), true);
  assert.equal(isDirectRun(pathToFileURL(ghost).href, ghost + '.bak'), false);
});

test('moduleUrl 不是 file URL → false（不抛）', () => {
  assert.equal(isDirectRun('https://example.com/x.mjs', SELF), false);
  assert.equal(isDirectRun('data:text/javascript,1', SELF), false);
});

test('真实入口按 runner 的 spawn 形态（绝对路径）→ true', () => {
  // runner: spawn(process.execPath, [task.file])，task.file = path.join(__dirname, 'tasks', f)，
  // __dirname 来自 fileURLToPath(import.meta.url)（realpath）→ 就是「绝对路径 spawn」形态
  for (const rel of ['core/tasks/cold-launch.mjs', 'core/acceptance.mjs', 'core/runner.mjs']) {
    const file = path.join(ROOT, rel);
    assert.equal(isDirectRun(pathToFileURL(file).href, file), true, rel);
  }
});

test('spawn 真实绝对路径 → 守卫 true（runner/daemon 场景，行为不变）', () => {
  const log = path.join(TMP, 'spawn-direct.log');
  const r = spawnSync(process.execPath, [ENTRY], {
    env: { ...process.env, DSH_DIRECT_RUN_LOG: log },
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readFileSync(log, 'utf8'), 'ran\n');
});

test('spawn 符号链接路径 → 守卫 true（修前会静默空跑）', (t) => {
  const link = path.join(TMP, 'entry-link.mjs');
  try {
    fs.symlinkSync(ENTRY, link);
  } catch (e) {
    t.skip('本机无法创建符号链接：' + (e && e.code));
    return;
  }
  const log = path.join(TMP, 'spawn-symlink.log');
  const r = spawnSync(process.execPath, [link], {
    env: { ...process.env, DSH_DIRECT_RUN_LOG: log },
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readFileSync(log, 'utf8'), 'ran\n');
});

test('被 import（node --test 场景）→ 守卫 false，且没有副作用', async () => {
  fs.rmSync(ENTRY_LOG, { force: true });
  const prev = process.env.DSH_DIRECT_RUN_LOG;
  process.env.DSH_DIRECT_RUN_LOG = ENTRY_LOG;
  try {
    const mod = await import(pathToFileURL(ENTRY).href);
    assert.equal(mod.invokedDirectly, false);
  } finally {
    if (prev === undefined) delete process.env.DSH_DIRECT_RUN_LOG;
    else process.env.DSH_DIRECT_RUN_LOG = prev;
  }
  assert.equal(fs.existsSync(ENTRY_LOG), false, '被 import 时不能执行 main');
});
