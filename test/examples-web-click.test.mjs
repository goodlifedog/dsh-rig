'use strict';
// examples/web-click 集成测试：headless Chrome + CDP 按可见文字点按钮，全程不抢前台。
// Chrome 不可用 / headless 启动失败 → skip（不假绿）；断言失败 → 真失败。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  chromeAvailable,
  runWebClick,
  BUTTON_TEXT,
  EXPECTED_RESULT,
  INPUT_NAME,
} from '../examples/web-click/run.mjs';

test('examples/web-click：headless Chrome 按可见文字找按钮 → 后台点击 → 读回结果', {
  skip: !chromeAvailable() ? '本机没有 Chrome（CHROME_BIN 不存在）' : false,
}, async (t) => {
  const report = await runWebClick();

  if (report.envSkip) {
    t.skip(report.reason || '环境跳过：headless Chrome 不可用');
    return;
  }

  assert.equal(report.ok, true, '期望 PASS：' + JSON.stringify(report.error || report.result || {}));
  assert.equal(report.result.actual, EXPECTED_RESULT, '读回的结果文本');
  assert.equal(report.result.matched, true, 'waitFor 应在 5s 内匹配到结果');
  assert.equal(report.result.inputValue, INPUT_NAME, '输入框 value 应被 CDP 插入');
  assert.equal(report.result.pageTitle, 'examples/web-click fixture');

  const button = report.steps.find((s) => s.step === 'find-button-by-text');
  assert.ok(button, '应有按文字找按钮的步骤');
  assert.equal(button.text, BUTTON_TEXT, '按钮是按可见文字找到的');
  const click = report.steps.find((s) => s.step === 'background-click');
  assert.ok(click, '应有后台点击步骤');
  assert.equal(click.method, 'CDP Input.dispatchMouseEvent', '点击必须走 CDP Input 域');
  assert.ok(report.steps.some((s) => s.step === 'type-into-input' && s.value === INPUT_NAME));

  // 不抢前台：headless 无窗口，前后前台应用应一致（两端都读到才比较）
  assert.equal(report.front.unchanged, true, '前台不能被抢：' + JSON.stringify(report.front));
});
