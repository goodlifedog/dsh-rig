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
import { isDirectRun } from './direct-run.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

const PERMISSION_HINTS = /辅助功能|屏幕录制|自动化|完全磁盘|输入监控|登录项|Accessibility|Screen Recording|Automation|Full Disk|Input Monitoring|想要控制|想要录制/i;
// 系统设置/权限相关的其它语言线索：只作为「不敢点」的信号，识别不到也只是不点，不影响安全
const SETTINGS_HINTS = /系统设置|系統設定|System Settings|Systemeinstellungen|Préférences Système|システム設定|隐私与安全性|隐私权与安全性|Privacy & Security|Bedienungshilfen|Accessibilité|アクセシビリティ/i;
// 授权类按钮：出现这些就按「权限弹窗」处理。非中英文系统上按钮常叫 OK/許可/Erlauben，
// 之前只看中文/英文关键词会漏判，进而把这它当普通弹窗点掉——那是代点授权，违反红线。
// 注意：汉字/假名不是 ASCII 单词字符， 在它们后面不成立，所以 CJK 单独一条、不加 
const GRANT_BUTTON_CJK = /^(?:允许|允許|许可|許可|好|同意|はい)/;
const GRANT_BUTTON_LATIN = /^(?:OK|Allow|Erlauben|Zulassen|Autoriser|Consenti|Accetta|Agree|Yes|Ja|Oui)\b/i;
// 只有文案明确是「崩溃/更新」这类自家软件的普通提示，才允许自动点
const BENIGN_TEXT_HINTS = /意外退出|崩溃|重新打开|忽略|更新|新版本|有可用更新|quit unexpectedly|crashed|reopen|Update|new version|available/i;
// 系统进程的弹窗一律不点（名字是结构信号，跟界面语言无关）
const SYSTEM_PROCESS_HINTS = /SecurityAgent|UserNotificationCenter|coreauthd|tccd|System Settings|系统设置|Systemeinstellungen|Préférences Système/i;
const SAFE_BUTTONS = ['确定', '好', '关闭', '稍后', '以后再说', '取消', 'OK', 'Dismiss', 'Close', 'Later', 'Cancel'];

/** 默认只处理自家进程：别去点用户正在用的 Chrome/办公软件 */
export const DEFAULT_TARGETS = ['Electron', 'DSH Rig', 'Desktop Agent'];

/**
 * 弹窗分类（结构优先，语言兜底）。
 *
 * 判定顺序：
 *   1. 文案/进程命中权限或系统设置线索 → permission，绝不点；
 *   2. 文案明确是崩溃/更新提示 → benign，可以点安全按钮；
 *   3. 文案不认识、但按钮里有授权类字样（OK/許可/Erlauben…）→ permission，绝不点；
 *   4. 其它一律 unknown，也不点。
 *
 * 为什么不再默认 benign：只靠中文/英文关键词的话，德语/法语/日语系统上的权限弹窗
 * 会被判成普通弹窗，而它们的授权按钮恰好叫 OK，等于替用户点了「允许」。
 * 现在的默认是「不认识就不动」，宁可少点一个崩溃提示，也不代点授权。
 *
 * @param {string} text 弹窗标题+正文
 * @param {string} [appName] 弹窗所属进程名（可选，用于识别系统进程）
 */
export function classifyDialog(text, appName = '') {
  const s = String(text || '');
  const app = String(appName || '');
  if (PERMISSION_HINTS.test(s)) return { kind: 'permission', autoClick: false };
  if (SETTINGS_HINTS.test(s)) return { kind: 'permission', autoClick: false };
  if (SYSTEM_PROCESS_HINTS.test(app)) return { kind: 'permission', autoClick: false };
  if (BENIGN_TEXT_HINTS.test(s)) return { kind: 'benign', autoClick: true };
  return { kind: 'unknown', autoClick: false };
}

/** 单个按钮是不是授权类（CJK 与拉丁字母两套判定） */
export function isGrantButton(text) {
  const t = String(text || '').trim();
  return GRANT_BUTTON_CJK.test(t) || GRANT_BUTTON_LATIN.test(t);
}

/** 弹窗里是否出现授权类按钮（用于 classifyDialog 的第 3 步，也供测试直接断言） */
export function hasGrantButton(buttons) {
  return (Array.isArray(buttons) ? buttons : []).some((b) => isGrantButton(b));
}

/**
 * 文案 + 按钮一起判（scanOnce 用的就是它）：不认识但按钮像授权 → 按权限弹窗处理。
 * @param {string} text
 * @param {string[]} buttons
 * @param {string} [appName]
 */
export function classifyDialogWithButtons(text, buttons, appName = '') {
  const base = classifyDialog(text, appName);
  if (base.kind === 'unknown' && hasGrantButton(buttons)) return { kind: 'permission', autoClick: false };
  return base;
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
      const verdict = classifyDialogWithButtons(text, d.buttons, app);
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

// 入口守卫统一走 core/direct-run.mjs：原来用 argv[1].endsWith 名字判断，改过名的临时副本
// 或同目录同名文件会误判；realpath 归一后只认「同一个文件」。
const isMain = isDirectRun(import.meta.url);
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
      else if (r.kind === 'benign') console.log('[已自动处理] ' + r.app + ' ' + (r.clicked ? '点了「' + r.button + '」' : (dryRun ? '演练模式未点' : '没找到安全按钮')) + '：' + r.text);
      else console.log('[未识别，不动] ' + r.app + ' ' + r.text);
    }
  };
  if (!watch) await tick();
  else setInterval(() => { tick().catch(() => {}); }, 5000);
}
