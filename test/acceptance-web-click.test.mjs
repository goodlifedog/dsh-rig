'use strict';
// 验收里的 examples/web-click 步骤：spawn 示例脚本后按 exit code + 输出分类。
// 注入 fake spawn：不启动 Chrome、不碰屏幕，覆盖 PASS / SKIP / FAIL 三种分类。
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import {
  classifyExampleResult,
  runExampleWebClick,
} from '../core/acceptance.mjs';

function makeFakeSpawn({ stdout = '', stderr = '', code = 0 } = {}) {
  const calls = [];
  const spawnFn = (cmd, args, options) => {
    calls.push({ cmd, args, options });
    const child = new EventEmitter();
    child.pid = 424242;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    setImmediate(() => {
      if (stdout) child.stdout.emit('data', Buffer.from(stdout));
      if (stderr) child.stderr.emit('data', Buffer.from(stderr));
      child.emit('close', code, null);
    });
    return child;
  };
  return { spawnFn, calls };
}

test('PASS：exit 0 且没有 SKIP → ok=true、skipped=false，输出带回结果', async () => {
  const fake = makeFakeSpawn({
    stdout: '[1] Chrome: /Applications/Google Chrome.app/...（headless）\nPASS  examples/web-click：按文字点击成功\n{"ok":true,"envSkip":false}\n',
    code: 0,
  });
  const r = await runExampleWebClick({ timeoutMs: 5000, spawn: fake.spawnFn, idleFn: () => 9999 });
  assert.equal(r.ok, true);
  assert.equal(r.skipped, false);
  assert.equal(r.detail, '');
  assert.match(r.output, /PASS  examples\/web-click/);
  assert.equal(fake.calls.length, 1, '只应 spawn 一次');
  assert.equal(fake.calls[0].cmd, process.execPath);
  assert.deepEqual(fake.calls[0].args, ['examples/web-click/run.mjs']);
  assert.equal(fake.calls[0].options.detached, true);
  assert.ok(fake.calls[0].options.cwd, '示例脚本必须在仓库根目录跑');
});

test('SKIP：exit 0 + 脚本自报 SKIP → 环境跳过（不算 PASS），仍返回 ok=true/skipped=true', async () => {
  const fake = makeFakeSpawn({
    stdout: 'SKIP  环境跳过：headless Chrome 不可用\n{"ok":false,"envSkip":true,"elapsedMs":12}\n',
    code: 0,
  });
  const r = await runExampleWebClick({ timeoutMs: 5000, spawn: fake.spawnFn, idleFn: () => 9999 });
  assert.equal(r.ok, true, '环境跳过不算失败');
  assert.equal(r.skipped, true);
  assert.match(r.detail, /环境跳过/);
  assert.match(r.output, /SKIP/);
  assert.match(r.output, /"envSkip":true/);
  assert.equal(fake.calls.length, 1);
});

test('FAIL：exit 非 0 → ok=false、skipped=false，detail 带上失败输出', async () => {
  const fake = makeFakeSpawn({
    stdout: 'FAIL  examples/web-click：按钮没找到\n',
    stderr: 'Error: fixture 未加载\n',
    code: 1,
  });
  const r = await runExampleWebClick({ timeoutMs: 5000, spawn: fake.spawnFn, idleFn: () => 9999 });
  assert.equal(r.ok, false);
  assert.equal(r.skipped, false);
  assert.match(r.detail, /FAIL  examples\/web-click/);
  assert.match(r.output, /fixture 未加载/);
});

test('exit 非 0 即使输出里有 SKIP 也按 FAIL 处理（不能靠 SKIP 逃失败）', () => {
  const r = classifyExampleResult({ code: 1, stdout: 'SKIP  环境跳过：x\n' });
  assert.equal(r.ok, false);
  assert.equal(r.skipped, false);
});

test('用户回来被中止 → 环境跳过，不算失败', () => {
  const r = classifyExampleResult({ code: 0, stdout: '', aborted: true });
  assert.equal(r.ok, true);
  assert.equal(r.skipped, true);
  assert.match(r.detail, /用户回到电脑前/);
});

test('超时 → FAIL（带超时原因），不被当成环境跳过', () => {
  const r = classifyExampleResult({ code: 1, stdout: '', timedOut: true });
  assert.equal(r.ok, false);
  assert.equal(r.skipped, false);
  assert.match(r.detail, /超时/);
});

test('环境跳过文案兼容 run-classify 的识别（不只认大写 SKIP）', () => {
  const r = classifyExampleResult({ code: 0, stdout: '环境跳过：屏幕已锁\n' });
  assert.equal(r.ok, true);
  assert.equal(r.skipped, true);
});

test('仅打印 SKIP 且 exit 0 → 环境跳过（regex 分支）', () => {
  const r = classifyExampleResult({ code: 0, stdout: 'SKIP  环境跳过：headless Chrome 不可用\n' });
  assert.equal(r.ok, true);
  assert.equal(r.skipped, true);
  assert.match(r.detail, /环境跳过/);
});
