'use strict';
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyRun, isFailedRun, envSkipReason } from '../core/run-classify.mjs';

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
    ['SKIP 无法切回 BOSS 职位页：没有 BOSS 职位页标签', '用户 Chrome 里没开 BOSS 职位页'],
    ['SKIP 读不到 Google Chrome 的界面树', '目标应用没运行或缺辅助功能权限'],
    ['SKIP 锁屏中，跳过前台与窗口数校验', '锁屏'],
    ['SKIP headless Chrome 还有 null 个窗口', '读不到窗口数（缺辅助功能权限）'],
    ['env: node: No such file or directory', '环境缺少可执行文件'],
    ['该岗位已联系过，跳过', '目标岗位已联系过'],
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
    'FAIL: 投递未送达 3 条，已发送 3 条',
    'FAIL: 已联系再次投递，未送达',
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
