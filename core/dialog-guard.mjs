'use strict';
/**
 * 弹窗守卫：我们自己弹出来的窗口（崩溃报告、更新提示、系统权限框）不该挡住用户。
 *
 * 策略分两类：
 *   1. 权限类（辅助功能/屏幕录制/自动化/登录项）→ **绝不代点**，只提醒用户（代点授权违反本项目的安全约定）
 *   2. 其它（崩溃、错误、更新、引导）→ 自动点掉「确定/好/关闭/稍后」
 *
 * 数据源是项目自己的 AX 层（core/background.mjs 的 dialogs / System Events 点击），
 * 不用 ocu CLI：ocu 没有 dialogs 工具，走它只会静默失效。
 *
 * 默认只处理我们自己的进程（overlay 的 Electron、Desktop Agent），**不碰用户的 Chrome/办公软件**；
 * 需要扩大范围时用 DIALOG_GUARD_APPS 显式指定。
 *
 * 用法：
 *   node core/dialog-guard.mjs            # 扫一轮，打印结果
 *   node core/dialog-guard.mjs --watch    # 常驻，每 5 秒扫一次
 */
import { dialogs, frontName } from './background.mjs';
import { isSafeIdentifier, isSafeScriptLiteral } from './safety.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

const PERMISSION_HINTS = /辅助功能|屏幕录制|自动化|完全磁盘|输入监控|登录项|Accessibility|Screen Recording|Automation|Full Disk|Input Monitoring|想要控制|想要录制/i;
const SAFE_BUTTONS = ['确定', '好', '关闭', '稍后', '以后再说', '取消', 'OK', 'Dismiss', 'Close', 'Later', 'Cancel'];

/** 默认只处理自家进程：别去点用户正在用的 Chrome/办公软件 */
export const DEFAULT_TARGETS = ['Electron', 'Desktop Agent'];

export function classifyDialog(text) {
  const s = String(text || '');
  if (PERMISSION_HINTS.test(s)) return { kind: 'permission', autoClick: false };
  return { kind: 'benign', autoClick: true };
}

export function pickSafeButton(buttons) {
  const list = Array.isArray(buttons) ? buttons : [];
  for (const want of SAFE_BUTTONS) {
    const hit = list.find((b) => String(b).trim() === want);
    if (hit) return String(hit).trim();
  }
  return '';
}

/**
 * 用 AX 层点掉弹窗里的按钮（不做激活，前台不动）。
 * @returns {Promise<boolean>}
 */
export async function clickDialogButton(appName, windowIndex, button) {
  if (!isSafeIdentifier(appName) || !isSafeScriptLiteral(button)) return false;
  const idx = Number(windowIndex) || 1;
  const script = 'tell application "System Events" to tell process ' + JSON.stringify(appName) +
    ' to click button ' + JSON.stringify(button) + ' of window ' + idx;
  try {
    await exec('/usr/bin/osascript', ['-e', script], { timeout: 8000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * 扫一轮：读目标应用的弹窗，按策略处理。
 * @param {{targets?:string[], dryRun?:boolean}} [options]
 */
export async function scanOnce(options = {}) {
  const opts = options || {};
  const targets = Array.isArray(opts.targets) && opts.targets.length
    ? opts.targets
    : (process.env.DIALOG_GUARD_APPS ? process.env.DIALOG_GUARD_APPS.split(',').map((s) => s.trim()).filter(Boolean) : DEFAULT_TARGETS);
  const report = [];
  for (const app of targets) {
    let list = [];
    try {
      list = await dialogs(app, { timeoutMs: 6000 });
    } catch {
      list = [];
    }
    for (const d of list) {
      const text = [d.title, ...(d.texts || [])].join(' ');
      const verdict = classifyDialog(text);
      const button = verdict.autoClick ? pickSafeButton(d.buttons) : '';
      let clicked = false;
      if (verdict.autoClick && button && !opts.dryRun) {
        clicked = await clickDialogButton(app, d.index || 1, button);
      }
      report.push({ app, text: text.slice(0, 80), kind: verdict.kind, button: button || null, clicked });
    }
  }
  return report;
}

export async function runOnce(options = {}) {
  const rows = await scanOnce(options);
  const front = await frontName().catch(() => '');
  return { front, rows };
}

const isMain = process.argv[1] && process.argv[1].endsWith('dialog-guard.mjs');
if (isMain) {
  const watch = process.argv.includes('--watch');
  const dryRun = process.argv.includes('--dry-run');
  const tick = async () => {
    const { rows } = await runOnce({ dryRun });
    if (!rows.length) {
      console.log('[dialog-guard] 没有发现弹窗');
      return;
    }
    for (const r of rows) {
      if (r.kind === 'permission') console.log('[需要你处理] ' + r.app + ' 权限弹窗：' + r.text);
      else console.log('[已自动处理] ' + r.app + ' ' + (r.clicked ? '点了「' + r.button + '」' : (dryRun ? '演练模式未点' : '没找到安全按钮')) + '：' + r.text);
    }
  };
  if (!watch) await tick();
  else setInterval(() => { tick().catch(() => {}); }, 5000);
}
