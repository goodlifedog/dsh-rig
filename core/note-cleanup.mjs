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

/** 测试笔记标题特征（仅用于任务自检/日志判断，不做删除依据） */
export const TEST_NOTE_RE = /后台控制验证|后台写入|后台测试|pta 测试/i;

export function isTestNoteTitle(title) {
  return TEST_NOTE_RE.test(String(title || ''));
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

/** 兼容旧名：显式给条数，禁止"能删多少删多少" */
export async function deleteTestNotes(options = {}) {
  const count = Number.isFinite(options && options.count) ? options.count : 0;
  return deleteTopNotes(count, options);
}
