/**
 * 「会大动前台」的验收互斥（跨会话/跨 agent）。
 *
 * 真实事故：两个会话同时跑验收类任务（acceptance / bg:verify / app-matrix / background-control），
 * 一边在矩阵里点应用、另一边在关应用，结果两边都出现假的 FAIL——报告互相污染。
 * 现有 .acceptance.lock 只挡 acceptance 自己，挡不住 bg:verify 和手工任务。
 *
 * 做法：跑之前扫一遍进程表，发现有「别人的同类任务」在跑就拒绝，而不是硬上。
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export const UI_PATTERNS = [
  /core[\/]acceptance\.mjs/,
  /scripts[\/]bg-verify\.mjs/,
  /core[\/]tasks[\/]app-matrix\.mjs/,
  /core[\/]tasks[\/]background-control\.mjs/,
  /core[\/]tasks[\/]background-stability\.mjs/,
];

/**
 * 从 ps 输出里找「别人的前台类任务」。
 * @param {string} psOutput 每行含 pid 与 command（例如 ps -axo pid=,command=）
 * @param {{selfPids?: number[], patterns?: RegExp[]}} [options]
 * @returns {Array<{pid:number, command:string}>}
 */
export function findForeignUiRuns(psOutput, options = {}) {
  const self = new Set((options.selfPids || []).map(Number).filter(Boolean));
  const patterns = (options.patterns && options.patterns.length) ? options.patterns : UI_PATTERNS;
  const out = [];
  for (const raw of String(psOutput || '').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const m = /^(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    const command = m[2];
    if (!pid || self.has(pid)) continue;
    if (!patterns.some((re) => re.test(command))) continue;
    // 只看真正的 node 进程，避免匹配到 grep/编辑器/日志文件名
    if (!/\bnode\b/.test(command)) continue;
    out.push({ pid, command: command.slice(0, 200) });
  }
  return out;
}

/** 读当前进程表（ps -axo pid=,command=），失败返回空串 */
export async function readProcessTable(options = {}) {
  const run = (options && options.exec) || exec;
  try {
    const { stdout } = await run('/bin/ps', ['-axo', 'pid=,command='], { timeout: 3000, maxBuffer: 8 * 1024 * 1024 });
    return String(stdout || '');
  } catch {
    return '';
  }
}

/** 现场扫描：现在有没有「别人的前台类任务」在跑 */
export async function findForeignUiRunsNow(options = {}) {
  const ps = await readProcessTable(options);
  return findForeignUiRuns(ps, options);
}
