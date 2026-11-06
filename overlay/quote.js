'use strict';

/**
 * AppleScript 字符串字面量转义（纯函数，便于单测）。
 *
 * osascript -e 的脚本是字符串拼接出来的：进程名/标题里出现双引号或反斜杠
 * 会让脚本语法错乱（严重时能改变语句结构）。统一走这里转义。
 */

function appleScriptQuote(text) {
  const raw = String(text == null ? '' : text);
  return '"' + raw.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

module.exports = { appleScriptQuote };
