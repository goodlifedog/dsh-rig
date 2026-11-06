'use strict';

/**
 * PowerShell 参数转义（纯函数，便于单测）。
 *
 * 背景：Windows 侧用 Get-Process / MainWindowTitle 反查窗口句柄时，标题来自
 * 外部（HTTP /window 的 title、或用户窗口名）。如果直接拼进双引号字符串，
 * 标题里的 $(...) 或 ` 会被 PowerShell 当命令执行 —— 这就是命令注入。
 * 单引号字符串里 PowerShell 只认「两个单引号表示一个单引号」，所以统一这样处理。
 */

function psQuote(text) {
  return "'" + String(text == null ? '' : text).replace(/'/g, "''") + "'";
}

/** -like 的通配匹配：把标题转义成单引号字符串，并加上前后通配符 */
function psLikeContains(text) {
  return "'*" + String(text == null ? '' : text).replace(/'/g, "''") + "*'";
}

/** 窗口句柄表达式：数字 → 0x 十六进制；已是 0x 形式或空则原样/空串 */
function hwndExpression(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return '';
  return '0x' + n.toString(16);
}

module.exports = { psQuote, psLikeContains, hwndExpression };
