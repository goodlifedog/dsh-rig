'use strict';
// 延迟复查前台：异步激活的应用要能兜住
import test from 'node:test';
import assert from 'node:assert/strict';
import { settleFront } from '../core/background.mjs';

test('操作后异步被抢：复查时发现并还原', async () => {
  let front = 'DSH';
  let restores = 0;
  const r = await settleFront('DSH', {
    waitMs: 10,
    retries: 2,
    deps: {
      frontName: async () => front,
      restoreFront: async (name) => { restores += 1; front = name; return true; },
    },
  });
  assert.equal(r.stolen, false, '一直没变就不算被抢');
  assert.equal(restores, 0);
});

test('第一次复查发现被抢：还原并标记', async () => {
  let calls = 0;
  let front = 'DSH';
  const r = await settleFront('DSH', {
    waitMs: 10,
    retries: 3,
    deps: {
      frontName: async () => { calls += 1; return calls === 2 ? 'QQ' : front; },
      restoreFront: async (name) => { front = name; return true; },
    },
  });
  assert.equal(r.stolen, true);
  assert.ok(r.restores >= 1);
});
test('restored 只看最终状态：没被抢也算还原成功', async () => {
  const r = await settleFront('DSH', { waitMs: 5, retries: 1, deps: { frontName: async () => 'DSH', restoreFront: async () => true } });
  assert.equal(r.restored, true);
});

test('用户中途自己切到别的应用：不再抢回来（尊重用户），并如实标记', async () => {
  const seq = ['DSH', 'QQ', 'Safari'];
  let restores = 0;
  const r = await settleFront('DSH', {
    waitMs: 5,
    retries: 3,
    deps: {
      frontName: async () => seq.shift() || 'Safari',
      restoreFront: async () => { restores += 1; return true; },
    },
  });
  assert.equal(r.stoppedByUser, true);
  assert.equal(restores, 1, '只在确认是 QQ 抢的时候还原一次');
  assert.equal(r.finalFront, 'Safari');
  assert.equal(r.restored, false);
});

test('期望前台未知（(unknown)）：不盲目 set frontmost，只如实报告', async () => {
  let restores = 0;
  const r = await settleFront('(unknown)', {
    waitMs: 5,
    retries: 2,
    deps: { frontName: async () => 'QQ', restoreFront: async () => { restores += 1; return true; } },
  });
  assert.equal(r.stolen, true);
  assert.equal(restores, 0, '不知道原来是谁就不该乱设前台');
  assert.equal(r.restored, false);
});

test('restored 如实反映还原失败', async () => {
  const r = await settleFront('DSH', { waitMs: 5, retries: 2, deps: { frontName: async () => 'Calculator', restoreFront: async () => false } });
  assert.equal(r.stolen, true);
  assert.equal(r.restored, false);
});
