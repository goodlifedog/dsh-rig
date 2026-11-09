'use strict';
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyRun, isFailedRun, envSkipReason, classifyPermissionText, classifySelfTest } from '../core/run-classify.mjs';

const end = (code) => '{"event":"end","code":' + code + ',"durationMs":1200}';

test('没失败就不算失败', () => {
  assert.equal(isFailedRun(end(0)), false);
  assert.deepEqual(classifyRun(end(0)), { failed: false, envSkip: false, reason: '' });
  assert.deepEqual(classifyRun('什么也没发生'), { failed: false, envSkip: false, reason: '' });
});

test('普通失败算真实失败', () => {
  const v = classifyRun(end(1) + '\nFAIL: 断言不成立');
  assert.equal(v.failed, true);
  assert.equal(v.envSkip, false);
  assert.match(v.reason, /真实失败/);
});

test('任务自报环境跳过优先采信', () => {
  const v = classifyRun(end(1) + '\n[!] 环境跳过：锁屏状态下无法校验');
  assert.equal(v.envSkip, true);
  assert.equal(v.reason, '任务自报环境跳过');
});

test('常见环境原因都能识别（环境跳过只认显式声明/环境字样，不认 FAIL 断言）', () => {
  const cases = [
    ['跳过扫描：当前就是前台，为避免干扰用户', '用户正在使用目标应用'],
    ['cgWindowNotFound: Electron 宿主窗口没起来', 'Electron 宿主被占用或窗口读不到'],
    ['SKIP 读不到 Google Chrome 的界面树', '目标应用没运行或缺辅助功能权限'],
    ['SKIP 锁屏中，跳过前台与窗口数校验', '锁屏'],
    ['SKIP headless Chrome 还有 null 个窗口', '读不到窗口数（缺辅助功能权限）'],
    ['env: node: No such file or directory', '环境缺少可执行文件'],
  ];
  for (const [text, expected] of cases) {
    assert.equal(envSkipReason(end(1) + '\n' + text), expected, text);
  }
});

test('form-fill 的 FAIL 断言不能被「页面结构已变」豁免（评审复现的假绿）', () => {
  const text = [
    end(1),
    '--- 验收 ---',
    '  PASS  搜索框定位成功',
    '  FAIL  改成了指定关键词',
    '  PASS  已恢复原值',
    '结果: 存在失败项',
  ].join('\n');
  assert.equal(envSkipReason(text), '', '有 FAIL 就不是环境跳过');
  const v = classifyRun(text);
  assert.equal(v.failed, true);
  assert.equal(v.envSkip, false, '断言失败必须算真实失败');
});

test('PASS/FAIL 两套前缀的任务：FAIL 与「存在失败项」都按真实失败处理', () => {
  for (const text of [
    end(1) + '\n  PASS  第一步\n  FAIL  第二步',
    end(1) + '\n结果: 存在失败项',
  ]) {
    assert.equal(envSkipReason(text), '', text);
    assert.equal(classifyRun(text).envSkip, false, text);
  }
  // 只有 PASS/全通过时不算失败
  assert.equal(isFailedRun(end(0)), false);
  assert.deepEqual(classifyRun(end(0) + '\n  PASS  第一步\n结果: 全部通过'), { failed: false, envSkip: false, reason: '' });
});

test('成功运行里出现环境字样也不算失败', () => {
  const v = classifyRun(end(0) + '\n环境跳过：这次没做任何操作');
  assert.equal(v.failed, false);
  assert.equal(v.envSkip, false);
});
test('真失败不能被当成环境跳过（负向用例）', () => {
  const cases = [
    'spawn /wrong/path/ocu ENOENT No such file or directory',
    'FAIL: 提交未送达 3 条，已发送 3 条',
    'FAIL: 已联系再次提交，未送达',
    'FAIL: 依赖缺失 Cannot find module core/nope.mjs',
  ];
  for (const line of cases) {
    const v = classifyRun(end(1) + '\n' + line);
    assert.equal(v.failed, true, line + ' 应判为失败');
    assert.equal(v.envSkip, false, line + ' 不该算环境跳过');
  }
});
test('矩阵被抢前台要算真失败，不能当环境跳过', () => {
  const out = end(1) + '\n' + '- 前台：DeepSeek Harness -> Calculator（被抢占）\n汇总: {"ok":false,"readable":2,"clickable":1,"liveCapture":0,"total":2}';
  const v = classifyRun(out);
  assert.equal(v.failed, true);
  assert.equal(v.envSkip, false, '前台被抢是真问题，不能放行');
});
test('有 ❌ 的轮次不能被「环境跳过」整轮豁免', () => {
  const text = [
    end(1),
    '  ❌ 后台点击计算器按钮  7 → 7',
    '  SKIP 真实窗口回显  环境跳过：窗口状态=waiting',
  ].join('\n');
  const v = classifyRun(text);
  assert.equal(v.failed, true);
  assert.equal(v.envSkip, false, '有真实失败项时不该判成环境跳过');
  assert.match(v.reason, /❌/);
});

test('整轮都只是跳过时仍然算环境跳过', () => {
  const text = [end(1), '  SKIP 真实窗口回显  环境跳过：窗口状态=waiting'].join('\n');
  const v = classifyRun(text);
  assert.equal(v.envSkip, true);
});
test('envSkipReason（验收用的那个）也要挡住 ❌ 轮次', () => {
  const text = [
    '  ❌ 后台点击计算器按钮  7 → 7',
    '  SKIP 真实窗口回显  环境跳过：窗口状态=waiting',
  ].join('\n');
  assert.equal(envSkipReason(text), '', '有 ❌ 时不能返回跳过原因，否则验收会判 PASS');
});

test('envSkipReason 仍然认纯跳过的轮次', () => {
  assert.equal(envSkipReason('  SKIP 真实窗口回显  环境跳过：锁屏'), '任务自报环境跳过');
});
test('锁屏统一提示必须被出口分类认成「任务自报环境跳过」', async () => {
  const { lockedSkipNotice } = await import('../core/platform.mjs');
  const notice = lockedSkipNotice('background-control');
  assert.match(notice, /环境跳过/);
  assert.match(notice, /锁屏/);
  assert.equal(envSkipReason(notice), '任务自报环境跳过');
});
test('健康检查里的「锁屏状态 未锁屏」不能判成环境跳过（真实踩过：verify:safe 整步误报 SKIP）', () => {
  const healthLike = [
    '  ✅ 画面                               state=live',
    '  ✅ 锁屏状态                             未锁屏',
    '  ✅ 系统权限                             辅助功能 + 屏幕录制均已授权',
    '全部正常',
  ].join('\n');
  assert.equal(envSkipReason(healthLike), '');
});

test('「屏幕已锁」这类结论仍然算环境跳过', () => {
  assert.equal(envSkipReason('屏幕已锁，AX 不可用'), '锁屏');
  assert.equal(envSkipReason('环境跳过：屏幕已锁，稍后再跑'), '任务自报环境跳过');
});

// ---------- H4：权限类环境跳过 ----------

test('H4 权限文案（英文）：辅助功能 / 屏幕录制 / 自动化分别归类', () => {
  const cases = [
    ['Accessibility permission is required for this operation', '缺少辅助功能权限'],
    ['Screen Recording permission is required to capture windows', '缺少屏幕录制权限'],
    ['Not authorized to send Apple events to System Events.', '缺少自动化（Apple 事件）权限'],
    ['CGRequestScreenCaptureAccess() returned false', '缺少屏幕录制权限'],
    ['could not create image from window', '缺少屏幕录制权限'],
    ['unable to capture screen', '缺少屏幕录制权限'],
  ];
  for (const [text, expected] of cases) {
    assert.equal(classifyPermissionText(text), expected, text);
  }
});

test('H4 权限文案（中文 + AppleScript 状态码）：分别归类', () => {
  const cases = [
    ['没有辅助功能权限，无法读取界面树', '缺少辅助功能权限'],
    ['系统未授予屏幕录制权限', '缺少屏幕录制权限'],
    ['自动化权限缺失：不允许控制 System Events', '缺少自动化（Apple 事件）权限'],
    ['execution error: 不允许发送 Apple 事件 (-1743)', '缺少自动化（Apple 事件）权限'],
    ['System Events got an error: -1744', '缺少自动化（Apple 事件）权限'],
    ['errAEEventNotPermitted', '缺少自动化（Apple 事件）权限'],
    // 中文里「辅助功能」和否定词之间常有空格/冒号，不能只认连写「辅助功能权限」
    ['权限检查：辅助功能 未授权', '缺少辅助功能权限'],
    ['辅助功能未开启，先授权再来', '缺少辅助功能权限'],
  ];
  for (const [text, expected] of cases) {
    assert.equal(classifyPermissionText(text), expected, text);
  }
});

test('H4 健康状态行（已授权）不能被判成缺权限', () => {
  const granted = [
    '辅助功能 + 屏幕录制均已授权',
    '系统权限 辅助功能 + 屏幕录制均已授权',
    'accessibility granted, screen recording granted',
  ];
  for (const text of granted) assert.equal(classifyPermissionText(text), '', text);
});

test('环境跳过只认行首自报，健康统计行里的「其中 1 次环境跳过」不算', () => {
  const healthStats = [
    '  ✅ 最近任务失败数                          最近 1 次全部成功（上次：app-matrix 0s）｜其中 1 次环境跳过（未验证）',
    '  ✅ 任务耗时                             近 1 次：成功率 0%（已排除 1 次环境跳过）｜平均 45ms',
  ].join('\n');
  assert.equal(envSkipReason(healthStats), '', '健康统计行不能被判成整轮环境跳过');
  // 任务自己打印的（行首）仍然要认
  assert.equal(envSkipReason('  \n环境跳过：屏幕已锁，锁屏下 AX 不可用'), '任务自报环境跳过');
  assert.equal(envSkipReason('环境跳过'), '任务自报环境跳过');
  // 允许短前缀（验收输出常见「  SKIP xxx  环境跳过：…」）
  assert.equal(envSkipReason('  SKIP 真实窗口回显  环境跳过：窗口状态=waiting'), '任务自报环境跳过');
  assert.equal(envSkipReason('[!] 环境跳过：锁屏状态下无法校验'), '任务自报环境跳过');
  // 长句叙述不算（健康统计行）
  assert.equal(envSkipReason('任务耗时：近 1 次成功率 0%，已排除 1 次环境跳过，平均 45ms'), '');
});

test('H4 非权限文本必须仍返回空（不能吞掉真失败）', () => {
  const cases = [
    'AssertionError: expected 3 to equal 2',
    'FAIL: 改成了指定关键词',
    '参数错误：--count 必须是正数',
    "Cannot find module './core/missing.mjs'",
    'spawn /wrong/path/ocu ENOENT',
    'spawn /usr/bin/osascript ENOENT',
    'FAIL: 提交未送达 3 条',
    '结果: 存在失败项',
    '',
  ];
  for (const text of cases) {
    assert.equal(classifyPermissionText(text), '', JSON.stringify(text));
  }
});

test('H4 同一份日志里既有权限字样又有真实失败：权限聚合也要让位给真失败', () => {
  const mixed = 'Accessibility permission is required\n  FAIL  搜索框定位成功';
  assert.equal(classifyPermissionText(mixed), '', '有 FAIL 时不能判成权限环境跳过');
  assert.equal(envSkipReason(mixed), '', 'envSkipReason 同样保持真失败优先');
});

test('H4 envSkipReason 吃权限类失败：纯权限失败的运行算环境跳过', () => {
  const text = '{"event":"end","code":1,"durationMs":800}\n错误：Screen Recording permission is required';
  const v = classifyRun(text);
  assert.equal(v.failed, true);
  assert.equal(v.envSkip, true);
  assert.equal(v.reason, '缺少屏幕录制权限');
});

test('H4 任务自报「环境跳过」仍然优先于按文案推断的权限原因', () => {
  const text = '环境跳过：缺少屏幕录制权限，稍后重试';
  assert.equal(envSkipReason(text), '任务自报环境跳过');
});

// ---------- H5：daemon 自检三项分开 ----------

test('H5 classifySelfTest：三项全可用', () => {
  const r = classifySelfTest({ accessibility: true, automation: true, screenCapture: true, executable: '/opt/app/bin/node' });
  assert.equal(r.ok, true);
  assert.equal(r.allOk, true);
  assert.deepEqual(r.missing, []);
  assert.equal(r.hint, '');
  assert.deepEqual(r.names, { accessibility: '辅助功能', automation: '自动化', screenCapture: '屏幕录制' });
  for (const key of ['accessibility', 'automation', 'screenCapture']) {
    assert.equal(r.checks[key].ok, true);
    assert.equal(r.hints[key], '');
  }
});

test('H5 classifySelfTest：只有自动化缺失 → 提示指向自动化设置页，不指向辅助功能', () => {
  const r = classifySelfTest({ accessibility: true, automation: false, screenCapture: true, executable: '/opt/app/bin/node' });
  assert.equal(r.ok, false);
  assert.deepEqual(r.missing, ['automation']);
  assert.match(r.hint, /自动化/);
  assert.match(r.hint, /隐私与安全性 → 自动化/);
  assert.match(r.hint, /\/opt\/app\/bin\/node/);
  assert.doesNotMatch(r.hint, /辅助功能/);
  assert.equal(r.checks.accessibility.hint, '');
  assert.equal(r.checks.screenCapture.hint, '');
});

test('H5 classifySelfTest：三项都缺失 → 三条 hint 各自指向正确设置页', () => {
  const r = classifySelfTest({ accessibility: false, automation: false, screenCapture: false, executable: '/x/node' });
  assert.equal(r.ok, false);
  assert.deepEqual(r.missing, ['accessibility', 'automation', 'screenCapture']);
  assert.match(r.hints.accessibility, /隐私与安全性 → 辅助功能/);
  assert.match(r.hints.automation, /隐私与安全性 → 自动化/);
  assert.match(r.hints.screenCapture, /隐私与安全性 → 屏幕录制/);
  assert.match(r.hint, /辅助功能/);
  assert.match(r.hint, /自动化/);
  assert.match(r.hint, /屏幕录制/);
});
