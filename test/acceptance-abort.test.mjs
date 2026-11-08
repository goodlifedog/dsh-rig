'use strict';
// 验收跑到一半用户回来了：必须立刻杀掉当前任务，而不是等它跑完（app-matrix 能跑好几分钟）
import test from 'node:test';
import assert from 'node:assert/strict';
import { runTaskProcess } from '../core/acceptance.mjs';

test('用户回到电脑前：任务立刻被停止并标记 aborted', async () => {
  const started = Date.now();
  const r = await runTaskProcess(process.execPath, ['-e', 'setInterval(function(){}, 1000)'], {
    timeout: 20000,
    idleFn: () => 5,          // 键鼠 5 秒前动过 = 用户在场
  });
  assert.equal(r.aborted, true);
  assert.ok(Date.now() - started < 15000, '应该在第一次轮询后就停，不该等超时');
});

test('用户没回来：任务正常跑完，不带 aborted', async () => {
  const r = await runTaskProcess(process.execPath, ['-e', 'console.log("done")'], {
    timeout: 20000,
    idleFn: () => 600,        // 用户 10 分钟没动
  });
  assert.equal(r.aborted, false);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /done/);
});

test('ACCEPT_FORCE=1 时不因为用户在场而杀任务（用户显式强跑）', async () => {
  const prev = process.env.ACCEPT_FORCE;
  process.env.ACCEPT_FORCE = '1';
  try {
    const r = await runTaskProcess(process.execPath, ['-e', 'console.log("ok")'], {
      timeout: 20000,
      idleFn: () => 1,
    });
    assert.equal(r.aborted, false);
    assert.equal(r.code, 0);
  } finally {
    if (prev === undefined) delete process.env.ACCEPT_FORCE; else process.env.ACCEPT_FORCE = prev;
  }
});
