'use strict';
// H2：AppleEvent 预检 helper 的纯逻辑/分支测试。
// 全部注入假 checkAutomationPermission / 假 run，**绝不发真实 AppleEvent**、不碰 TCC。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SYSTEM_EVENTS_BUNDLE_ID,
  PREFLIGHT_TIMEOUT_MS,
  decideAutomationAllow,
  normalizeAutomationStatus,
  createAppleEventPreflight,
  runAppleEventGuarded,
  withTimeout,
} from '../core/appleevent-preflight.mjs';

const grantedCheck = async () => ({ status: 'granted' });
const statusCheck = (status) => async () => ({ status });

test('常量：System Events bundle id 与 800ms 预检超时', () => {
  assert.equal(SYSTEM_EVENTS_BUNDLE_ID, 'com.apple.systemevents');
  assert.equal(PREFLIGHT_TIMEOUT_MS, 800);
});

test('决定放行：只有 denied/needs-consent 跳过；unknown/超时仍尝试', () => {
  assert.equal(decideAutomationAllow('granted').allow, true);
  for (const status of ['denied', 'needs-consent']) {
    const r = decideAutomationAllow(status);
    assert.equal(r.allow, false, status + ' 必须跳过');
    assert.equal(r.skipped, true);
    assert.match(r.reason, /未授权/);
  }
  for (const status of ['unknown', 'timeout', 'app-not-running', 'error', '']) {
    const r = decideAutomationAllow(status);
    assert.equal(r.allow, true, status + ' 不能拦事件（探测抖动不该让还原失效）');
    assert.equal(r.skipped, false);
  }
});

test('状态归一：granted/denied/needs-consent/unknown', () => {
  assert.equal(normalizeAutomationStatus({ status: 'granted' }), 'granted');
  assert.equal(normalizeAutomationStatus({ status: 'denied' }), 'denied');
  assert.equal(normalizeAutomationStatus({ status: 'needs-consent' }), 'denied');
  assert.equal(normalizeAutomationStatus({ status: 'unknown' }), 'unknown');
  assert.equal(normalizeAutomationStatus(null), 'unknown');
});

test('预检 granted：放行，且调用 checkAutomationPermission 时 askUserIfNeeded=false', async () => {
  const calls = [];
  const preflight = createAppleEventPreflight({
    cacheMs: 0,
    checkAutomationPermission: async (app, options) => { calls.push({ app, options }); return { status: 'granted' }; },
  });
  const r = await preflight({ action: '读取前台' });
  assert.equal(r.allowed, true);
  assert.equal(r.status, 'granted');
  assert.deepEqual(calls, [{ app: { bundleId: 'com.apple.systemevents' }, options: { askUserIfNeeded: false } }]);
});

test('预检 denied / needs-consent：不放行并给 warning（不弹框路径）', async () => {
  for (const status of ['denied', 'needs-consent']) {
    const preflight = createAppleEventPreflight({ cacheMs: 0, checkAutomationPermission: statusCheck(status) });
    const r = await preflight({ action: '还原前台' });
    assert.equal(r.allowed, false);
    assert.equal(r.status, 'denied');
    assert.match(r.warning, /还原前台.*未授权/);
  }
});

test('预检抛错 / 超时：按 unknown 放行（仍然尝试），不抛到调用方', async () => {
  const throwing = createAppleEventPreflight({
    cacheMs: 0,
    checkAutomationPermission: async () => { throw new Error('boom'); },
  });
  const r1 = await throwing({ action: '读取前台' });
  assert.equal(r1.allowed, true);
  assert.equal(r1.status, 'unknown');
  assert.match(r1.error, /boom/);

  const hanging = createAppleEventPreflight({
    cacheMs: 0,
    timeoutMs: 20,
    checkAutomationPermission: () => new Promise(() => {}),
  });
  const started = Date.now();
  const r2 = await hanging({ action: '读取前台' });
  assert.equal(r2.allowed, true);
  assert.equal(r2.status, 'unknown');
  assert.ok(Date.now() - started < 500, '预检必须有短超时，不能卡住还原链路');
});

test('预检缓存：已得出结论的状态在 cacheMs 内复用；不同 bundle 不串', async () => {
  const seen = [];
  const preflight = createAppleEventPreflight({
    cacheMs: 5000,
    checkAutomationPermission: async (app) => { seen.push(app.bundleId); return { status: 'granted' }; },
  });
  assert.equal((await preflight({ action: 'a' })).allowed, true);
  assert.equal((await preflight({ action: 'b' })).allowed, true);
  assert.deepEqual(seen, ['com.apple.systemevents']);
  await preflight({ action: 'c', bundleId: 'com.apple.calculator' });
  assert.deepEqual(seen, ['com.apple.systemevents', 'com.apple.calculator']);
});

test('预检缓存可关闭：cacheMs=0 每次都探测', async () => {
  let n = 0;
  const preflight = createAppleEventPreflight({
    cacheMs: 0,
    checkAutomationPermission: async () => { n += 1; return { status: 'granted' }; },
  });
  await preflight({});
  await preflight({});
  assert.equal(n, 2);
});

test('runAppleEventGuarded：granted 走原逻辑并透传返回值', async () => {
  let ran = 0;
  const warnings = [];
  const r = await runAppleEventGuarded({
    action: '激活宿主',
    preflight: async () => ({ allowed: true, status: 'granted' }),
    run: () => { ran += 1; return 'ok'; },
    fallback: 'ERR',
    onWarning: (w) => warnings.push(w),
  });
  assert.equal(ran, 1);
  assert.deepEqual(r, { ran: true, allowed: true, status: 'granted', value: 'ok' });
  assert.deepEqual(warnings, []);
});

test('runAppleEventGuarded：denied 不执行 run、返回兜底并记 warning', async () => {
  let ran = 0;
  const warnings = [];
  const r = await runAppleEventGuarded({
    action: '激活宿主',
    preflight: async () => ({ allowed: false, status: 'denied', warning: '激活宿主：自动化未授权' }),
    run: () => { ran += 1; return true; },
    fallback: false,
    onWarning: (w) => warnings.push(w),
  });
  assert.equal(ran, 0, '未授权时绝不能发 AppleEvent');
  assert.equal(r.ran, false);
  assert.equal(r.allowed, false);
  assert.equal(r.value, false);
  assert.deepEqual(warnings, ['激活宿主：自动化未授权']);
});

test('runAppleEventGuarded：unknown / 预检抛错 仍然执行 run', async () => {
  let ran = 0;
  const unknown = await runAppleEventGuarded({
    preflight: async () => ({ allowed: true, status: 'unknown' }),
    run: () => { ran += 1; return 1; },
  });
  assert.equal(unknown.ran, true);
  assert.equal(ran, 1);

  const boom = await runAppleEventGuarded({
    preflight: async () => { throw new Error('probe boom'); },
    run: () => { ran += 1; return 2; },
  });
  assert.equal(boom.ran, true, '预检自己抛错也不能拦事件');
  assert.equal(boom.status, 'unknown');
  assert.equal(ran, 2);
});

test('runAppleEventGuarded：run 抛错返回兜底，不向上炸', async () => {
  const r = await runAppleEventGuarded({
    preflight: async () => ({ allowed: true, status: 'granted' }),
    run: () => { throw new Error('osascript failed'); },
    fallback: '',
  });
  assert.equal(r.ran, true);
  assert.equal(r.value, '');
  assert.match(r.error, /osascript failed/);
});

test('withTimeout：正常值透传，超时抛 preflight-timeout', async () => {
  assert.equal(await withTimeout(Promise.resolve(7), 50), 7);
  await assert.rejects(() => withTimeout(new Promise(() => {}), 20), /preflight-timeout/);
});
