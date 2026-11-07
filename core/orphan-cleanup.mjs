'use strict';
/**
 * 孤儿进程清理：父进程已死、还挂在系统里的 OpenComputerUse/ocu 残留。
 *
 * 实测现场（外部评审查出来的）：同一台机器上三个 app-agent 同时在跑，
 * 其中两个 ppid=1（父进程早没了），最老的一个活了 26 小时。
 * 它们会占着辅助功能会话、让小窗/输入出现"莫名其妙连到旧实例"的问题。
 *
 * 处理原则要保守：
 *   - 只清 ppid=1 的孤儿（父进程还活着的，是有人在用，不动）
 *   - 只清命令里明确是本项目依赖名（Open Computer Use / OpenComputerUse / ocu）的进程
 *   - 只清当前用户自己的进程
 */

/** 默认认的进程命令行特征 */
export const DEFAULT_AGENT_PATTERN = /Open Computer Use|OpenComputerUse|\bocu\b/i;

/**
 * 解析 ps 输出（纯函数）。要求每行：pid ppid user command...
 * @param {string} text
 * @returns {Array<{pid:number, ppid:number, user:string, command:string}>}
 */
export function parseProcessTable(text) {
  const rows = [];
  for (const line of String(text || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const m = trimmed.match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
    if (!m) continue;
    rows.push({ pid: Number(m[1]), ppid: Number(m[2]), user: m[3], command: m[4] });
  }
  return rows;
}

/**
 * 找出需要清理的孤儿（纯函数）。
 * @param {Array<object>} rows parseProcessTable 的输出
 * @param {{user?:string, pattern?:RegExp, selfPid?:number}} [options]
 * @returns {number[]}
 */
export function findOrphanedAgents(rows, options = {}) {
  const opts = options || {};
  const user = String(opts.user || '');
  const pattern = opts.pattern || DEFAULT_AGENT_PATTERN;
  const selfPid = Number(opts.selfPid) || 0;
  const out = [];
  for (const row of rows || []) {
    if (!row || !row.pid) continue;
    if (row.pid === selfPid) continue;
    if (row.ppid !== 1) continue;                       // 父进程还活着 → 有人在用，不动
    if (user && row.user !== user) continue;            // 别人的进程不动
    if (!pattern.test(String(row.command || ''))) continue;
    out.push(row.pid);
  }
  return out;
}
