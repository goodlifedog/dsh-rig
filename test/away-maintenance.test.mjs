'use strict';
// 用户离开时一条龙维护：纯逻辑 + runStep 的并发/中止/超时行为都要测，
// 但绝不产生真实进程、不跑验收/矩阵、不动屏幕。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  decideAwayState,
  buildPlan,
  summarizeSteps,
  parseEnvMs,
  safeLogFileName,
  checkServicesFresh,
  runStep,
  MIN_IDLE_SEC,
  ABORT_IDLE_SEC,
} from '../scripts/away-maintenance.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

function fakeChild(pid = 424242) {
  const handlers = new Map();
  const child = {
    pid,
    on(event, cb) { handlers.set(event, cb); return child; },
    emit(event, arg) { const cb = handlers.get(event); if (cb) cb(arg); },
  };
  return child;
}

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
  // 阈值相等按「允许」处理（≥ 语义）
  assert.equal(decideAwayState({ locked: false, idleMs: 900_000, minIdleMs: 900_000, abortIdleMs: 20_000 }).go, true);
});

test('parseEnvMs：非法值回退默认（NaN 不能击穿安全门槛，复核 H1）', () => {
  const warns = [];
  assert.equal(parseEnvMs('abc', 900, 60, (m) => warns.push(m)), 900_000);
  assert.equal(warns.length, 1);
  assert.equal(parseEnvMs(undefined, 20, 5), 20_000);
  assert.equal(parseEnvMs('', 5, 1), 5_000);
  assert.equal(parseEnvMs('120', 900, 60), 120_000, '合法值按秒转毫秒');
  assert.equal(parseEnvMs('30', 900, 60), 60_000, '合法但低于安全下限时抬到下限');
  assert.equal(parseEnvMs('1', 900, 60), 60_000, '低于安全下限时抬到下限');
  assert.equal(parseEnvMs('-5', 20, 5), 5_000, '负数抬到下限');
  assert.equal(parseEnvMs('Infinity', 20, 5, () => {}), 20_000, 'Infinity 也按非法处理');
});

test('safeLogFileName：只允许简单文件名，防 ../ 逃出 logs/away（复核 L1）', () => {
  assert.equal(safeLogFileName('away-1.log'), 'away-1.log');
  assert.equal(safeLogFileName('../../tmp/x.log'), 'latest.log');
  assert.equal(safeLogFileName('/etc/passwd'), 'latest.log');
  assert.equal(safeLogFileName('a/b.log'), 'latest.log');
  assert.equal(safeLogFileName(''), 'latest.log');
  assert.equal(safeLogFileName('..'), 'latest.log');
  assert.equal(safeLogFileName(undefined), 'latest.log');
});

test('buildPlan：顺序固定，先刷新服务、再完整验收、按门类矩阵、最后清点', () => {
  const plan = buildPlan();
  assert.equal(plan.length, 8);
  assert.equal(plan[0].script, 'core/service.mjs');
  assert.deepEqual(plan[0].args, ['install']);
  assert.equal(plan[1].script, 'scripts/live-verify.mjs');
  assert.equal(plan[2].env.MATRIX_PRESET, 'reading');
  assert.equal(plan[3].env.MATRIX_PRESET, 'mail');
  assert.equal(plan[4].env.MATRIX_PRESET, 'calendar');
  assert.equal(plan[5].env.MATRIX_PRESET, 'photos');
  assert.equal(plan[6].env.MATRIX_PRESET, 'media');
  assert.equal(plan[7].script, 'scripts/app-inventory.mjs');
  for (const step of plan) assert.ok(step.timeoutMs > 0, step.name + ' 必须带超时');
});

test('summarizeSteps：全成功才是 ok；失败/中止/未跑都要如实报', () => {
  assert.equal(summarizeSteps([{ status: 'ok' }, { status: 'ok' }]).ok, true);
  assert.equal(summarizeSteps([]).ok, false, '一步都没跑不能算 ok');
  const bad = summarizeSteps([{ status: 'ok' }, { status: 'failed' }]);
  assert.equal(bad.ok, false);
  assert.match(bad.text, /失败 1/);
  const stopped = summarizeSteps([{ status: 'ok' }, { status: 'stopped' }]);
  assert.equal(stopped.ok, false);
  assert.match(stopped.text, /中止 1/);
  const skipped = summarizeSteps([{ status: 'ok' }, { status: 'skipped' }]);
  assert.equal(skipped.ok, false, '有没跑的步骤也不能算全跑完');
  assert.match(skipped.text, /跳过 1/);
});

test('checkServicesFresh：restart 后要能识别「有服务落后」（复核 M5）', () => {
  const stale = checkServicesFresh(() => ({ stdout: 'daemon 代码新鲜度：ok\noverlay 代码新鲜度：落后 —— overlay/main.js 比进程新 3 分钟' }));
  assert.equal(stale.fresh, false);
  assert.match(stale.detail, /落后/);
  const fresh = checkServicesFresh(() => ({ stdout: 'daemon 代码新鲜度：ok\noverlay 代码新鲜度：ok' }));
  assert.equal(fresh.fresh, true);
});

// ---------- runStep：用假 spawn / 假 kill / 假时钟，不产生真实进程 ----------

test('runStep：正常退出码 0 → ok，且不触发 kill', async () => {
  const child = fakeChild();
  const kills = [];
  const promise = runStep({ name: 'x', script: 'scripts/x.mjs', timeoutMs: 5000 }, {
    spawn: () => child,
    readState: async () => ({ locked: false, idleMs: 10_000_000 }),
    kill: (pid) => { kills.push(pid); return { cancel() {} }; },
    pollMs: 20,
  });
  child.emit('close', 0);
  const result = await promise;
  assert.equal(result.status, 'ok');
  assert.deepEqual(kills, []);
});

test('runStep：运行中用户回来 → 只 kill 一次并记 stopped（复核 M3）', async () => {
  const child = fakeChild();
  const kills = [];
  let reads = 0;
  const promise = runStep({ name: 'x', script: 'scripts/x.mjs', timeoutMs: 5000 }, {
    spawn: () => child,
    readState: async () => { reads += 1; return { locked: false, idleMs: 5_000 }; },
    kill: (pid) => { kills.push(pid); return { cancel() {} }; },
    pollMs: 10,
    abortIdleMs: 20_000,
    settleGraceMs: 5000,
  });
  await new Promise((r) => setTimeout(r, 50));
  child.emit('close', 143);
  const result = await promise;
  assert.equal(result.status, 'stopped');
  assert.match(result.reason, /用户在场/);
  assert.deepEqual(kills, [424242], '重复轮询只能 kill 一次');
  assert.ok(reads >= 1, '拿到条件不满足后立即查过一次（不是等 5 秒）');
});

test('runStep：非 0 退出码 → failed（带退出码）', async () => {
  const child = fakeChild();
  const promise = runStep({ name: 'x', script: 'scripts/x.mjs', timeoutMs: 5000 }, {
    spawn: () => child,
    readState: async () => ({ locked: false, idleMs: 10_000_000 }),
    kill: () => ({ cancel() {} }),
    pollMs: 20,
  });
  child.emit('close', 3);
  const result = await promise;
  assert.equal(result.status, 'failed');
  assert.match(result.reason, /退出码 3/);
});

test('runStep：spawn 报错 → failed，不卡住', async () => {
  const child = fakeChild();
  const promise = runStep({ name: 'x', script: 'scripts/x.mjs', timeoutMs: 5000 }, {
    spawn: () => child,
    readState: async () => ({ locked: false, idleMs: 10_000_000 }),
    kill: () => ({ cancel() {} }),
    pollMs: 20,
  });
  child.emit('error', new Error('ENOENT'));
  const result = await promise;
  assert.equal(result.status, 'failed');
  assert.match(result.reason, /ENOENT/);
});

test('runStep：超时且子进程不肯 close → 兜底强制结算，不永久挂起（复核 M2）', async () => {
  const child = fakeChild();
  const kills = [];
  const promise = runStep({ name: 'slow', script: 'scripts/x.mjs', timeoutMs: 30 }, {
    spawn: () => child,
    readState: async () => ({ locked: false, idleMs: 10_000_000 }),
    kill: (pid) => { kills.push(pid); return { cancel() {} }; },
    pollMs: 1000,
    settleGraceMs: 60,
  });
  const result = await promise;
  assert.equal(result.status, 'stopped');
  assert.match(result.reason, /超时|收不掉/);
  assert.deepEqual(kills, [424242]);
});

test('runStep：spawn 之前就不再满足条件时，由调用方拦截（这里验证秒级立即查一次）', async () => {
  const child = fakeChild();
  let firstCheck = true;
  const kills = [];
  const promise = runStep({ name: 'x', script: 'scripts/x.mjs', timeoutMs: 5000 }, {
    spawn: () => child,
    readState: async () => {
      const value = firstCheck ? { locked: false, idleMs: 10_000_000 } : { locked: true, idleMs: -1 };
      firstCheck = false;
      return value;
    },
    kill: (pid) => { kills.push(pid); return { cancel() {} }; },
    pollMs: 10,
    abortIdleMs: 20_000,
    settleGraceMs: 5000,
  });
  await new Promise((r) => setTimeout(r, 40));
  child.emit('close', 143);
  const result = await promise;
  assert.equal(result.status, 'stopped');
  assert.match(result.reason, /锁屏|已锁/);
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
  assert.match(r.stdout, /完整验收 verify:live/);
  assert.match(r.stdout, /重新清点/);
});
