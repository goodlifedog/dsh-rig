'use strict';
// runner 拉起任务子进程：spawn 失败必须收口成一条可读错误 + 一行日志，
// 不能让主进程因未捕获 'error' 事件「凭空消失」。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { runOnce } from '../core/runner.mjs';

function fakeChild(pid = 4321) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => true;
  return child;
}

test('spawn 失败：runOnce 返回 spawnError，日志里有 spawn-error 行', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-spawn-'));
  try {
    const child = fakeChild();
    const result = await runOnce(
      { name: 'fake-task', file: '/nonexistent/task.mjs' },
      {
        timeoutMs: 5000,
        logDir: dir,
        spawn: () => {
          // 真实行为：spawn 成功后异步发 'error'
          queueMicrotask(() => child.emit('error', new Error('spawn ENOENT')));
          return child;
        },
      },
    );
    assert.equal(result.code, null);
    assert.match(result.spawnError, /spawn ENOENT/);
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
    assert.equal(files.length, 1);
    const lines = fs.readFileSync(path.join(dir, files[0]), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.ok(lines.some((l) => l.event === 'spawn-error'), '日志要留下启动失败原因');
    assert.ok(lines.some((l) => l.event === 'end'), '也要有结束行，否则统计会把它算成运行中');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
