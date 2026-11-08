'use strict';
/**
 * 终端类验证的写入判定（纯函数）。
 *
 * 为什么需要：terminal-control 会往用户的终端里敲 "echo 标记" 并回车。
 * 如果用户正在终端里输入一半命令（或终端就在前台），这串文字会拼到他的命令上，
 * 回车一按就把他没写完的命令提前执行了——这属于会出事的那类操作。
 *
 * 所以写入前必须有正面证据：
 *   1) 终端不在前台（用户没正在里面打字）
 *   2) 键鼠最近没动过（HID 空闲足够长）
 *   3) 终端缓冲区最后一行看起来是"空提示符"（不是用户已输入的半截命令）
 *   4) 这个应用不在前台风险名单里（读它就会抢前台，干脆不碰）
 * 任何一条不满足都跳过，宁可少验一项，也不去动用户正在用的终端。
 */

/** 空提示符常见的结尾符号（zsh/bash/starship/fish 等） */
const PROMPT_END_RE = /(?:[$%#❯➜〉>→])\s*$|^[❯➜→]\s.*[)\]]\s*$/;

/** 取缓冲区最后一条非空行（去掉行尾空白） */
export function lastNonEmptyLine(text) {
  const lines = String(text || '').split('\n').map((l) => l.replace(/\s+$/, ''));
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (lines[i].trim()) return lines[i];
  }
  return '';
}

/** 这一行像不像"刚显示提示符、还没输入命令" */
export function looksLikeEmptyPrompt(line) {
  const text = String(line || '').trim();
  if (!text) return false;
  if (text.length > 200) return false;
  return PROMPT_END_RE.test(text);
}

/**
 * @param {{app:string, frontApp?:string, hidIdleMs?:number, riskSkip?:boolean, lastLine?:string}} input
 * @returns {{ok:boolean, reason:string}}
 */
export function decideTerminalType(input = {}) {
  const { app = '', frontApp = '', hidIdleMs: idle = -1, riskSkip = false, lastLine = '' } = input || {};
  if (!app) return { ok: false, reason: '没有目标终端应用' };
  if (riskSkip) return { ok: false, reason: '该终端读取会抢前台（前台风险名单），不碰' };
  if (frontApp && frontApp === app) return { ok: false, reason: '终端当前就是前台，你正在里面操作，跳过' };
  if (Number.isFinite(idle) && idle >= 0 && idle < 60000) {
    return { ok: false, reason: '键鼠刚动过（' + Math.round(idle / 1000) + ' 秒前），你可能正在终端里打字，跳过' };
  }
  if (!lastLine) {
    return { ok: false, reason: '读不到终端缓冲区，无法确认提示符是空的，跳过' };
  }
  if (!looksLikeEmptyPrompt(lastLine)) {
    return { ok: false, reason: '终端最后一行不像空提示符（可能已有半截命令），跳过：' + lastLine.slice(0, 60) };
  }
  return { ok: true, reason: '' };
}
