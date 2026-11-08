'use strict';
// 用户离开时一条龙维护：只测纯逻辑与 --dry-run（不跑验收/矩阵，不动屏幕）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decideAwayState, buildPlan, summarizeSteps, MIN_IDLE_SEC, ABORT_IDLE_SEC } from '../scripts/away-maintenance.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

test('decideAwayState：锁屏/读不到空闲/用户在场/没离开够久/满足条件', () => {
  assert.equal(decideAwayState({ locked: true, idleMs: 10_000_000, minIdleMs: 900_000 }).go, false);
  assert.match(decideAwayState({ locked: true, idleMs: 10_000_000, minIdleMs: 900_000 }).reason, /锁屏|已锁/);

  assert.equal(decideAwayState({ locked: false, idleMs: -1, minIdleMs: 900_000 }).go, false);
  assert.match(decideAwayState({ locked: false, idleMs: -1, minIdleMs: 900_000 }).reason, /读不到/);

  const active = decideAwayState({ locked: false, idleMs: 10_000, minIdleMs: 900_000, abortIdleMs: 20_000 });
  assert.equal(active.go, false);
  assert.match(active.reason, /用户在场/);

  const early = decideAwayState({ locked: false, idleMs: 300_000, minIdleMs: 900_000, abortIdleMs: 20_000 });
  assert.equal(early.go, false);
  assert.match(early.reason, /还没离开够久/);

  assert.equal(decideAwayState({ locked: false, idleMs: 1_000_000, minIdleMs: 900_000, abortIdleMs: 20_000 }).go, true);
});

test('buildPlan：顺序固定，先完整验收、再按门类矩阵、最后清点', () => {
  const plan = buildPlan();
  assert.equal(plan.length, 7);
  assert.equal(plan[0].script, 'scripts/live-verify.mjs');
  assert.equal(plan[1].env.MATRIX_PRESET, 'reading');
  assert.equal(plan[2].env.MATRIX_PRESET, 'mail');
  assert.equal(plan[3].env.MATRIX_PRESET, 'calendar');
  assert.equal(plan[4].env.MATRIX_PRESET, 'photos');
  assert.equal(plan[5].env.MATRIX_PRESET, 'media');
  assert.equal(plan[6].script, 'scripts/app-inventory.mjs');
  for (const step of plan) assert.ok(step.timeoutMs > 0, step.name + ' 必须带超时');
});

test('summarizeSteps：全成功才是 ok；失败/中止要如实报', () => {
  assert.equal(summarizeSteps([{ status: 'ok' }, { status: 'ok' }]).ok, true);
  const bad = summarizeSteps([{ status: 'ok' }, { status: 'failed' }]);
  assert.equal(bad.ok, false);
  assert.match(bad.text, /失败 1/);
  const stopped = summarizeSteps([{ status: 'ok' }, { status: 'stopped' }]);
  assert.equal(stopped.ok, false);
  assert.match(stopped.text, /中止 1/);
});

test('门槛常量来自环境变量且不低于安全下限', () => {
  assert.ok(MIN_IDLE_SEC >= 60, '离开门槛不应低于 60s');
  assert.ok(ABORT_IDLE_SEC >= 5, '中止门槛不应低于 5s');
});

test('--dry-run：只打印计划与环境判断，不执行任何步骤', () => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'away-maintenance.mjs'), '--dry-run'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 60000,
    env: { ...process.env, AWAY_MIN_IDLE_SEC: '900' },
  });
  assert.equal(r.status, 0, r.stderr || r.stdout);
  assert.match(r.stdout, /维护计划/);
  assert.match(r.stdout, /--dry-run：只打印，不执行/);
  // 计划里每步都要打印出来，方便用户/Lead 判断会跑什么
  assert.match(r.stdout, /完整验收 verify:live/);
  assert.match(r.stdout, /重新清点/);
});
