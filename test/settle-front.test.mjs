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
