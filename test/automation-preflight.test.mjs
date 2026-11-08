'use strict';
// H2：发 AppleEvent 之前先静默预检「自动化」授权（AEDeterminePermissionToAutomateTarget + askUserIfNeeded=false）。
// 本文件只测注入假探测的纯逻辑/分支，**绝不发真实 AppleEvent**（不 spawn osascript、不碰 TCC）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  decideAutomationGate as decideNotesGate,
  checkNotesAutomation,
  countNotes,
  deleteMarkedTestNotes,
  deleteTestNotes,
  SYSTEM_EVENTS_BUNDLE_ID,
} from '../core/note-cleanup.mjs';
import {
  decideAutomationGate as decideQuitGate,
  checkAutomationPermissionSync,
  quitAppSync,
  PREFLIGHT_TIMEOUT_MS,
} from '../core/sync-quit.mjs';
import {
  decideAutomationSkip as decideColdLaunchSkip,
  preflightAutomation,
  SYSTEM_EVENTS_BUNDLE,
} from '../core/tasks/cold-launch.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..');
const granted = async () => ({ status: 'granted' });
const DROP_ALL = { exec: async () => { throw new Error('未授权时绝不允许发 AppleEvent'); } };

// ---------- note-cleanup：判定与跳过 ----------

test('note-cleanup 授权判定：granted 放行；denied/needs-consent/unknown 一律跳过', () => {
  assert.equal(decideNotesGate('granted').allow, true);
  for (const status of ['denied', 'needs-consent', 'unknown', 'app-not-running', 'timeout', '']) {
    const r = decideNotesGate(status);
    assert.equal(r.allow, false, status + ' 不该放行');
    assert.equal(r.skipped, true);
    assert.match(r.reason, /^环境跳过：/, status + ' 要按环境跳过报告');
  }
  assert.match(decideNotesGate('denied').reason, /未授权自动化/);
});

test('note-cleanup 预检的目标是 System Events（脚本实际 tell 的是它，不是 Notes）', async () => {
  const seen = [];
  const r = await checkNotesAutomation({
    deps: { checkAutomationPermission: async (app) => { seen.push(app); return { status: 'granted' }; } },
  });
  assert.equal(r.allow, true);
  assert.deepEqual(seen, [{ bundleId: 'com.apple.systemevents' }]);
  assert.equal(SYSTEM_EVENTS_BUNDLE_ID, 'com.apple.systemevents');
});

test('note-cleanup 未授权：countNotes 返回 -1 且一条 AppleEvent 都不发', async () => {
  const r = await countNotes({ deps: { checkAutomationPermission: async () => ({ status: 'denied' }), ...DROP_ALL } });
  assert.equal(r, -1);
});

test('note-cleanup 未授权：deleteMarkedTestNotes 结构化 skipped，attempted=false', async () => {
  const r = await deleteMarkedTestNotes(3, {
    deps: { checkAutomationPermission: async () => ({ status: 'needs-consent' }), ...DROP_ALL },
  });
  assert.equal(r.removed, 0);
  assert.equal(r.readable, 0);
  assert.equal(r.attempted, false);
  assert.equal(r.skipped, true);
  assert.equal(r.permission, 'needs-consent');
  assert.match(r.reason, /^环境跳过：/);
});

test('note-cleanup 未授权：deleteTestNotes 返回 0，连 allowTopFallback 也不执行', async () => {
  let calls = 0;
  const r = await deleteTestNotes({
    count: 2,
    allowTopFallback: true,
    deps: {
      checkAutomationPermission: async () => ({ status: 'unknown' }),
      exec: async () => { calls += 1; return { stdout: '0' }; },
    },
  });
  assert.equal(r, 0);
  assert.equal(calls, 0, '未授权时不许发任何 AppleEvent（包括 top-fallback）');
});

test('note-cleanup 已授权：仍然走原逻辑（按标记删一次）', async () => {
  let calls = 0;
  const r = await deleteTestNotes({
    count: 2,
    deps: {
      checkAutomationPermission: granted,
      exec: async (bin, args) => { calls += 1; assert.equal(bin, '/usr/bin/osascript'); assert.ok(args.join(' ').includes('rowLabel')); return { stdout: 'removed=2 readable=7' }; },
    },
  });
  assert.equal(r, 2);
  assert.equal(calls, 1);
});

// ---------- sync-quit：退出路径的 300ms 兜底 ----------

test('sync-quit 授权判定：只有明确未授权才拦；timeout/unknown 放行但要带 warning', () => {
  const ok = decideQuitGate('granted');
  assert.equal(ok.allow, true);
  assert.equal(ok.warning, '');

  for (const status of ['denied', 'needs-consent']) {
    const r = decideQuitGate(status);
    assert.equal(r.allow, false, status + ' 不该发 AppleEvent');
    assert.equal(r.blocked, true);
  }
  for (const status of ['timeout', 'unknown', '']) {
    const r = decideQuitGate(status);
    assert.equal(r.allow, true, status + ' 退出路径不能卡住');
    assert.equal(r.uncertain, true);
    assert.match(r.warning, /不阻塞退出/);
  }
  assert.equal(PREFLIGHT_TIMEOUT_MS, 300);
});

function syncDeps({ permission = 'granted', advanceOnPreflightMs = 0 } = {}) {
  let clock = 1000;
  const calls = [];
  const deps = {
    now: () => clock,
    helperPath: () => '/fake/ae-permission',
    statSync: () => ({ uid: process.getuid(), mode: 0o755 }),
    execFileSync: (bin, args, opts) => {
      calls.push({ bin, args, opts });
      if (bin === '/fake/ae-permission') {
        clock += advanceOnPreflightMs;
        if (permission === 'denied') return '-1743\n';
        if (permission === 'needs-consent') return '-1744\n';
        if (permission === 'timeout') {
          throw Object.assign(new Error('spawnSync /fake/ae-permission ETIMEDOUT'), { code: 'ETIMEDOUT', signal: 'SIGTERM' });
        }
        if (permission === 'unknown') throw Object.assign(new Error('boom'), { code: 'EACCES' });
        return '0\n';
      }
      if (bin === '/usr/bin/osascript') { clock += 20; return ''; }
      if (bin === '/usr/bin/pgrep') { throw new Error('no such process'); } // 应用已退出
      if (bin === '/bin/sleep') { clock += Number(args[0]) * 1000; return ''; }
      return '';
    },
  };
  return { calls, deps, clock: () => clock };
}

test('sync-quit 预检：权限查询小程序的输出/异常 → 授权状态', () => {
  const grantedProbe = syncDeps({ permission: 'granted' });
  assert.deepEqual(checkAutomationPermissionSync('a.b', { deps: grantedProbe.deps }), { status: 'granted', code: 0 });

  const deniedProbe = syncDeps({ permission: 'denied' });
  assert.equal(checkAutomationPermissionSync('a.b', { deps: deniedProbe.deps }).status, 'denied');

  const timeoutProbe = syncDeps({ permission: 'timeout' });
  const timedOut = checkAutomationPermissionSync('a.b', { deps: timeoutProbe.deps });
  assert.equal(timedOut.status, 'timeout');
  assert.equal(timedOut.timedOut, true);

  const unknownProbe = syncDeps({ permission: 'unknown' });
  assert.equal(checkAutomationPermissionSync('a.b', { deps: unknownProbe.deps }).status, 'unknown');

  // 缺 bundleId：不许起进程
  const noBundle = syncDeps({});
  assert.equal(checkAutomationPermissionSync('', { deps: noBundle.deps }).status, 'unknown');
  assert.equal(noBundle.calls.length, 0);
});

test('sync-quit 预检：不可信的 helper 文件不执行', () => {
  let execCalls = 0;
  const r = checkAutomationPermissionSync('a.b', {
    deps: {
      helperPath: () => '/fake/ae-permission',
      statSync: () => ({ uid: process.getuid(), mode: 0o777 }), // 组/其他可写 → 不可信
      execFileSync: () => { execCalls += 1; return '0\n'; },
      now: () => 1000,
    },
  });
  assert.equal(r.status, 'unknown');
  assert.equal(execCalls, 0, '不可信的 helper 绝不许执行');
});

test('sync-quit 预检：预检超时（300ms 上限）也不阻塞，按原逻辑继续并发 warning', () => {
  const { calls, deps } = syncDeps({ permission: 'timeout' });
  const r = quitAppSync({ bundleId: 'com.apple.calculator', appName: '计算器', processName: 'Calculator' }, { deps, waitMs: 0 });

  const preflight = calls.find((c) => c.bin === '/fake/ae-permission');
  assert.ok(preflight, '必须先做预检');
  assert.ok(preflight.opts.timeout <= 300, '预检超时必须是 300ms 级：' + preflight.opts.timeout);
  const osascript = calls.find((c) => c.bin === '/usr/bin/osascript');
  assert.ok(osascript, '预检超时后必须继续走原有退出逻辑（绝不阻塞退出）');
  assert.equal(r.quit, true);
  assert.equal(r.mode, 'quit');
  assert.equal(r.permission, 'timeout');
  assert.match(r.warning, /不阻塞退出/);
});

test('sync-quit 明确未授权：不发 osascript，返回 automation-denied', () => {
  const { calls, deps } = syncDeps({ permission: 'denied' });
  const r = quitAppSync({ bundleId: 'com.apple.calculator', appName: '计算器', processName: 'Calculator' }, { deps });
  assert.equal(calls.filter((c) => c.bin === '/usr/bin/osascript').length, 0, '未授权不许发 AppleEvent');
  assert.equal(r.quit, false);
  assert.equal(r.mode, 'automation-denied');
  assert.equal(r.permission, 'denied');
});

test('sync-quit 已授权：正常发 osascript 并确认退出', () => {
  const { calls, deps } = syncDeps({ permission: 'granted' });
  const r = quitAppSync({ bundleId: 'com.apple.calculator', appName: '计算器', processName: 'Calculator' }, { deps, waitMs: 0 });
  assert.equal(calls.filter((c) => c.bin === '/usr/bin/osascript').length, 1);
  assert.equal(r.quit, true);
  assert.equal(r.mode, 'quit');
  assert.equal(r.permission, 'granted');
  assert.equal(r.warning, undefined);
});

test('sync-quit 预检吃掉的预算也要扣：预检后不够一次 AppleScript 就 budget-exhausted', () => {
  const { calls, deps } = syncDeps({ permission: 'granted', advanceOnPreflightMs: 250 });
  const r = quitAppSync({ bundleId: 'com.apple.calculator', appName: '计算器', processName: 'Calculator' }, { deps, budgetMs: 400 });
  assert.equal(r.mode, 'budget-exhausted');
  assert.equal(calls.filter((c) => c.bin === '/usr/bin/osascript').length, 0, '预算不够就不该再起 osascript');
});

test('sync-quit：显式 skipAutomationPreflight 时不预检（仅测试/特殊路径用）', () => {
  const { calls, deps } = syncDeps({ permission: 'denied' });
  const r = quitAppSync({ bundleId: 'a.b', processName: 'X' }, { deps, skipAutomationPreflight: true, waitMs: 0 });
  assert.equal(calls.filter((c) => c.bin === '/fake/ae-permission').length, 0);
  assert.equal(r.quit, true);
});

// ---------- cold-launch：整任务先预检 System Events ----------

test('cold-launch 授权判定：未授权/查不到 → 环境跳过；granted 才继续', () => {
  assert.equal(decideColdLaunchSkip('granted').allow, true);
  for (const status of ['denied', 'needs-consent', 'unknown', 'timeout']) {
    const r = decideColdLaunchSkip(status);
    assert.equal(r.allow, false, status);
    assert.match(r.reason, /^环境跳过：/);
  }
  assert.equal(SYSTEM_EVENTS_BUNDLE, 'com.apple.systemevents');
});

test('cold-launch 预检：注入假探测，不发送任何 AppleEvent', async () => {
  const seen = [];
  const denied = await preflightAutomation('com.apple.Notes', {
    deps: { checkAutomationPermission: async (app) => { seen.push(app); return { status: 'denied' }; } },
  });
  assert.equal(denied.allow, false);
  assert.match(denied.reason, /未授权自动化/);
  assert.deepEqual(seen, [{ bundleId: 'com.apple.Notes' }]);

  const ok = await preflightAutomation('com.apple.Notes', { deps: { checkAutomationPermission: granted } });
  assert.equal(ok.allow, true);
});

test('cold-launch 静态顺序：System Events 预检必须在第一个 frontName() 之前', () => {
  const src = fs.readFileSync(path.join(REPO, 'core/tasks/cold-launch.mjs'), 'utf8');
  const gateAt = src.indexOf('await preflightAutomation(SYSTEM_EVENTS_BUNDLE)');
  const frontAt = src.indexOf('const frontStart = await frontName()');
  assert.ok(gateAt >= 0, '缺少 System Events 预检');
  assert.ok(frontAt > 0, '找不到第一个 frontName()');
  assert.ok(gateAt < frontAt, '预检必须在第一个 AppleEvent（frontName）之前');
  // 退应用前也要预检
  const quitPreflightAt = src.indexOf('const gate = await preflightAutomation(app.bundle)');
  const quitOsaAt = src.indexOf("' to quit'");
  assert.ok(quitPreflightAt >= 0 && quitOsaAt > quitPreflightAt, 'quit 的预检必须在 osascript quit 之前');
});

test('note-cleanup 静态顺序：每个发 osascript 的函数里都有预检调用', () => {
  const src = fs.readFileSync(path.join(REPO, 'core/note-cleanup.mjs'), 'utf8');
  assert.ok(src.includes('checkNotesAutomation(opts)'), '缺少 Notes 自动化预检调用');
  assert.ok(src.includes("'/usr/bin/osascript'"), '脚本调用点还在（不应被误删）');
  const preflightCount = (src.match(/checkNotesAutomation\(opts\)/g) || []).length;
  assert.ok(preflightCount >= 3, 'countNotes / deleteTopNotes / deleteMarkedTestNotes 都应有预检，实际 ' + preflightCount);
});
