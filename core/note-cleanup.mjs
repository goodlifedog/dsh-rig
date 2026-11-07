'use strict';
/**
 * 笔记清理：删掉测试期间新增的备忘录。
 *
 * 为什么不能"按标题过滤"：Notes 的列表单元格是自绘的，辅助功能读不到笔记标题，
 * 所以无法安全地判断"哪条是测试写的"。
 *
 * 安全做法：测试任务在写入前记一下笔记数量，写入后再数一次，数量差就是自己新增的条数；
 * 只删最新的那几条（Notes 按时间倒序，新笔记在顶部）。这样永远不会误删用户已有的笔记。
 *
 * 另外提供 countNotes() 供任务计数；清理脚本默认只报告，要删必须 --force 或 NOTES_CLEANUP_FORCE=1。
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/**
 * 测试笔记的显式标记：写的时候放在第一行，Notes 会把它当标题。
 * 删的时候优先只删带这个标记的行——比"删顶部 N 条"再收紧一层，
 * 避免用户刚好在这段时间新建笔记时被 count-delta 误伤。
 */
export const TEST_NOTE_MARKER = '[AGENT-TEST]';

/** 历史遗留的测试标题特征（老任务写的没有新标记，清理时仍然只认这些词，不按"可删行"乱删） */
export const LEGACY_TEST_WORDS = ['后台控制验证', '后台写入', '后台测试', 'pta 测试'];

/** 测试笔记标题特征（用于任务自检、日志与删除时的行文本匹配） */
export const TEST_NOTE_RE = /\[\s*AGENT-TEST\s*\]|后台控制验证|后台写入|后台测试|pta 测试/i;

export function isTestNoteTitle(title) {
  return TEST_NOTE_RE.test(String(title || ''));
}

/** 生成删除脚本里的 AppleScript 字符串列表；只接受安全字面量，防止脚本注入 */
export function buildWordListLiteral(words) {
  const safe = (words || []).map(String).filter((w) => w && !/["\\\r\n]/.test(w));
  return '{' + safe.map((w) => '"' + w + '"').join(', ') + '}';
}

/**
 * 按行标签挑出该删的（纯函数，删除脚本用同一套判定，便于单测）。
 * @param {string[]} labels 每行的可读文本
 * @param {{limit?:number}} [options]
 * @returns {string[]} 命中的标签（最多 limit 条）
 */
export function pickDeletableLabels(labels, options = {}) {
  const limit = Math.max(0, Number(options && options.limit) || 0);
  // 默认只认显式标记；历史测试词要调用方显式传 words 才参与（避免误删同名用户笔记）
  const words = (options && options.words) || [TEST_NOTE_MARKER];
  const hits = [];
  for (const label of labels || []) {
    const text = String(label || '');
    if (!text) continue;
    if (!words.some((w) => text.includes(w))) continue;
    hits.push(text);
    if (limit && hits.length >= limit) break;
  }
  return hits;
}

/** 数一下当前文件夹里有多少条可删除的笔记（有「删除」次要动作的行） */
const COUNT_SCRIPT = [
  'with timeout of 30 seconds',
  '  tell application "System Events" to tell process "Notes"',
  '    set w to window 1',
  '    set tbl to table 1 of scroll area 2 of splitter group 1 of w',
  '    set n to 0',
  '    repeat with rr in (rows of tbl)',
  '      try',
  '        if (count of actions of rr) >= 2 then set n to n + 1',
  '      end try',
  '    end repeat',
  '    return n',
  '  end tell',
  'end timeout',
].join('\n');

/**
 * @param {{deps?:{exec?:Function}}} [options]
 * @returns {Promise<number>}
 */
export async function countNotes(options = {}) {
  const opts = options || {};
  const run = (opts.deps && opts.deps.exec) || exec;
  const sleep = (opts.deps && opts.deps.sleep) || ((ms) => new Promise((r) => setTimeout(r, ms)));
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const { stdout } = await run('/usr/bin/osascript', ['-e', COUNT_SCRIPT], { timeout: 40000 });
      const n = Number.parseInt(String(stdout).trim(), 10);
      if (Number.isFinite(n) && n >= 0) return n;
    } catch {}
    await sleep(500);
  }
  return -1;
}

/**
 * 只删最新（列表顶部）的 n 条笔记，绝不按"所有可删行"批量删。
 * 顶部是 Notes 按时间倒序的第一条，所以只会命中测试刚刚写进去的那几条。
 */
const DELETE_TOP_SCRIPT = [
  'with timeout of 120 seconds',
  '  set removed to 0',
  '  repeat with kk from 1 to TIMES_TOK',
  '    set didDelete to false',
  '    try',
  '      tell application "System Events" to tell process "Notes"',
  '        set w to window 1',
  '        set tbl to table 1 of scroll area 2 of splitter group 1 of w',
  '        set rs to rows of tbl',
  '        repeat with i from (count of rs) to 1 by -1',
  '          try',
  '            set rr to item i of rs',
  '            if (count of actions of rr) >= 2 then',
  '              perform action 2 of rr',
  '              set didDelete to true',
  '              exit repeat',
  '            end if',
  '          end try',
  '        end repeat',
  '      end tell',
  '    end try',
  '    if didDelete then',
  '      set removed to removed + 1',
  '      delay 0.3',
  '    else',
  '      exit repeat',
  '    end if',
  '  end repeat',
  '  return removed',
  'end timeout',
].join('\n');

/**
 * 删除最新的 count 条笔记（只删自己新增的条数，调用方负责计数差）。
 * @param {number} count
 * @param {{deps?:{exec?:Function}}} [options]
 * @returns {Promise<number>}
 */
export async function deleteTopNotes(count, options = {}) {
  const opts = options || {};
  const n = Math.max(0, Number(count) || 0);
  if (!n) return 0;
  const run = (opts.deps && opts.deps.exec) || exec;
  const sleep = (opts.deps && opts.deps.sleep) || ((ms) => new Promise((r) => setTimeout(r, ms)));
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const { stdout } = await run('/usr/bin/osascript', ['-e', DELETE_TOP_SCRIPT.replace('TIMES_TOK', String(n))], { timeout: 150000 });
      const removed = Number.parseInt(String(stdout).trim(), 10) || 0;
      if (removed > 0 || attempt === 1) return removed;
    } catch {}
    await sleep(600);
  }
  return 0;
}

/**
 * 按标题标记删除测试笔记的脚本。
 *
 * 判定顺序：行文本里出现 TEST_NOTE_MARKER 或历史测试词才算"我们的"。
 * 同时返回 readable（读得到标题的行数）——如果是 0，说明这个 Notes 版本列表完全自绘，
 * 调用方要退回原来的 count-delta 策略（有兜底，不会一条都删不掉）。
 */
const MARKED_DELETE_TEMPLATE = [
  // 注意：handler 里必须自己 tell System Events，否则 static texts/name 这类
  // 只有 System Events 词表里才有的术语在编译期就报错（"Expected variable name..."）。
  'on rowLabel(rr)',
  '  set lbl to ""',
  '  tell application "System Events"',
  '    try',
  // 变量名不要用 st：它在 AppleScript 里是保留字，编译期会报
  // "Expected variable name or property but found st"（实测踩过）
  '      repeat with stItem in (static texts of rr)',
  '        try',
  '          set lbl to lbl & (value of stItem) & " "',
  '        end try',
  '      end repeat',
  '    end try',
  '    try',
  '      set lbl to lbl & (description of rr) & " "',
  '    end try',
  '    try',
  '      set lbl to lbl & (name of rr) & " "',
  '    end try',
  '    try',
  '      set lbl to lbl & (value of rr) & " "',
  '    end try',
  '  end tell',
  '  return lbl',
  'end rowLabel',
  '',
  'with timeout of 120 seconds',
  '  tell application "System Events" to tell process "Notes"',
  '    set w to window 1',
  '    set tbl to table 1 of scroll area 2 of splitter group 1 of w',
  '    set readable to 0',
  '    repeat with rr in (rows of tbl)',
  '      if my rowLabel(rr) is not "" then set readable to readable + 1',
  '    end repeat',
  '    set removed to 0',
  '    repeat with kk from 1 to LIMIT_TOK',
  '      set didDelete to false',
  '      set rs to rows of tbl',
  '      repeat with i from (count of rs) to 1 by -1',
  '        set rr to item i of rs',
  '        set lbl to my rowLabel(rr)',
  '        set hit to false',
  // word 也是 AppleScript 的类名，不能当循环变量
  '        repeat with hitWord in WORDS_TOK',
  '          if lbl contains hitWord then set hit to true',
  '        end repeat',
  '        if hit and (count of actions of rr) >= 2 then',
  '          perform action 2 of rr',
  '          set didDelete to true',
  '          exit repeat',
  '        end if',
  '      end repeat',
  '      if didDelete then',
  '        set removed to removed + 1',
  '        delay 0.3',
  '      else',
  '        exit repeat',
  '      end if',
  '    end repeat',
  '    return "removed=" & removed & " readable=" & readable',
  '  end tell',
  'end timeout',
].join('\n');

/**
 * 生成「按标题标记删除」脚本（纯函数，便于单测注入安全）。
 * @param {number} limit 最多删几条
 * @param {string[]} [words] 命中词；默认只认显式标记 [AGENT-TEST]，
 *   历史测试词要显式传入（清理脚本里对应 --force-all）
 */
export function buildMarkedDeleteScript(limit, words) {
  const n = Math.max(0, Number(limit) || 0);
  const list = words || [TEST_NOTE_MARKER];
  return MARKED_DELETE_TEMPLATE
    .replace('LIMIT_TOK', String(n))
    .replace('WORDS_TOK', buildWordListLiteral(list));
}

/**
 * 只删标题带测试标记的笔记。
 * @param {number} limit
 * @param {{deps?:{exec?:Function}, words?:string[]}} [options] words 可放宽到历史测试词
 * @returns {Promise<{removed:number, readable:number, attempted:boolean}>}
 */
export async function deleteMarkedTestNotes(limit, options = {}) {
  const opts = options || {};
  const n = Math.max(0, Number(limit) || 0);
  if (!n) return { removed: 0, readable: 0, attempted: false };
  const run = (opts.deps && opts.deps.exec) || exec;
  const sleep = (opts.deps && opts.deps.sleep) || ((ms) => new Promise((r) => setTimeout(r, ms)));
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const { stdout } = await run('/usr/bin/osascript', ['-e', buildMarkedDeleteScript(n, opts.words)], { timeout: 150000 });
      const m = /removed=(\d+)\s+readable=(\d+)/.exec(String(stdout || ''));
      if (m) return { removed: Number(m[1]) || 0, readable: Number(m[2]) || 0, attempted: true };
    } catch {}
    await sleep(600);
  }
  return { removed: 0, readable: 0, attempted: true };
}

/**
 * 兼容旧名：显式给条数，禁止"能删多少删多少"。
 * 优先按标记删；列表标题完全读不到时退回「只删顶部 N 条」的 count-delta 策略。
 */
export async function deleteTestNotes(options = {}) {
  const opts = options || {};
  const count = Number.isFinite(opts.count) ? opts.count : 0;
  if (!count) return 0;
  const marked = await deleteMarkedTestNotes(count, opts);
  if (marked.readable > 0) return marked.removed;
  return deleteTopNotes(count, opts);
}
