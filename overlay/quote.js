'use strict';

/**
 * AppleScript 字符串字面量转义（纯函数，便于单测）。
 *
 * osascript -e 的脚本是字符串拼接出来的：进程名/标题里出现双引号或反斜杠
 * 会让脚本语法错乱（严重时能改变语句结构）。统一走这里转义。
 */

function appleScriptQuote(text) {
  const raw = String(text == null ? '' : text);
  // AppleScript 2.0 支持 \n / \r / \t / \" / \\ 转义。
  // 先转义反斜杠和双引号，再把换行等控制字符转成转义序列：
  // 变量里即使带换行，也不会把 osascript -e 的脚本截断成两条语句。
  const escaped = raw
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t');
  return '"' + escaped + '"';
}

module.exports = { appleScriptQuote };
