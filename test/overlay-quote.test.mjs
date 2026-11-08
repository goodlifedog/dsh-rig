'use strict';
// L3 回归：overlay/platform.js 把变量拼进 AppleScript 时必须走 appleScriptQuote。
// 只测纯函数，不启动 overlay、不调用 osascript、不触发任何屏幕操作。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { appleScriptQuote } = require('../overlay/quote.js');

// 模拟 AppleScript 字面量约束：内部只允许 \" \\ \n \r \t 转义；
// 不允许未转义双引号或裸控制字符，否则 osascript -e 的脚本会被截断/改写。
function assertSingleLiteral(quoted) {
  assert.equal(typeof quoted, 'string');
  assert.ok(quoted.length >= 2, '至少要有两个引号');
  assert.equal(quoted[0], '"');
  assert.equal(quoted[quoted.length - 1], '"');

  const inner = quoted.slice(1, -1);
  let index = 0;
  while (index < inner.length) {
    const ch = inner[index];
    if (ch === '\\') {
      assert.ok(index + 1 < inner.length, '孤立反斜杠会吞掉结尾引号');
      const next = inner[index + 1];
      assert.ok('"\\nrt'.includes(next), '出现不允许的转义序列: \\' + next);
      index += 2;
      continue;
    }
    assert.notEqual(ch, '"', '存在未转义双引号，字符串会提前结束');
    assert.ok(ch !== '\n' && ch !== '\r' && ch !== '\t', '存在裸控制字符');
    index += 1;
  }
}

test('普通名称原样包成 AppleScript 字符串', () => {
  assert.equal(appleScriptQuote('DeepSeek Harness'), '"DeepSeek Harness"');
  assert.equal(appleScriptQuote('计算器'), '"计算器"');
  assertSingleLiteral(appleScriptQuote('DeepSeek Harness'));
});

test('Unicode 引号不做 ASCII 化，也不会截断字符串', () => {
  const name = '“双引号” ‘单引号’ 「角」 『角』 ＂全角＂';
  const quoted = appleScriptQuote(name);
  assert.equal(quoted, '"' + name + '"');
  assertSingleLiteral(quoted);
});

test('双引号被转义，不会截断字符串', () => {
  assert.equal(appleScriptQuote('a"b'), '"a\\"b"');
  assertSingleLiteral(appleScriptQuote('tell application "Finder"'));
});

test('反斜杠被转义', () => {
  assert.equal(appleScriptQuote('a\\b'), '"a\\\\b"');
  assertSingleLiteral(appleScriptQuote('C:\\Program Files\\App'));
});

test('反斜杠 + 引号组合不能提前闭合字面量', () => {
  const quoted = appleScriptQuote('foo\\"');
  assertSingleLiteral(quoted);
  assert.ok(quoted.endsWith('\\""'), '应以转义引号 + 闭合引号收尾');
});

test('恶意进程名（引号拼接 shell）不能逃出 AppleScript 字面量', () => {
  const name = 'Calculator" & (do shell script "touch /tmp/pwned") & "';
  const quoted = appleScriptQuote(name);
  assert.equal(quoted, '"Calculator\\" & (do shell script \\"touch /tmp/pwned\\") & \\""');
  assertSingleLiteral(quoted);
});

test('换行 / 回车 / 制表符转成转义序列，不会拆出第二条语句', () => {
  const name = 'line1\nline2\r\nline3\tend';
  const quoted = appleScriptQuote(name);
  assert.equal(quoted, '"line1\\nline2\\r\\nline3\\tend"');
  assertSingleLiteral(quoted);
  assert.ok(!quoted.includes('\n') && !quoted.includes('\r') && !quoted.includes('\t'));
});

test('空值/非字符串不会输出 null 或 undefined 字样', () => {
  assert.equal(appleScriptQuote(null), '""');
  assert.equal(appleScriptQuote(undefined), '""');
  assertSingleLiteral(appleScriptQuote(null));
});

test('拼进完整 AppleScript（platform.js 的 window 查询写法）后仍是一个字面量', () => {
  const name = 'Evil" & do shell script "id" & "';
  const quoted = appleScriptQuote(name);
  const script = 'tell application "System Events" to tell process ' + quoted
    + ' to get {position, size} of window 1';
  assert.ok(script.includes('to tell process ' + quoted + ' to get '), '进程名字面量必须完整出现在语句中');
  assertSingleLiteral(quoted);
});

test('数字转成字符串安全引用', () => {
  assert.equal(appleScriptQuote(123), '"123"');
  assertSingleLiteral(appleScriptQuote(123));
});
