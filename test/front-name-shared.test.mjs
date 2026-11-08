'use strict';
// H2 缺口 A：6 个任务文件里的本地 front() 原来用 osascript tell System Events 读前台（会弹自动化授权框），
// 现在统一改成 core/background.mjs 的 frontName()（ObjC/NSWorkspace，不发 AppleEvent）+ 薄包装保持旧语义。
// 本文件只做静态断言 + 注入假 reader 的纯逻辑测试，绝不调用 osascript。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findAppleEventSites } from '../core/safety-audit.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..');
const IS_MAC = process.platform === 'darwin';

const FILES = [
  { file: 'core/tasks/browser-background.mjs', label: 'browser-background' },
  { file: 'core/tasks/drive-agent.mjs', label: 'drive-agent' },
  { file: 'core/tasks/drive-agent-cli.mjs', label: 'drive-agent-cli' },
  { file: 'core/tasks/parallel-demo.mjs', label: 'parallel-demo' },
  { file: 'core/tasks/parallel-real-demo.mjs', label: 'parallel-real-demo' },
  { file: 'core/tasks/form-fill-local.mjs', label: 'form-fill-local' },
];

function sourceOf(file) {
  return fs.readFileSync(path.join(REPO, file), 'utf8');
}

// ---------- 静态：本地 AppleEvent 已彻底移除 ----------

test('6 个文件里不再有「tell application "System Events" 读前台」的本地实现', () => {
  for (const { file } of FILES) {
    const src = sourceOf(file);
    assert.equal(/tell application "System Events"/.test(src), false, file + ' 仍残留 System Events AppleEvent');
    assert.equal(/first (?:application )?process whose frontmost is true/.test(src), false, file + ' 仍残留读前台的 AppleScript');
    // findAppleEventSites 是 safety-audit 规则 6 的同一个探测函数：0 命中 = 没有 AppleEvent 调用点
    assert.deepEqual(findAppleEventSites(src), [], file + ' 仍有 AppleEvent 调用点');
  }
});

test('6 个文件都改成复用 background 的 frontName（import ... as sharedFrontName）', () => {
  for (const { file } of FILES) {
    const src = sourceOf(file);
    assert.match(src, /import \{[^}]*frontName as sharedFrontName[^}]*\} from '\.\.\/background\.mjs';/, file + ' 没有从 background 引入 frontName');
    assert.ok(src.includes('reader = sharedFrontName'), file + ' 薄包装没有默认走共享 frontName');
  }
});

test('5 个文件不再需要 execFileSync（form-fill-local 仍用 execFile 跑别的命令）', () => {
  for (const { file } of FILES) {
    const src = sourceOf(file);
    if (file.endsWith('form-fill-local.mjs')) {
      assert.ok(src.includes("import { execFile, spawn } from 'node:child_process';"), 'form-fill-local 的 execFile 还要用（run 辅助）');
      continue;
    }
    assert.equal(/from 'node:child_process'/.test(src), false, file + ' 的 child_process import 已无用，应删掉');
  }
});

// ---------- 行为：薄包装在三种情况下的返回（注入假 reader，不碰系统） ----------

const IMPLS = [];
if (IS_MAC) {
  const [bb, da, dac, pd, prd, ffl] = await Promise.all([
    import('../core/tasks/browser-background.mjs'),
    import('../core/tasks/drive-agent.mjs'),
    import('../core/tasks/drive-agent-cli.mjs'),
    import('../core/tasks/parallel-demo.mjs'),
    import('../core/tasks/parallel-real-demo.mjs'),
    import('../core/tasks/form-fill-local.mjs'),
  ]);
  IMPLS.push(
    ['browser-background frontName', bb.frontName],
    ['drive-agent front', da.front],
    ['drive-agent-cli front', cliFront(dac)],
    ['parallel-demo frontmostName', pd.frontmostName],
    ['parallel-real-demo frontName', prd.frontName],
    ['form-fill-local frontmost', ffl.frontmost],
  );
}

function cliFront(mod) {
  return mod.front;
}

test('薄包装：正常名字原样返回 / (unknown) 映射成空串 / reader 抛错返回空串', {
  skip: IS_MAC ? false : 'form-fill-local 在非 macOS 模块顶层会 process.exit(2)，本机非 macOS 不导入',
}, async () => {
  assert.equal(IMPLS.length, 6, '六个入口都要被测到');
  for (const [name, fn] of IMPLS) {
    assert.equal(await fn(async () => 'Google Chrome'), 'Google Chrome', name + ' 正常名');
    assert.equal(await fn(async () => '  Calculator  '), 'Calculator', name + ' 前后空白要 trim（与旧实现一致）');
    assert.equal(await fn(async () => '(unknown)'), '', name + ' (unknown) 必须映射成空串');
    assert.equal(await fn(async () => { throw new Error('boom'); }), '', name + ' reader 抛错要返回空串');
    assert.equal(await fn(async () => null), '', name + ' null 返回空串');
    assert.equal(await fn(async () => undefined), '', name + ' undefined 返回空串');
  }
});

test('导入这 6 个任务模块不会执行任务本体（isMain 守卫生效）', {
  skip: IS_MAC ? false : 'form-fill-local 在非 macOS 模块顶层会 process.exit(2)',
}, () => {
  assert.equal(process.exitCode, undefined, 'import 不应设置失败退出码');
  for (const [name, fn] of IMPLS) assert.equal(typeof fn, 'function', name + ' 应该导出包装函数');
});
