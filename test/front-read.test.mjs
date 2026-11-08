'use strict';
// H2：前台读取改成 JXA+ObjC（不发 AppleEvent），失败/超时回退旧的 System Events 实现。
// 全部用注入的假 exec，绝不真实调用 osascript（unit 测试不能弹授权框、不能动屏幕）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  UNKNOWN_FRONT,
  OBJC_TIMEOUT_MS,
  APPLESCRIPT_TIMEOUT_MS,
  APPLESCRIPT_SOURCE,
  FRONT_READ_MODES,
  buildObjcScript,
  objcArgs,
  applescriptArgs,
  sanitizeFrontName,
  parseObjcOutput,
  parseAppleScriptOutput,
  resolveFrontReadMode,
  readViaObjc,
  readViaAppleScript,
  readFrontNameDetailed,
  readFrontName,
  compareReaders,
  isLockedFrontName,
  createObjcCircuitBreaker,
  resetObjcCircuitBreaker,
  OBJC_BREAKER_FAILURE_THRESHOLD,
  OBJC_BREAKER_OPEN_MS,
} from '../core/front-read.mjs';

const OBJC_OK = JSON.stringify({ name: 'Finder', localizedName: '访达', bundleId: 'com.apple.finder' });

/** 造一个假 exec：按 args[0] 区分 objc('-l') / applescript('-e') */
function fakeExec(handlers) {
  const calls = [];
  const exec = async (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const kind = args[0] === '-l' ? 'objc' : 'applescript';
    const handler = handlers[kind];
    if (typeof handler !== 'function') throw Object.assign(new Error('no handler for ' + kind), { code: 'ENOENT' });
    return handler({ cmd, args, opts });
  };
  exec.calls = calls;
  return exec;
}

const timeoutError = () => Object.assign(new Error('killed'), { killed: true, signal: 'SIGTERM' });

/** 每个 auto 用例用独立熔断器：避免「失败→熔断」状态跨用例污染 objc 调用次数断言 */
function freshBreaker() {
  return createObjcCircuitBreaker();
}

// ---------- 脚本构造（纯函数） ----------

test('buildObjcScript：走 NSWorkspace 读进程名，且完全不发 AppleEvent', () => {
  const script = buildObjcScript();
  assert.match(script, /ObjC\.import\('AppKit'\)/);
  assert.match(script, /NSWorkspace\.sharedWorkspace\.frontmostApplication/);
  assert.match(script, /executableURL/);
  assert.match(script, /lastPathComponent/);
  assert.doesNotMatch(script, /tell application/);
  assert.doesNotMatch(script, /System Events/);
});

test('objcArgs / applescriptArgs：命令行参数形状', () => {
  const objc = objcArgs();
  assert.deepEqual(objc.slice(0, 3), ['-l', 'JavaScript', '-e']);
  assert.equal(objc[3], buildObjcScript());
  assert.deepEqual(applescriptArgs(), ['-e', APPLESCRIPT_SOURCE]);
  assert.match(APPLESCRIPT_SOURCE, /System Events/);
});

test('常量：模式清单与两个超时（新实现 400ms 硬上限，旧实现保持 4s）', () => {
  assert.deepEqual(FRONT_READ_MODES, ['objc', 'applescript', 'auto']);
  assert.equal(OBJC_TIMEOUT_MS, 400);
  assert.equal(APPLESCRIPT_TIMEOUT_MS, 4000);
  assert.equal(UNKNOWN_FRONT, '(unknown)');
});

// ---------- 解析（纯函数） ----------

test('parseObjcOutput：成功解析，name 取进程名而不是本地化名', () => {
  const parsed = parseObjcOutput(OBJC_OK);
  assert.equal(parsed.name, 'Finder', '必须是进程名，不能是「访达」');
  assert.equal(parsed.localizedName, '访达');
  assert.equal(parsed.bundleId, 'com.apple.finder');
});

test('parseObjcOutput：空输出 / 坏 JSON / 缺名字 / 非对象 一律判不可用', () => {
  for (const bad of ['', '   ', 'not json', 'null', '[]', '"str"', '123', JSON.stringify({ name: '' }), JSON.stringify({ name: '   ' }), null, undefined]) {
    assert.equal(parseObjcOutput(bad), null, '应判不可用：' + JSON.stringify(bad));
  }
});

test('parseObjcOutput：名字里的换行/制表符被压平，控制字符/超长判不可用', () => {
  assert.equal(parseObjcOutput(JSON.stringify({ name: 'Google\nChrome' })).name, 'Google Chrome');
  assert.equal(parseObjcOutput(JSON.stringify({ name: '  Finder  ' })).name, 'Finder');
  assert.equal(parseObjcOutput(JSON.stringify({ name: 'Bad\u0000Name' })), null);
  assert.equal(parseObjcOutput(JSON.stringify({ name: 'x'.repeat(201) })), null);
});

test('parseAppleScriptOutput：去首尾空白/换行，空输出返回空串', () => {
  assert.equal(parseAppleScriptOutput('  Finder \n'), 'Finder');
  assert.equal(parseAppleScriptOutput(''), '');
  assert.equal(parseAppleScriptOutput(null), '');
  assert.equal(parseAppleScriptOutput('Bad\u0000Name'), '');
});

test('sanitizeFrontName：空白/控制字符/超长', () => {
  assert.equal(sanitizeFrontName('  a  '), 'a');
  assert.equal(sanitizeFrontName('a\nb'), 'a b');
  assert.equal(sanitizeFrontName(''), '');
  assert.equal(sanitizeFrontName(null), '');
  assert.equal(sanitizeFrontName('x'.repeat(200)), 'x'.repeat(200));
  assert.equal(sanitizeFrontName('x'.repeat(201)), '');
});

// ---------- 开关 ----------

test('resolveFrontReadMode：默认 auto，认三种取值，其余回退 auto', () => {
  assert.equal(resolveFrontReadMode({}), 'auto');
  assert.equal(resolveFrontReadMode({ AGENT_FRONT_READ: '' }), 'auto');
  assert.equal(resolveFrontReadMode({ AGENT_FRONT_READ: 'objc' }), 'objc');
  assert.equal(resolveFrontReadMode({ AGENT_FRONT_READ: '  APPLESCRIPT ' }), 'applescript');
  assert.equal(resolveFrontReadMode({ AGENT_FRONT_READ: 'auto' }), 'auto');
  assert.equal(resolveFrontReadMode({ AGENT_FRONT_READ: 'bogus' }), 'auto');
});

// ---------- 单实现 ----------

test('readViaObjc：成功 / 超时 / 输出不可解析', async () => {
  const ok = await readViaObjc({ exec: fakeExec({ objc: () => ({ stdout: OBJC_OK }) }) });
  assert.equal(ok.ok, true);
  assert.equal(ok.name, 'Finder');
  assert.equal(ok.error, '');

  const timedOut = await readViaObjc({ exec: fakeExec({ objc: () => { throw timeoutError(); } }) });
  assert.equal(timedOut.ok, false);
  assert.equal(timedOut.error, 'timeout');

  const garbage = await readViaObjc({ exec: fakeExec({ objc: () => ({ stdout: 'garbage' }) }) });
  assert.equal(garbage.ok, false);
  assert.equal(garbage.error, 'unparsable-output');
});

test('readViaObjc：400ms 超时上限传给了 exec', async () => {
  const exec = fakeExec({ objc: () => ({ stdout: OBJC_OK }) });
  await readViaObjc({ exec });
  assert.equal(exec.calls[0].opts.timeout, 400);
  assert.deepEqual(exec.calls[0].args.slice(0, 2), ['-l', 'JavaScript']);
  assert.equal(exec.calls[0].cmd, '/usr/bin/osascript');
});

test('readViaObjc：自定义超时可覆盖', async () => {
  const exec = fakeExec({ objc: () => ({ stdout: OBJC_OK }) });
  await readViaObjc({ exec, objcTimeoutMs: 250 });
  assert.equal(exec.calls[0].opts.timeout, 250);
});

test('readViaAppleScript：成功 / 空输出 / 超时，且用 4000ms 超时', async () => {
  const exec = fakeExec({ applescript: () => ({ stdout: 'Google Chrome\n' }) });
  const ok = await readViaAppleScript({ exec });
  assert.equal(ok.ok, true);
  assert.equal(ok.name, 'Google Chrome');
  assert.equal(exec.calls[0].opts.timeout, 4000);
  assert.deepEqual(exec.calls[0].args, ['-e', APPLESCRIPT_SOURCE]);

  const empty = await readViaAppleScript({ exec: fakeExec({ applescript: () => ({ stdout: '   ' }) }) });
  assert.equal(empty.ok, false);
  assert.equal(empty.error, 'empty-output');

  const timedOut = await readViaAppleScript({ exec: fakeExec({ applescript: () => { throw timeoutError(); } }) });
  assert.equal(timedOut.ok, false);
  assert.equal(timedOut.error, 'timeout');
});

// ---------- 组合：auto 快路径 + 回退 ----------

test('auto：新实现成功 → 直接用，不再跑旧实现（性能关键）', async () => {
  const exec = fakeExec({
    objc: () => ({ stdout: JSON.stringify({ name: 'Calculator', localizedName: '计算器', bundleId: 'com.apple.calculator' }) }),
    applescript: () => ({ stdout: 'Calculator\n' }),
  });
  const detail = await readFrontNameDetailed({ exec, mode: 'auto', breaker: freshBreaker() });
  assert.equal(detail.name, 'Calculator');
  assert.equal(detail.source, 'objc');
  assert.equal(detail.fallbackReason, '');
  assert.equal(exec.calls.length, 1, '成功时只该调用一次 osascript');
  assert.equal(exec.calls[0].args[0], '-l');
});

test('auto：新实现超时 → 回退旧实现，并说明原因', async () => {
  const exec = fakeExec({
    objc: () => { throw timeoutError(); },
    applescript: () => ({ stdout: 'Finder\n' }),
  });
  const detail = await readFrontNameDetailed({ exec, mode: 'auto', breaker: freshBreaker() });
  assert.equal(detail.name, 'Finder');
  assert.equal(detail.source, 'applescript');
  assert.equal(detail.fallbackReason, 'timeout');
  assert.equal(exec.calls.length, 2);
  assert.equal(exec.calls[1].args[0], '-e');
  assert.equal(exec.calls[1].opts.timeout, 4000);
});

test('auto：新实现输出不可解析 → 同样回退（绝不用可疑结果）', async () => {
  const exec = fakeExec({
    objc: () => ({ stdout: '{"name":""}' }),
    applescript: () => ({ stdout: 'Notes\n' }),
  });
  const detail = await readFrontNameDetailed({ exec, mode: 'auto', breaker: freshBreaker() });
  assert.equal(detail.name, 'Notes');
  assert.equal(detail.source, 'applescript');
  assert.equal(detail.fallbackReason, 'unparsable-output');
});

test('auto：两种都失败 → 空名字（调用方给 (unknown)），不抛', async () => {
  const exec = fakeExec({
    objc: () => { throw timeoutError(); },
    applescript: () => { throw Object.assign(new Error('nope'), { code: 'EACCES' }); },
  });
  const detail = await readFrontNameDetailed({ exec, mode: 'auto', breaker: freshBreaker() });
  assert.equal(detail.name, '');
  assert.equal(detail.source, '');
  assert.equal(detail.fallbackReason, 'timeout');
  assert.equal(await readFrontName({ exec, mode: 'auto' }), '');
});

test('mode=objc：只跑新实现，失败也不回退（排障用）', async () => {
  const exec = fakeExec({
    objc: () => { throw timeoutError(); },
    applescript: () => ({ stdout: 'Finder\n' }),
  });
  const detail = await readFrontNameDetailed({ exec, mode: 'objc' });
  assert.equal(detail.name, '');
  assert.equal(detail.source, '');
  assert.equal(exec.calls.length, 1);
  assert.equal(exec.calls[0].args[0], '-l');
});

test('mode=applescript：只跑旧实现（回滚开关）', async () => {
  const exec = fakeExec({
    objc: () => ({ stdout: OBJC_OK }),
    applescript: () => ({ stdout: 'Finder\n' }),
  });
  const detail = await readFrontNameDetailed({ exec, mode: 'applescript' });
  assert.equal(detail.name, 'Finder');
  assert.equal(detail.source, 'applescript');
  assert.equal(exec.calls.length, 1);
  assert.equal(exec.calls[0].args[0], '-e');
});

test('环境变量 AGENT_FRONT_READ 能切换实现', async () => {
  const exec = fakeExec({
    objc: () => ({ stdout: OBJC_OK }),
    applescript: () => ({ stdout: 'Finder\n' }),
  });
  const detail = await readFrontNameDetailed({ exec, env: { AGENT_FRONT_READ: 'applescript' } });
  assert.equal(detail.mode, 'applescript');
  assert.equal(exec.calls.length, 1);
  assert.equal(exec.calls[0].args[0], '-e');
});

test('exec 同步抛错也不崩（包装成失败，不向外抛）', async () => {
  const exec = () => { throw new Error('boom'); };
  const detail = await readFrontNameDetailed({ exec, mode: 'auto', breaker: freshBreaker() });
  assert.equal(detail.name, '');
  assert.equal(detail.fallbackReason, 'Error', '同步抛错也要被包成失败原因');
});

// ---------- 两种实现对比（自检用，只看假 exec 的逻辑） ----------

test('compareReaders：一致 / 不一致 / 时间戳', async () => {
  const sameExec = fakeExec({
    objc: () => ({ stdout: OBJC_OK }),
    applescript: () => ({ stdout: 'Finder\n' }),
  });
  const same = await compareReaders({ exec: sameExec });
  assert.equal(same.same, true);
  assert.equal(same.objcName, 'Finder');
  assert.equal(same.appleName, 'Finder');
  assert.equal(typeof same.objcMs, 'number');
  assert.equal(typeof same.appleMs, 'number');

  // 本地化名不同、但进程名相同 → 仍应判一致（这正是选 executableName 的原因）
  const localizedExec = fakeExec({
    objc: () => ({ stdout: JSON.stringify({ name: 'Calculator', localizedName: '计算器' }) }),
    applescript: () => ({ stdout: 'Calculator\n' }),
  });
  const localized = await compareReaders({ exec: localizedExec });
  assert.equal(localized.same, true, '进程名一致时应当相同');

  const mismatchExec = fakeExec({
    objc: () => ({ stdout: JSON.stringify({ name: 'Finder', localizedName: '访达' }) }),
    applescript: () => ({ stdout: '访达\n' }),
  });
  const mismatch = await compareReaders({ exec: mismatchExec });
  assert.equal(mismatch.same, false, '名字字面不一致要如实报出来');
});

// ---------- 锁屏占位名（loginwindow）：auto 必须回退老实现取真实前台 ----------

test('isLockedFrontName：只认 loginwindow（大小写/空白不敏感）', () => {
  assert.equal(isLockedFrontName('loginwindow'), true);
  assert.equal(isLockedFrontName('LoginWindow'), true);
  assert.equal(isLockedFrontName('  loginwindow '), true);
  assert.equal(isLockedFrontName('Finder'), false);
  assert.equal(isLockedFrontName('DeepSeek Harness'), false);
  assert.equal(isLockedFrontName(''), false);
  assert.equal(isLockedFrontName(null), false);
});

test('auto：ObjC 报 loginwindow（锁屏）→ 回退老实现，返回真实前台而不是占位名', async () => {
  const exec = fakeExec({
    objc: () => ({ stdout: JSON.stringify({ name: 'loginwindow', localizedName: '登录窗口', bundleId: '' }) }),
    applescript: () => ({ stdout: 'DeepSeek Harness\n' }),
  });
  const detail = await readFrontNameDetailed({ mode: 'auto', exec, breaker: freshBreaker() });
  assert.equal(detail.name, 'DeepSeek Harness', '锁屏时必须返回真实前台应用');
  assert.equal(detail.source, 'applescript');
  assert.equal(detail.fallbackReason, 'locked-front');
  assert.equal(exec.calls.length, 2, '先 objc 后 applescript 各一次');
});

test('mode=objc：loginwindow 原样返回（排障用，不触发回退）', async () => {
  const exec = fakeExec({
    objc: () => ({ stdout: JSON.stringify({ name: 'loginwindow' }) }),
    applescript: () => ({ stdout: 'DeepSeek Harness\n' }),
  });
  const detail = await readFrontNameDetailed({ mode: 'objc', exec });
  assert.equal(detail.name, 'loginwindow');
  assert.equal(detail.source, 'objc');
  assert.equal(detail.fallbackReason, 'locked-front-diagnostic');
  assert.equal(exec.calls.length, 1, '排障模式不该跑老实现');
});

// ---------- 实机自检（默认跳过：会真的跑 osascript，只能在你确认已授权时手动开） ----------

test('实机自检：auto 入口的结果必须与老实现一致（FRONT_READ_LIVE=1 才跑）', { skip: process.env.FRONT_READ_LIVE !== '1' }, async () => {
  const results = [];
  for (let i = 0; i < 20; i += 1) {
    const auto = await readFrontNameDetailed({ mode: 'auto' });
    const apple = await readViaAppleScript();
    results.push({ auto, apple });
  }
  const appleFail = results.filter((r) => !r.apple.ok).length;
  assert.ok(appleFail === 0, '旧实现不应失败：' + JSON.stringify(results.find((r) => !r.apple.ok) || {}));
  // 锁屏时 raw objc 会报 loginwindow（占位名），auto 必须已经回退成老实现的结果；
  // 解锁时 auto 直接走 objc，也应该与老实现同名。两种情况都要求名字一致。
  for (const r of results) {
    assert.equal(r.auto.name, r.apple.name, 'auto 结果必须与老实现一致（auto=' + r.auto.name + ' apple=' + r.apple.name + ' fallback=' + r.auto.fallbackReason + '）');
  }
});

// ---------- M4：objc 连续失败熔断（fake now，不缓存前台结果） ----------

test('熔断器：连续失败 3 次进入 60s 打开态，窗口后半开放行', () => {
  let t = 1000000;
  const b = createObjcCircuitBreaker({ now: () => t });
  assert.equal(OBJC_BREAKER_FAILURE_THRESHOLD, 3);
  assert.equal(OBJC_BREAKER_OPEN_MS, 60000);
  b.recordFailure();
  b.recordFailure();
  assert.equal(b.shouldAttempt(), true, '2 次失败不熔断');
  assert.equal(b.status().failures, 2);
  b.recordFailure();
  assert.equal(b.shouldAttempt(), false, '第 3 次失败后进入熔断');
  assert.equal(b.status().open, true);
  t += 59999;
  assert.equal(b.shouldAttempt(), false, '60s 内不再试 objc');
  t += 1;
  assert.equal(b.shouldAttempt(), true, '60s 后放一次（半开）');
  assert.equal(b.status().failures, 0);
});

test('熔断器：成功一次即复位；阈值/时长可配置', () => {
  let t = 0;
  const b = createObjcCircuitBreaker({ now: () => t, failureThreshold: 2, openMs: 1000 });
  b.recordFailure();
  b.recordFailure();
  assert.equal(b.shouldAttempt(), false);
  t += 1000;
  b.shouldAttempt();
  assert.equal(b.status().failures, 0);
  b.recordFailure();
  b.recordSuccess();
  b.recordFailure();
  assert.equal(b.shouldAttempt(), true, '成功复位后 1 次失败不熔断');
});

test('auto：连续 3 次 objc 失败后第 4 次不再调 objc，直接 applescript（熔断生效）', async () => {
  let t = 0;
  const breaker = createObjcCircuitBreaker({ now: () => t });
  let objcCalls = 0;
  let appleCalls = 0;
  const exec = async (cmd, args) => {
    if (args[0] === '-l') {
      objcCalls += 1;
      throw timeoutError();
    }
    appleCalls += 1;
    return { stdout: 'Finder\n' };
  };
  for (let i = 0; i < 3; i += 1) {
    const d = await readFrontNameDetailed({ mode: 'auto', exec, breaker });
    assert.equal(d.fallbackReason, 'timeout');
    assert.equal(d.objcSkipped, false);
  }
  assert.equal(objcCalls, 3);
  assert.equal(appleCalls, 3);
  const skipped = await readFrontNameDetailed({ mode: 'auto', exec, breaker });
  assert.equal(objcCalls, 3, '第 4 次不能再调 objc');
  assert.equal(appleCalls, 4);
  assert.equal(skipped.name, 'Finder');
  assert.equal(skipped.source, 'applescript');
  assert.equal(skipped.fallbackReason, 'objc-circuit-open');
  assert.equal(skipped.objcSkipped, true);
});

test('auto：熔断 60s 后恢复尝试 objc，成功一次复位', async () => {
  let t = 5000;
  const breaker = createObjcCircuitBreaker({ now: () => t });
  let objcCalls = 0;
  let objcHealthy = false;
  const exec = async (cmd, args) => {
    if (args[0] === '-l') {
      objcCalls += 1;
      if (!objcHealthy) throw new Error('jxa broken');
      return { stdout: OBJC_OK };
    }
    return { stdout: 'Finder\n' };
  };
  for (let i = 0; i < 3; i += 1) await readFrontNameDetailed({ mode: 'auto', exec, breaker });
  assert.equal(breaker.status().open, true);
  assert.equal(objcCalls, 3);
  t += 60000;
  objcHealthy = true;
  const recovered = await readFrontNameDetailed({ mode: 'auto', exec, breaker });
  assert.equal(objcCalls, 4, '窗口结束后应重新尝试 objc');
  assert.equal(recovered.source, 'objc');
  assert.equal(recovered.name, 'Finder');
  assert.equal(breaker.status().failures, 0, '成功一次复位');
});

test('mode=objc 不受熔断影响（三档语义不变）', async () => {
  const breaker = createObjcCircuitBreaker();
  breaker.recordFailure();
  breaker.recordFailure();
  breaker.recordFailure();
  assert.equal(breaker.shouldAttempt(), false);
  let objcCalls = 0;
  const exec = async (cmd, args) => {
    if (args[0] === '-l') {
      objcCalls += 1;
      return { stdout: OBJC_OK };
    }
    throw new Error('不该跑 applescript');
  };
  const detail = await readFrontNameDetailed({ mode: 'objc', exec, breaker });
  assert.equal(objcCalls, 1, '排障模式必须仍然试 objc');
  assert.equal(detail.source, 'objc');
});

test('熔断打开时 applescript 也失败：返回空名字不抛异常', async () => {
  const breaker = createObjcCircuitBreaker();
  breaker.recordFailure();
  breaker.recordFailure();
  breaker.recordFailure();
  const exec = async () => { throw new Error('all broken'); };
  const detail = await readFrontNameDetailed({ mode: 'auto', exec, breaker });
  assert.equal(detail.name, '');
  assert.equal(detail.fallbackReason, 'objc-circuit-open');
  resetObjcCircuitBreaker();
});
