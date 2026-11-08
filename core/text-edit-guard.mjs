'use strict';
/**
 * 文本编辑写入前的安全检查（纯逻辑 + 一段 AppleScript 采样）。
 *
 * 背景：background-control 任务会 set_value 到「文本编辑」的第一个 AXTextArea，
 * 而 set_value 是覆盖语义——用户开着有内容的文稿时，跑一次验收就把内容盖掉了（评审发现）。
 * 这里只做一件事：确认当前打开的文稿都是「我们自己的空文稿」，否则宁可跳过写入。
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

const SCRIPT = [
  'tell application "TextEdit"',
  '  set out to ""',
  '  repeat with d in documents',
  '    set out to out & (name of d) & tab & (length of text of d) & linefeed',
  '  end repeat',
  '  return out',
  'end tell',
].join('\n');

/** 解析「名字<TAB>长度」逐行输出；解析不出的行忽略 */
export function parseDocumentList(stdout) {
  const lines = String(stdout || '').split('\n');
  const docs = [];
  for (const line of lines) {
    const parts = line.split('\t');
    if (parts.length < 2) continue;
    const name = parts[0].trim();
    const len = Number(String(parts[1]).trim());
    if (!name && !Number.isFinite(len)) continue;
    docs.push({ name, length: Number.isFinite(len) ? len : NaN });
  }
  return docs;
}

const UNTITLED_RE = /^(未命名|未命名文稿|Untitled|Untitled \d+|无标题)(\s*\d+)?$/i;

/**
 * 是否允许写入：必须至少有一个文稿，且全部是「未命名 + 空内容」。
 * 任一条件是用户自己的文稿（有名字或非空）就判不安全——宁可跳过，也不覆盖用户内容。
 */
export function isSafeToWrite(docs) {
  const list = Array.isArray(docs) ? docs : [];
  if (!list.length) return { ok: false, reason: '没有打开的文稿' };
  for (const d of list) {
    if (!UNTITLED_RE.test(String(d.name || ''))) {
      return { ok: false, reason: '有命名文稿（' + d.name + '）' };
    }
    if (Number(d.length) !== 0) {
      return { ok: false, reason: '文稿里已有内容（' + d.length + ' 字符）' };
    }
  }
  return { ok: true, reason: '' };
}

/** 采样当前文稿；TextEdit 没运行或读不到时返回 ok:false（调用方按跳过处理） */
export async function checkTextEditWritable(options = {}) {
  const run = (options && options.exec) || exec;
  try {
    const { stdout } = await run('/usr/bin/osascript', ['-e', SCRIPT], { timeout: 5000 });
    return isSafeToWrite(parseDocumentList(stdout));
  } catch (error) {
    return { ok: false, reason: '读不到文稿状态（' + String((error && error.message) || error).slice(0, 60) + '）' };
  }
}
/** 我们测试写入的正文格式：带显式标记，或"后台写入：<时间>" / "后台控制验证…" 这类开头 */
export const OUR_TEST_TEXT_RE = /^\s*(?:\[\s*AGENT-TEST\s*\]|后台写入[:：]\s*\d|后台控制验证[:：])/;

/**
 * 清理时「这个文稿能不能直接关掉（saving no）」的判定。
 *
 * 原来的判定只要求正文里出现"后台测试/后台写入"这类词就关——用户自己的未命名草稿里
 * 只要引用了这些词（比如从对话里粘贴一段），就会被 saving no 直接丢掉，属于数据丢失。
 * 现在要求两个条件同时成立：
 *   1) 文稿必须未命名（有名字的是用户存的稿子，一律不碰）
 *   2) 正文必须是我们测试写的格式（开头是标记或带时间的固定句式），不是随便包含关键词
 *
 * @param {{name?:string, text?:string}} doc
 * @returns {{ok:boolean, reason:string}}
 */
export function isDisposableTestDocument(doc) {
  const name = String((doc && doc.name) || '').trim();
  const text = String((doc && doc.text) || '');
  if (!name || !UNTITLED_RE.test(name)) {
    return { ok: false, reason: name ? '有命名文稿（' + name + '），不动' : '读不到文稿名，不动' };
  }
  if (!text.trim()) return { ok: false, reason: '未命名空文稿，可能是用户刚打开的，不关' };
  if (!OUR_TEST_TEXT_RE.test(text)) return { ok: false, reason: '正文不是测试格式（只是包含关键词），不动' };
  return { ok: true, reason: '' };
}
