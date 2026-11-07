'use strict';
// 等窗口 / 首启弹窗 / 自开自关：纯逻辑单测，不碰真实应用
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ensureAppRunning,
  ensureAppWindow,
  launchFlags,
  waitForWindow,
  parseDialogDump,
  pickOnboardingButton,
  ONBOARDING_TEXT_RE,
  dismissOnboarding,
  quitApp,
  windowCount,
} from '../core/background.mjs';

test('窗口已经在：立即返回，不睡眠', async () => {
  let slept = 0;
  const r = await waitForWindow('抖音', {
    timeoutMs: 5000,
    deps: { count: async () => 2, sleep: async () => { slept += 1; } },
  });
  assert.equal(r.ok, true);
  assert.equal(r.windows, 2);
  assert.equal(r.attempts, 1);
  assert.equal(slept, 0, '第一次就拿到窗口，不该再等');
});

test('窗口迟到：轮询到出现为止', async () => {
  let n = 0;
  const r = await waitForWindow('Steam', {
    timeoutMs: 5000,
    deps: { count: async () => { n += 1; return n < 3 ? 0 : 1; }, sleep: async () => {} },
  });
  assert.equal(r.ok, true);
  assert.equal(r.attempts, 3);
  assert.equal(r.windows, 1);
});

test('一直没窗口：超时返回 ok=false，但不算抛错', async () => {
  const r = await waitForWindow('Antigravity', {
    timeoutMs: 0,
    deps: { count: async () => 0, sleep: async () => {} },
  });
  assert.equal(r.ok, false);
  assert.equal(r.windows, 0);
});

test('查不到窗口数（-1）也按没窗口处理，不把 -1 当成功', async () => {
  const r = await waitForWindow('X', { timeoutMs: 0, deps: { count: async () => -1, sleep: async () => {} } });
  assert.equal(r.ok, false);
  assert.equal(r.windows, 0);
});

test('解析弹窗结构文本', () => {
  const dump = [
    'WIN|',
    'IDX|1',
    'TXT|欢迎使用 Pages 文稿',
    'TXT|先看看新功能',
    'BTN|继续',
    'BTN|了解更多',
    'WIN|',
    'IDX|2',
    'TXT|要存储吗',
    'BTN|存储',
    'BTN|不存储',
  ].join('\n');
  const list = parseDialogDump(dump);
  assert.equal(list.length, 2);
  assert.equal(list[0].index, 1);
  assert.deepEqual(list[0].buttons, ['继续', '了解更多']);
  assert.equal(list[1].index, 2);
  assert.ok(list[0].texts[0].includes('欢迎使用'));
});

test('解析时忽略空行和坏行', () => {
  assert.deepEqual(parseDialogDump(''), []);
  assert.deepEqual(parseDialogDump('\n\n'), []);
  assert.deepEqual(parseDialogDump('随便一行没有分隔符'), []);
});

test('引导按钮只挑白名单里的', () => {
  assert.equal(pickOnboardingButton(['继续']), '继续');
  assert.equal(pickOnboardingButton(['了解更多', 'Continue']), 'Continue');
  assert.equal(pickOnboardingButton(['Next']), 'Next');
  assert.equal(pickOnboardingButton(['存储', '不存储', '取消']), null, '破坏性按钮一个都不能挑');
});

test('引导文案特征只匹配欢迎/更新，正常的保存确认不算', () => {
  assert.ok(ONBOARDING_TEXT_RE.test('欢迎使用 Pages 文稿'));
  assert.ok(ONBOARDING_TEXT_RE.test("What's New in Slack"));
  assert.ok(!ONBOARDING_TEXT_RE.test('你有3个未命名的文稿，要在退出前复查吗'));
});

test('弹窗没有白名单按钮：宁可不点', async () => {
  let clicked = 0;
  const r = await dismissOnboarding('某应用', {
    deps: {
      frontName: async () => 'DSH',
      settleFront: async () => ({ stolen: false, restores: 0, finalFront: 'DSH' }),
      dialogs: async () => [{ index: 1, title: '', texts: ['欢迎使用'], buttons: ['删除并退出', '取消'] }],
      exec: async () => { clicked += 1; return {}; },
    },
  });
  assert.equal(r.dismissed, false);
  assert.equal(clicked, 0, '没白名单按钮时不许点');
});

test('弹窗有白名单按钮：点掉并复查前台', async () => {
  const calls = [];
  const r = await dismissOnboarding('Pages Creator Studio', {
    deps: {
      frontName: async () => 'DSH',
      settleFront: async (expect) => { calls.push(expect); return { stolen: false, restores: 0, finalFront: 'DSH' }; },
      dialogs: async () => [{ index: 1, title: '', texts: ['欢迎使用 Pages 文稿'], buttons: ['继续', '了解更多'] }],
      exec: async (bin, args) => { calls.push(args.join(' ')); return {}; },
    },
  });
  assert.equal(r.dismissed, true);
  assert.equal(r.button, '继续');
  assert.ok(calls.some((c) => c.includes('click button') && c.includes('继续')), '要按名字点，不能按序号瞎点');
  assert.ok(calls.some((c) => c === 'DSH'), '点完要复查前台');
});
test('慢启动应用：等够时间才判定成功（Keynote/腾讯会议实测 5s+）', async () => {
  let checks = 0;
  const r = await ensureAppRunning(
    { bundleId: 'com.apple.Keynote', appName: 'Keynote Creator Studio', processName: 'Keynote' },
    {
      waitMs: 2000,
      deps: {
        frontName: async () => 'DSH',
        isAppRunning: async () => { checks += 1; return checks > 2; },
        sleep: async () => {},
        openApp: async () => {},
      },
    },
  );
  assert.equal(r.launched, true);
  assert.equal(r.running, true);
  assert.ok(checks >= 3, '要真的轮询到起来为止');
});

test('一直没起来：返回 error，但前台仍记为未变', async () => {
  const r = await ensureAppRunning(
    { bundleId: 'x.y', appName: 'X', processName: 'x' },
    {
      waitMs: 0,
      deps: {
        frontName: async () => 'DSH',
        isAppRunning: async () => false,
        sleep: async () => {},
        openApp: async () => {},
      },
    },
  );
  assert.equal(r.launched, false);
  assert.ok(r.error.length > 0);
  assert.equal(r.frontUnchanged, true);
});

test('已经在跑：直接返回，不再 open', async () => {
  let opened = 0;
  const r = await ensureAppRunning(
    { bundleId: 'a.b', appName: 'A', processName: 'a' },
    { deps: { frontName: async () => 'DSH', isAppRunning: async () => true, sleep: async () => {}, openApp: async () => { opened += 1; } } },
  );
  assert.equal(r.launched, false);
  assert.equal(r.running, true);
  assert.equal(opened, 0);
});
// ---------- ensureAppWindow：进程在、窗口没了怎么办 ----------

const APP = { bundleId: 'com.apple.TextEdit', appName: '文本编辑', processName: 'TextEdit' };

test('窗口本来就正常：不 open、不唤起，直接返回就绪', async () => {
  let opened = 0;
  const r = await ensureAppWindow(APP, {
    deps: {
      ensureAppRunning: async () => ({ launched: false, running: true }),
      waitForWindow: async () => ({ ok: true, windows: 2, attempts: 1, waitedMs: 0 }),
      openApp: async () => { opened += 1; },
      frontName: async () => 'DSH',
      sleep: async () => {},
    },
  });
  assert.equal(r.window, true);
  assert.equal(r.viaProbe, false);
  assert.equal(r.summoned, false);
  assert.equal(opened, 0, '有窗口就不该再 open，免得打扰应用');
  assert.equal(r.frontUnchanged, true);
});

test('系统窗口计数为 0 但 AX 界面树可读：按就绪处理（文本编辑实测状态）', async () => {
  let opened = 0;
  let probes = 0;
  const r = await ensureAppWindow(APP, {
    probe: async () => { probes += 1; return true; },
    deps: {
      ensureAppRunning: async () => ({ launched: true, running: true }),
      waitForWindow: async () => ({ ok: false, windows: 0, attempts: 5, waitedMs: 2500 }),
      openApp: async () => { opened += 1; },
      frontName: async () => 'DSH',
      sleep: async () => {},
    },
  });
  assert.equal(r.window, true);
  assert.equal(r.viaProbe, true, '要标出这是靠界面树判定的，报告不能含糊');
  assert.equal(opened, 0);
  assert.equal(probes, 1);
});

test('进程在但真没窗口：open 唤起一次，仍然没有就如实说没有', async () => {
  const opened = [];
  const r = await ensureAppWindow(APP, {
    windowMs: 6000,
    deps: {
      ensureAppRunning: async () => ({ launched: false, running: true }),
      waitForWindow: async () => ({ ok: false, windows: 0, attempts: 3, waitedMs: 10 }),
      openApp: async (args) => { opened.push(args.join(' ')); },
      frontName: async () => 'DSH',
      sleep: async () => {},
    },
  });
  assert.equal(r.window, false);
  assert.equal(r.summoned, true);
  assert.ok(r.error.includes('可读窗口'));
  assert.ok(opened.length >= 1, '应该试着唤起过');
  assert.equal(opened[0], '-b com.apple.TextEdit', '先按 bundle id 唤起，成功率高');
  assert.equal(r.front, 'DSH', '唤起过程不能抢前台');
});

test('唤起后窗口才出现：第二次等待就绪，不再报错', async () => {
  let calls = 0;
  const r = await ensureAppWindow(APP, {
    deps: {
      ensureAppRunning: async () => ({ launched: false, running: true }),
      waitForWindow: async () => { calls += 1; return calls === 1 ? { ok: false, windows: 0, attempts: 2, waitedMs: 10 } : { ok: true, windows: 1, attempts: 1, waitedMs: 400 }; },
      openApp: async () => {},
      frontName: async () => 'DSH',
      sleep: async () => {},
    },
  });
  assert.equal(r.window, true);
  assert.equal(r.summoned, true);
  assert.equal(calls, 2);
});

test('应用根本没起来：直接把启动失败传出去，不做窗口唤起', async () => {
  let opened = 0;
  const r = await ensureAppWindow(APP, {
    deps: {
      ensureAppRunning: async () => ({ launched: false, running: false, error: '启动后仍检测不到进程' }),
      waitForWindow: async () => ({ ok: false, windows: 0, attempts: 0, waitedMs: 0 }),
      openApp: async () => { opened += 1; },
      frontName: async () => 'DSH',
      sleep: async () => {},
    },
  });
  assert.equal(r.window, false);
  assert.equal(opened, 0);
  assert.ok(r.error.length > 0);
});

test('退出被「保存」弹窗挡住：绝不强杀，报 needs-confirm', async () => {
  const calls = [];
  const r = await quitApp(
    { appName: '文本编辑', processName: 'TextEdit' },
    {
      graceMs: 10,
      deps: {
        isAppRunning: async () => true,
        sleep: async () => {},
        dialogs: async () => [{ index: 1, title: '', texts: ['你有 3 个未命名的文稿'], buttons: ['存储', '不存储', '取消'] }],
        exec: async (bin, args) => { calls.push(args.join(' ')); return { stdout: '' }; },
      },
    },
  );
  assert.equal(r.quit, false);
  assert.equal(r.mode, 'needs-confirm');
  assert.ok(r.detail.includes('未强杀'));
  assert.ok(!calls.some((c) => c.includes('-TERM')), '有未保存弹窗时不许发 TERM');
  assert.ok(!calls.some((c) => c.includes('pgrep')), '连接进程都不该找');
});

test('没有弹窗：先优雅退出，退不掉再 TERM', async () => {
  let checks = 0;
  const calls = [];
  const r = await quitApp(
    { appName: 'Steam', processName: 'steam_osx' },
    {
      graceMs: 10,
      deps: {
        isAppRunning: async () => { checks += 1; return checks < 3; },
        sleep: async () => {},
        dialogs: async () => [],
        exec: async (bin, args) => {
          calls.push(bin + ' ' + args.join(' '));
          if (bin.includes('pgrep')) return { stdout: '4242\n' };
          if (bin.includes('/bin/ps')) return { stdout: '/Applications/Steam.app/Contents/MacOS/steam_osx\n' };
          return { stdout: '' };
        },
      },
    },
  );
  assert.equal(r.quit, true);
  assert.equal(r.mode, 'term');
  assert.ok(calls.some((c) => c.includes('/bin/kill') && c.includes('4242')), '要按 pid 发 TERM');
});

test('TERM 之后还在跑：如实报 still-running', async () => {
  const r = await quitApp(
    { appName: '某应用', processName: 'X' },
    {
      graceMs: 10,
      deps: {
        isAppRunning: async () => true,
        sleep: async () => {},
        dialogs: async () => [],
        exec: async (bin) => {
          if (bin.includes('pgrep')) return { stdout: '777\n' };
          if (bin.includes('/bin/ps')) return { stdout: '/Applications/X.app/Contents/MacOS/X\n' };
          return { stdout: '' };
        },
      },
    },
  );
  assert.equal(r.quit, false);
  assert.equal(r.mode, 'still-running');
});
test('窗口数：显示名查不到时用进程名兜底', async () => {
  const seen = [];
  const n = await windowCount('Keynote Creator Studio', {
    altNames: ['Keynote'],
    deps: {
      exec: async (bin, args) => {
        const script = args.join(' ');
        seen.push(script);
        if (script.includes('"Keynote Creator Studio"')) throw new Error('没有这个进程');
        return { stdout: '3' };
      },
    },
  });
  assert.equal(n, 3);
  assert.equal(seen.length, 2, '第一个名字失败后要试第二个');
});

test('窗口数：候选名都查不到才算 -1', async () => {
  const n = await windowCount('X', {
    altNames: ['Y'],
    deps: { exec: async () => { throw new Error('没有'); } },
  });
  assert.equal(n, -1);
});

test('退出保护：显示名查不到弹窗时，按进程名也要查到，绝不能漏掉保存提示', async () => {
  const calls = [];
  const r = await quitApp(
    { appName: 'Keynote Creator Studio', processName: 'Keynote' },
    {
      graceMs: 10,
      deps: {
        isAppRunning: async () => true,
        sleep: async () => {},
        // 显示名不是系统里的进程名，查不到；进程名才查得到
        dialogs: async (name) => (name === 'Keynote'
          ? [{ index: 1, title: '', texts: ['要存储对文稿的更改吗'], buttons: ['存储', '不存储'] }]
          : []),
        exec: async (bin, args) => { calls.push(bin + ' ' + args.join(' ')); return { stdout: '' }; },
      },
    },
  );
  assert.equal(r.mode, 'needs-confirm');
  assert.ok(r.detail.includes('未强杀'));
  assert.ok(!calls.some((c) => c.includes('-TERM')), '查到保存弹窗时不许发 TERM');
});
test('后台启动参数：默认隐藏窗口，AGENT_LAUNCH_HIDDEN=0 才正常显示', () => {
  assert.deepEqual(launchFlags({ env: {} }), ['-g', '-j']);
  assert.deepEqual(launchFlags({ env: { AGENT_LAUNCH_HIDDEN: '0' } }), ['-g']);
  assert.deepEqual(launchFlags({ env: { AGENT_LAUNCH_HIDDEN: '1' } }), ['-g', '-j']);
});
