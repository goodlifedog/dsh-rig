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
  assert.equal(v.reason, '真实失败');
});

test('任务自报环境跳过优先采信', () => {
  const v = classifyRun(end(1) + '\n[!] 环境跳过：锁屏状态下无法校验');
  assert.equal(v.envSkip, true);
  assert.equal(v.reason, '任务自报环境跳过');
});

test('常见环境原因都能识别', () => {
  const cases = [
    ['FAIL: 目标应用当前就是前台，为避免干扰用户', '用户正在使用目标应用'],
    ['FAIL: Electron 宿主窗口没起来', 'Electron 宿主被占用或窗口读不到'],
    ['  FAIL  改成了指定关键词', '目标页面结构已变'],
    ['FAIL: 无法切回 BOSS 职位页：没有 BOSS 职位页标签', '用户 Chrome 里没开 BOSS 职位页'],
    ['FAIL: 读不到 Google Chrome 的界面树', '目标应用没运行或缺辅助功能权限'],
    ['FAIL: 锁屏中，跳过前台与窗口数校验', '锁屏'],
    ['FAIL: headless Chrome 还有 null 个窗口', '读不到窗口数（缺辅助功能权限）'],
    ['env: node: No such file or directory', '环境缺少可执行文件'],
    ['FAIL: 该岗位已联系过，跳过', '目标岗位已联系过'],
  ];
  for (const [text, expected] of cases) {
    assert.equal(envSkipReason(end(1) + '\n' + text), expected, text);
  }
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
