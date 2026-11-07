'use strict';
/**
 * 测试笔记清理：把自动化写进备忘录的测试笔记删掉。
 *
 * 实机坑：AX 层的 secondaryAction 在这种窗口上返回 ok 但实际不删；
 * 只有 System Events 对行执行「删除」次要动作（perform action 2）才真的生效。
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/** 测试笔记标题特征（纯函数） */
export const TEST_NOTE_RE = /后台控制验证|后台写入|后台测试|pta 测试/i;

export function isTestNoteTitle(title) {
  return TEST_NOTE_RE.test(String(title || ''));
}

const DEL_SCRIPT = [
  'with timeout of 180 seconds',
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
  '      delay 0.25',
  '    else',
  '      exit repeat',
  '    end if',
  '  end repeat',
  '  return removed',
  'end timeout',
].join('\n');

/**
 * 删除备忘录主列表里带「删除」次要动作的行（只动当前文件夹里可删的笔记）。
 * @param {{max?:number, deps?:{exec?:Function}}} [options]
 * @returns {Promise<number>} 删除条数
 */
export async function deleteTestNotes(options = {}) {
  const opts = options || {};
  const max = Number.isFinite(opts.max) ? opts.max : 40;
  const run = (opts.deps && opts.deps.exec) || exec;
  try {
    const { stdout } = await run('/usr/bin/osascript', ['-e', DEL_SCRIPT.replace('TIMES_TOK', String(max))], { timeout: 200000 });
    return Number.parseInt(String(stdout).trim(), 10) || 0;
  } catch {
    return 0;
  }
}
