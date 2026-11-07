'use strict';
// 等窗口 / 首启弹窗 / 自开自关：纯逻辑单测，不碰真实应用
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ensureAppRunning,
  waitForWindow,
  parseDialogDump,
  pickOnboardingButton,
  ONBOARDING_TEXT_RE,
  dismissOnboarding,
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
