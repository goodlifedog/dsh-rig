#!/usr/bin/env node
// 端到端验收：把关键能力跑一遍并出结论表
// 用法：node core/acceptance.mjs
import { execFile, execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { envSkipReason } from './run-classify.mjs';
import { acquireLock, releaseLock } from './acceptance-lock.mjs';
import { findForeignUiRunsNow } from './foreground-guard.mjs';
import { diffNewlyRunning, sampleRunningApps, shouldRunCleanup, cleanupMessages } from './acceptance-cleanup.mjs';
import { quitAppSync } from './sync-quit.mjs';
import { overlay } from './agentd.mjs';
import { overlayBase } from './ports.mjs';
import { tokenHeadersFor } from './local-token.mjs';
import { createAppleEventPreflight, runAppleEventGuarded, SYSTEM_EVENTS_BUNDLE_ID } from './appleevent-preflight.mjs';
import { frontName } from './background.mjs';
import { isDirectRun } from './direct-run.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const RESULTS = [];
// H2：AppleEvent 未授权被跳过时记下的 warning，最后写进验收报告（不能静默）
const APPLEEVENT_WARNINGS = [];

/** 记录一条「因未授权跳过了 AppleEvent」的 warning（去重，报告里单独成节） */
export function noteAppleEventWarning(message) {
  const text = String(message || '').trim();
  if (!text || APPLEEVENT_WARNINGS.includes(text)) return;
  APPLEEVENT_WARNINGS.push(text);
  console.warn('  ⚠ ' + text);
}

/** 当前累计的 AppleEvent warning（测试/报告用） */
export function appleEventWarnings() {
  return APPLEEVENT_WARNINGS.slice();
}

/** 验收报告里的「自动化授权告警」小节；没有 warning 时返回空数组 */
export function appleEventWarningSection() {
  if (!APPLEEVENT_WARNINGS.length) return [];
  return ['', '## 自动化授权告警', '', ...APPLEEVENT_WARNINGS.map((text) => '- ' + text)];
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: opts.timeout || 180000, maxBuffer: 64 * 1024 * 1024, cwd: ROOT, env: opts.env ? { ...process.env, ...opts.env } : process.env }, (err, stdout, stderr) => {
      resolve({ code: err ? 1 : 0, stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

/** 键鼠空闲多少秒（读不到返回 -1） */
function hidIdleSec() {
  if (process.platform !== 'darwin') return -1;
  try {
    const out = execFileSync('/usr/sbin/ioreg', ['-c', 'IOHIDSystem', '-d', '4'], { encoding: 'utf8', timeout: 3000 });
    const m = /"HIDIdleTime" = (\d+)/.exec(out);
    return m ? Number(m[1]) / 1e9 : -1;
  } catch {
    return -1;
  }
}

/** 杀掉子进程整个进程组（任务会再起自己的子进程，只杀父进程会留下孤儿） */
function killGroup(child, signal) {
  try { process.kill(-child.pid, signal); } catch {}
  try { child.kill(signal); } catch {}
}

/**
 * 跑一个任务，并在「用户回到电脑前」时立刻停掉它。
 *
 * 为什么不能在任务之间才检查：app-matrix 这种一跑就是几分钟，等它跑完再停，
 * 用户回来这段时间屏幕一直被切来切去。所以任务运行期间每秒查一次键鼠空闲。
 */
export function runTaskProcess(cmd, args, opts = {}) {
  const abortIdleSec = Number(process.env.ACCEPT_ABORT_IDLE_SEC || 30);
  const idleFn = typeof opts.idleFn === 'function' ? opts.idleFn : hidIdleSec;
  return new Promise((resolve) => {
    const env = opts.env ? { ...process.env, ...opts.env } : process.env;
    const spawnFn = typeof opts.spawn === 'function' ? opts.spawn : spawn;
    const child = spawnFn(cmd, args, { cwd: ROOT, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    registerActiveTask(child);
    let stdout = '';
    let stderr = '';
    let aborted = false;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; killGroup(child, 'SIGTERM'); }, opts.timeout || 180000);
    const poll = setInterval(() => {
      if (process.env.ACCEPT_FORCE === '1') return;
      const idle = idleFn();
      if (idle >= 0 && idle < abortIdleSec) {
        aborted = true;
        killGroup(child, 'SIGTERM');
      }
    }, 1000);
    child.stdout.on('data', (b) => { stdout += b; });
    child.stderr.on('data', (b) => { stderr += b; });
    child.on('error', (error) => {
      clearInterval(poll);
      clearTimeout(timer);
      registerActiveTask(null);
      resolve({ code: 1, stdout, stderr: stderr + String(error && error.message || error), aborted, timedOut });
    });
    child.on('close', (code) => {
      clearInterval(poll);
      clearTimeout(timer);
      registerActiveTask(null);
      resolve({ code: code == null ? 1 : code, stdout, stderr, aborted, timedOut });
    });
  });
}

/**
 * 分类「示例脚本」的结果（纯函数）：example 脚本自报 SKIP + exit 0 时算环境跳过，不算 PASS。
 * 超时=FAIL（环境问题除外），用户回来被中止=环境跳过；输出原样带回 RESULTS/日志。
 *
 * @param {{code?:number, stdout?:string, stderr?:string, timedOut?:boolean, aborted?:boolean}} [result]
 * @returns {{ok:boolean, skipped:boolean, detail:string, output:string}}
 */
export function classifyExampleResult(result = {}) {
  const r = result || {};
  const output = String(r.stdout || '') + String(r.stderr || '');
  if (r.aborted) {
    return { ok: true, skipped: true, detail: '环境跳过（用户回到电脑前，已立刻停止示例，不再动屏幕）', output };
  }
  if (r.timedOut) {
    return { ok: false, skipped: false, detail: '超时（示例未在限定时间内结束）', output };
  }
  // 脚本自己打印 SKIP 且 exit 0 = 环境不具备，不是能力失败；JSON 里的 envSkip=true 同样认。
  const selfSkip = /^\s*SKIP\b/m.test(output)
    || /"envSkip"\s*:\s*true/.test(output)
    || Boolean(envSkipReason(output));
  if (r.code === 0) {
    if (selfSkip) {
      return { ok: true, skipped: true, detail: '环境跳过（示例自报 SKIP，不算 PASS）', output };
    }
    return { ok: true, skipped: false, detail: '', output };
  }
  const tail = output.trim().split('\n').slice(-4).join(' ').slice(-200);
  return { ok: false, skipped: false, detail: tail || ('exit=' + r.code), output };
}

/** 跑 examples/web-click 示例（不走 runner；注入 spawn 便于单测，不真启动 Chrome） */
export async function runExampleWebClick(options = {}) {
  const opts = options || {};
  const timeoutMs = Number(opts.timeoutMs) || 120000;
  const r = await runTaskProcess(process.execPath, ['examples/web-click/run.mjs'], {
    timeout: timeoutMs,
    spawn: opts.spawn,
    idleFn: opts.idleFn,
  });
  return classifyExampleResult(r);
}

/**
 * 汇总验收项（纯函数）：分母写总项数，跳过与失败分开计数。
 * 之前分母是「总项数 - 跳过数」，13 项里 2 项跳过会显示「11/11」，读报告的人以为只跑了 11 项。
 * @param {Array<{ok:boolean, skipped?:boolean}>} results
 */
/**
 * 跑到一半要不要停（纯函数）：用户回来了、或有别的验收插进来，就停止后续任务。
 * 只做一次入口检查不够——验收本身要跑好几分钟，中途状态会变（评审指出）。
 * @param {{userActive?:boolean, foreignCount?:number}} input
 * @returns {string} 空串=继续；否则是跳过原因
 */
export function midRunAbortReason(input = {}) {
  const data = input || {};
  const foreignCount = Number(data.foreignCount) || 0;
  if (foreignCount > 0) return '另一个验收中途插入（' + foreignCount + ' 个前台类任务）';
  if (data.userActive) return '用户回到电脑前（键鼠空闲 < 90 秒）';
  return '';
}

export function summarizeResults(results) {
  const list = Array.isArray(results) ? results : [];
  const passed = list.filter((r) => r && r.ok && !r.skipped).length;
  const skipped = list.filter((r) => r && r.skipped).length;
  const failed = list.filter((r) => r && !r.ok && !r.skipped).length;
  return { total: list.length, passed, skipped, failed, ok: failed === 0 };
}

function record(name, ok, detail, skipped = false) {
  RESULTS.push({ name, ok, detail, skipped });
  const tag = skipped ? '  SKIP ' : (ok ? '  PASS ' : '  FAIL ');
  console.log(tag + name + '  ' + (detail || ''));
}

async function checkOverlay() {
  const h = await overlay.health();
  record('overlay 在线', !!h.ok, h.ok ? 'pid=' + h.pid : 'offline');
  return h;
}

/** 把宿主切换前台（先静默预检自动化授权；已授权时 osascript 参数与旧实现完全一致） */
async function activateHost() {
  return defaultAppleEventOps.activateHost();
}

/** 还原前台到指定 bundle（先静默预检；拿不到就交给验收收尾统一还原） */
async function restoreBundle(bundle) {
  return defaultAppleEventOps.restoreBundle(bundle);
}

async function checkIdleHide() {
  const before = await overlay.health();
  if (!before.ok) return record('空闲自动隐藏', false, 'overlay 不在线');
  const frontBefore = await frontmostBundle();
  await overlay.visible(false);
  await new Promise((r) => setTimeout(r, 500));
  const hidden = await overlay.health();
  record('手动隐藏生效', hidden.visible === false, 'visible=' + hidden.visible);
  // 主动把宿主切前台，再触发活动：这样这一项是确定性检查，不会因为"前台恰好是计算器"而跳过
  const activated = await activateHost();
  if (!activated) {
    record('活动触发显示', true, '环境跳过：切不到宿主（锁屏或系统事件不可用）', true);
    return;
  }
  await new Promise((r) => setTimeout(r, 400));
  // 小窗按"会话标题 = 宿主窗口标题"门控：验收要像真实会话一样带上当前标题，否则会被按设计隐藏
  const hintHealth = await overlay.health().catch(() => null);
  const titleHint = (hintHealth && hintHealth.dshTitle) || '';
  await overlay.status('验收中', 'running', titleHint);
  await new Promise((r) => setTimeout(r, 900));
  const shown = await overlay.health();
  await restoreBundle(frontBefore);
  if (shown.visible === true) {
    record('活动触发显示', true, '');
  } else {
    // 小窗按设计只在 DSH 前台时显示；以下都算环境状态，不该判失败：
    //   前台是别的应用 / 锁屏 / 取不到前台 / 宿主窗口本身不可见
    const front = await frontmostBundle();
    if (shown.screenLocked) {
      record('活动触发显示', true, '环境跳过：锁屏时小窗按设计不显示', true);
    } else if (!front) {
      record('活动触发显示', true, '环境跳过：取不到前台应用（系统事件暂时不可用）', true);
    } else if (!/deepseek|\.dsh/i.test(front)) {
      record('活动触发显示', true, '前台=' + front + '，按设计隐藏', true);
    } else if (shown.hostVisible === false) {
      record('活动触发显示', true, '环境跳过：宿主窗口不可见', true);
    } else {
      record('活动触发显示', false, 'visible=' + shown.visible + ' front=' + front);
    }
  }
}

async function frontmostApp() {
  return defaultAppleEventOps.frontmostApp();
}

async function frontmostBundle() {
  return defaultAppleEventOps.frontmostBundle();
}


// 验收里有些 demo 会把目标应用留到前台：每个任务之后都还原一次，
// 否则后面任务的「起点前台」会是测试应用，判定链一路歪（实测踩过：multi-app 之后 Calculator 留前台）。
// 用户中途自己切走了（浏览器/终端）就不动，避免被硬拽。
export const TEST_APPS = ['Calculator', 'Notes', 'TextEdit', 'DeepSeek Harness', 'iMovie', 'Steam', 'FastZip', 'iRightMouse', 'TencentMeeting', 'Keynote', 'Numbers', 'Pages'];

/**
 * 该不该把前台还给用户（纯函数，便于单测）：
 * current 是测试应用或用户原来的应用时才还；用户自己切到别处（浏览器/终端）就不动。
 */
export function shouldRestoreFront(current, frontAtStart, testApps = TEST_APPS) {
  const cur = String(current || '');
  const start = String(frontAtStart || '');
  if (!start) return false;
  if (!cur || cur === start) return false;
  return (testApps || []).some((name) => cur === name || cur.includes(name)) || cur === start;
}

/**
 * 验收里的 AppleEvent 操作统一从这里走：先静默预检「自动化」授权，再决定是否发事件（H2）。
 *
 * 语义：
 *   - granted → 原样执行 execFileSync，参数/返回值与改造前逐字一致；
 *   - denied / needs-consent → 不发 AppleEvent，返回安全兜底（activateHost=false、
 *     frontmostApp=''、frontmostBundle=null、restoreUserFront=false），并调 onWarning 记录；
 *   - unknown / 预检超时 / 预检抛错 → 仍然尝试（探测抖动不能让前台还原失效）。
 *
 * 可注入 exec/preflight/platform/onWarning，单测全部走假实现，不碰真实系统。
 */
export function createAppleEventOps(deps = {}) {
  const exec = typeof deps.exec === 'function' ? deps.exec : execFileSync;
  const platform = deps.platform || process.platform;
  const onWarning = typeof deps.onWarning === 'function' ? deps.onWarning : () => {};
  const preflight = deps.preflight || createAppleEventPreflight({ bundleId: SYSTEM_EVENTS_BUNDLE_ID });
  const guard = (action, run, fallback) => runAppleEventGuarded({
    action,
    bundleId: SYSTEM_EVENTS_BUNDLE_ID,
    preflight,
    run,
    fallback,
    onWarning,
  });

  async function frontmostApp() {
    const outcome = await guard('读取前台应用名', () => {
      try {
        return String(exec('/usr/bin/osascript', ['-e', 'tell application "System Events" to get name of first process whose frontmost is true'], { encoding: 'utf8', timeout: 4000 })).trim();
      } catch {
        return '';
      }
    }, '');
    return outcome.value;
  }

  async function frontmostBundle() {
    if (platform !== 'darwin') return null;
    const outcome = await guard('读取前台 bundle', () => {
      try {
        return String(exec('/usr/bin/osascript', ['-e',
          'tell application "System Events" to get bundle identifier of first process whose frontmost is true'],
          { encoding: 'utf8', timeout: 3000 })).trim();
      } catch {
        return null;
      }
    }, null);
    return outcome.value;
  }

  async function activateHost() {
    if (platform !== 'darwin') return false;
    const outcome = await guard('激活宿主', () => {
      try {
        exec('/usr/bin/osascript', ['-e', 'tell application "System Events" to set frontmost of first process whose bundle identifier is "com.deepseek.dsh" to true'], { timeout: 5000 });
        return true;
      } catch {
        return false;
      }
    }, false);
    return outcome.value;
  }

  async function restoreBundle(bundle) {
    if (!bundle || platform !== 'darwin') return;
    await guard('还原前台到 bundle', () => {
      try {
        exec('/usr/bin/osascript', ['-e', 'tell application "System Events" to set frontmost of first process whose bundle identifier is ' + JSON.stringify(bundle) + ' to true'], { timeout: 5000 });
      } catch {}
    }, undefined);
  }

  async function restoreUserFront(frontAtStart) {
    const start = String(frontAtStart || '');
    if (platform !== 'darwin' || !start) return false;
    const current = await frontmostApp();
    if (!shouldRestoreFront(current, start)) return false;
    const outcome = await guard('还原用户前台', () => {
      try {
        exec('/usr/bin/osascript', ['-e', 'tell application "System Events" to set frontmost of first process whose name is ' + JSON.stringify(start) + ' to true'], { timeout: 5000 });
        return true;
      } catch {
        return false;
      }
    }, false);
    return outcome.value;
  }

  return { activateHost, restoreBundle, frontmostApp, frontmostBundle, restoreUserFront };
}

// 验收运行时用的默认实例：未授权被跳过时把 warning 写进报告
const defaultAppleEventOps = createAppleEventOps({ onWarning: noteAppleEventWarning });

async function restoreUserFront() {
  return defaultAppleEventOps.restoreUserFront(FRONT_AT_START);
}

// 验收开始时的测试应用运行集合（基线）：只收「之后新出现的」，用户自己开着的绝不动
let APPS_AT_START = new Set();
// 基线是否可信（P3）：非 macOS / pgrep 全挂时采样会返回空集，那不是「真的一个都没在跑」。
// 基线不可信就整轮不做收尾——宁可不收，也不能把用户本来就开着的应用退掉。
let APPS_BASELINE_TRUSTED = false;
// 「收掉验收期间被拉起的 X」这类收尾记录，最后写进报告
const CLEANUP_NOTES = [];
// 跳过收尾的原因按原因去重，避免每个任务刷一遍同样的提示
const CLEANUP_SKIP_NOTES = new Set();

/** 记录一次「因为基线不可信而没有收尾」，同一原因只记一次 */
function noteCleanupSkipped(reason) {
  const text = String(reason || '未知原因');
  if (CLEANUP_SKIP_NOTES.has(text)) return;
  CLEANUP_SKIP_NOTES.add(text);
  const line = '基线不可信，跳过收尾：' + text + '（本轮不退出任何应用）';
  CLEANUP_NOTES.push(line);
  console.log('  ⚠ ' + line);
}

/**
 * 收掉「验收开始时不在这批测试应用里运行、现在却在运行」的应用。
 *
 * 每跑完一个任务、以及验收收尾各调一次。任务把应用拉起来留在后台时，后续任务退出别的应用
 * 会把前台带到它身上，验收就误判「前台被抢占」（16:09 那次是 multi-app 留下了计算器）。
 * 只发 AppleScript quit（优雅退出），退不掉就如实记录，绝不强杀（可能丢用户没保存的内容）。
 *
 * @param {string} stage 记录用：哪个阶段发现的
 * @returns {Promise<string[]>} 真正收掉的应用名
 */
async function cleanupUnexpectedApps(stage = '') {
  // P3：基线不可信时「空集」不代表真没在跑，diff 会把用户原有应用全列成新增 → 一律不动手。
  if (!APPS_BASELINE_TRUSTED) {
    noteCleanupSkipped('验收开始时的基线采样没有成功');
    return [];
  }
  const sample = sampleRunningApps(TEST_APPS);
  const decision = shouldRunCleanup(APPS_BASELINE_TRUSTED, sample);
  if (!decision.run) {
    noteCleanupSkipped('本次采样不可信（' + decision.reason + '）');
    return [];
  }
  const unexpected = diffNewlyRunning(APPS_AT_START, sample.apps, TEST_APPS);
  if (!unexpected.length) return [];
  const quit = [];
  for (const name of unexpected) {
    const result = quitAppSync({ appName: name, processName: name }, { budgetMs: 8000 });
    const ok = Boolean(result && result.quit);
    if (ok) quit.push(name);
    const text = cleanupMessages([name], stage)[0] || ('收掉验收期间被拉起的 ' + name);
    const line = ok ? text : text.replace(/^收掉/, '未能收掉');
    CLEANUP_NOTES.push(line);
    console.log('  ' + (ok ? '· ' : '⚠ ') + line);
  }
  return quit;
}

async function runTask(name, timeoutMs = 180000, env) {
  const r = await runTaskProcess('node', ['core/runner.mjs', 'run', name, '--timeout', String(timeoutMs)], env ? { env, timeout: timeoutMs + 5000 } : { timeout: timeoutMs + 5000 });
  if (r.aborted) {
    record('任务 ' + name, true, '环境跳过（你回到电脑前，已立刻停止这个任务，不再动屏幕）', true);
    return true;
  }
  const out = r.stdout + r.stderr;
  // 环境原因跳过不算失败；规则与健康面板共用一份（core/run-classify.mjs）
  const reason = envSkipReason(out);
  const skipped = Boolean(reason);
  const ok = r.code === 0 || skipped;
  record('任务 ' + name, ok, ok ? (reason ? '环境跳过（' + reason + '）' : '') : out.slice(-200).replace(/\n/g, ' '), skipped);
  // 每个任务之后先收掉「任务意外拉起的应用」，再把前台还给用户。
  // 顺序有讲究：退出应用本身会改变前台，最后一步必须是还原前台，
  // 否则下一个任务的起点基线还是歪的（16:09 那次就是计算器顶在前面）。
  await cleanupUnexpectedApps('任务 ' + name + ' 之后');
  // 下一个任务的判定基线必须是「用户原来的应用」
  if (await restoreUserFront()) console.log('  （已把前台还给 ' + FRONT_AT_START + '）');
  return ok;
}


const LOCK_FILE = path.join(ROOT, 'reports', '.acceptance.lock');

/**
 * 锁失败时给用户看的话（纯函数，便于单测）：
 *   busy            = 正常让路，说明谁在跑；
 *   lock-unwritable = 环境异常（权限/磁盘/路径），必须说清这是 fail-closed 不是普通让路。
 */
export function acceptanceLockFailureMessage(result) {
  const r = result || {};
  if (r.reason === 'busy') {
    if (r.pid) return '另一个验收正在进行（pid ' + r.pid + '），本次退出（避免重复切窗口）。';
    return '验收锁刚被另一个进程创建，本次退出（避免重复切窗口）。';
  }
  return '验收锁写不进去，已按 fail-closed 退出（不会在未加锁状态下跑，避免两个验收同时切窗口）：'
    + (r.error || '未知原因');
}

/** 验收会切窗口、启动应用：同一时刻只允许一个，避免外部会话反复跑把用户屏幕切成幻灯片 */
function acquireAcceptanceLock() {
  const result = acquireLock(LOCK_FILE);
  if (!result.ok) {
    console.error(acceptanceLockFailureMessage(result));
    if (result.reason === 'lock-unwritable') {
      console.error('提示：先检查 reports/ 的写权限、磁盘空间、reports 是否被换成了普通文件；'
        + '确实要在无锁状态跑，显式设 AGENT_ALLOW_UNLOCKED=1（同一时刻仍然只能有一个验收）。');
    }
    return result;
  }
  if (result.warning) console.warn(result.warning);
  return result;
}

function releaseAcceptanceLock() {
  releaseLock(LOCK_FILE);
}

/** 用户最近有没有在用电脑：HID 空闲时间小于阈值就算在用；验收会切窗口，不该这时候跑 */
function userRecentlyActive(maxIdleSec = 180) {
  if (process.env.ACCEPT_FORCE === '1') return false;
  if (process.platform !== 'darwin') return false;
  try {
    const out = execFileSync('/usr/sbin/ioreg', ['-c', 'IOHIDSystem', '-d', '4'], { encoding: 'utf8', timeout: 4000 });
    const m = out.match(/"HIDIdleTime" = (\d+)/);
    if (!m) return false;
    const idleSec = Number(m[1]) / 1e9;
    if (idleSec < maxIdleSec) {
      console.error('检测到你正在使用电脑（空闲 ' + idleSec.toFixed(0) + ' 秒），验收会切窗口，先不跑。');
      console.error('确实要跑：ACCEPT_FORCE=1 npm run accept');
      return true;
      // 注意：这里的 return true 分两条路径共用（启动门槛与中途复查）
    }
    return false;
  } catch {
    return false;
  }
}

/** 验收跑完自动清理测试数据（笔记/文稿/测试应用），别把脏数据留给用户 */
/**
 * 把所有小窗收起来：验收的 demo 任务会开小窗回显，用户中途回来时屏幕上一层窗口正是它们。
 * 关掉非 default 会话、default 隐藏（不退出 overlay 进程）。
 */
async function tidyOverlayWindows() {
  const base = overlayBase();
  const post = async (p, body) => {
    try {
      await fetch(base + p, {
        method: 'POST',
        headers: tokenHeadersFor(base + p, { 'Content-Type': 'application/json' }),
        body: JSON.stringify(body || {}),
        signal: AbortSignal.timeout(1500),
      });
    } catch {}
  };
  try {
    const res = await fetch(base + '/sessions', { headers: tokenHeadersFor(base + '/sessions'), signal: AbortSignal.timeout(1500) });
    const data = await res.json();
    for (const s of data.sessions || []) {
      if (!s || !s.session) continue;
      if (s.session === 'default') await post('/visible', { session: 'default', visible: false });
      else await post('/close', { session: s.session });
    }
  } catch {}
}

/** 从 cleanup-test-data 的 stdout 里挑出 JSON（脚本前面可能混有日志行） */
function parseCleanupJson(stdout) {
  const text = String(stdout || '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * M2 纯函数：把 cleanup-test-data 的结果翻译成验收收尾说明。
 * - 解析 stdout JSON，envSkip/deleted/skippedKinds 摘要并入 CLEANUP_NOTES；
 * - 子进程退出码非 0 也记一条（别静默）；
 * - 解析失败/超时抛错不崩，只记失败原因。
 * @param {{code?:number, stdout?:string, stderr?:string, error?:string}} result
 * @returns {string[]}
 */
export function summarizeCleanupRun(result = {}) {
  const notes = [];
  const code = Number(result && result.code);
  const parsed = parseCleanupJson(result && result.stdout);
  if (parsed) {
    const deleted = parsed.deleted || {};
    const counts = {
      notes: Math.max(0, Number(deleted.notes) || 0),
      textEdit: Math.max(0, Number(deleted.textEdit) || 0),
      chrome: Math.max(0, Number(deleted.chrome) || 0),
    };
    const parts = 'notes=' + counts.notes + ' textEdit=' + counts.textEdit + ' chrome=' + counts.chrome;
    const kinds = Array.isArray(parsed.skippedKinds) && parsed.skippedKinds.length
      ? parsed.skippedKinds.join('/')
      : '未知通路';
    if (parsed.envSkip === true || parsed.skipped === true) {
      notes.push('清理：检测到环境跳过（' + kinds + '），deleted ' + parts + '；未清理项见清理报告，授权/应用可用后请重跑');
    } else if (counts.notes + counts.textEdit + counts.chrome > 0) {
      notes.push('清理：deleted ' + parts);
    }
  } else if (String((result && result.stdout) || '').trim()) {
    notes.push('清理：解析清理脚本 JSON 失败（详见清理输出）');
  }
  if (Number.isFinite(code) && code !== 0) notes.push('清理脚本退出码 ' + code + '（详见清理输出）');
  if (result && result.error) notes.push('清理失败：' + String(result.error).slice(0, 160));
  return notes;
}

/**
 * M5 纯函数：未授权时收尾前台与起点不一致 -> 一条环境说明（不判 FAIL）。
 * 只在前台读取成功、有 AppleEvent 告警、且前后不同时返回文案。
 * @param {{frontAtStart?:string, finalFront?:string, appleEventWarnings?:string[]}} input
 * @returns {string}
 */
export function finalFrontWarning({ frontAtStart = '', finalFront = '', appleEventWarnings = [] } = {}) {
  const start = String(frontAtStart || '').trim();
  const final = String(finalFront || '').trim();
  const warnings = (Array.isArray(appleEventWarnings) ? appleEventWarnings : []).filter(Boolean);
  if (!start || !final || !warnings.length || final === start) return '';
  return '自动化未授权导致前台可能未还原：起始 ' + start + ' → 结束 ' + final
    + '（已跳过 AppleEvent；仅记录环境说明，不判验收失败）';
}

async function cleanupAfterAcceptance() {
  await tidyOverlayWindows();
  // 收尾再采样一次：失败/中止的情况下，前面 per-task 的清理可能还没来得及跑
  await cleanupUnexpectedApps('验收收尾');
  await restoreUserFront();
  try {
    // 清理脚本现在是安全模式：笔记默认只报告（要 --force 才删）、TextEdit 只关带测试标记的文稿、
    // 只会退出测试应用，所以验收后可以直接真跑，把环境收拾干净。
    const cleanupRun = await run('node', ['scripts/cleanup-test-data.mjs'], { timeout: 240000 });
    for (const note of summarizeCleanupRun(cleanupRun)) CLEANUP_NOTES.push(note);
  } catch (error) {
    console.warn('清理失败：' + ((error && error.message) || error));
  }
}

let FRONT_AT_START = '';

// 当前正在跑的任务子进程（验收被中止时要连它一起杀，否则任务会变成孤儿继续动屏幕）
let activeTaskChild = null;

/** 注册当前任务子进程（runTaskProcess 内部用；导出便于测试） */
export function registerActiveTask(child) {
  activeTaskChild = child || null;
}

/**
 * 杀掉当前任务子进程（含它的进程组）。
 * 任务用 detached 起在独立进程组里，只杀验收自己收不到它——不杀就会在验收退出後继续控制应用。
 * @param {string} [signal]
 * @param {Function} [kill] 便于测试注入
 * @returns {boolean} 有没有杀掉
 */
export function killActiveTask(signal = 'SIGTERM', kill = process.kill) {
  const child = activeTaskChild;
  if (!child || !child.pid) return false;
  try { kill(-child.pid, signal); } catch {}
  try { child.kill(signal); } catch {}
  return true;
}

// Ctrl-C / SIGTERM：先杀掉正在跑的任务（它在独立进程组里），再释放锁退出，
// 否则下一次会误判「另一个验收正在进行」，而且孤儿任务会继续动屏幕。
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    killActiveTask(signal);
    releaseAcceptanceLock();
    process.exit(signal === 'SIGINT' ? 130 : 143);
  });
}

async function main() {
  const lock = acquireAcceptanceLock();
  if (!lock.ok) {
    // busy 是正常让路（退出码 0）；「锁写不进去」是环境异常，必须让外层（live-verify / CI）看得见（退出码 3），
    // 否则 fail-closed 变成悄无声息地少跑一轮验收。
    process.exitCode = lock.reason === 'lock-unwritable' ? 3 : 0;
    return;
  }
  if (userRecentlyActive()) { releaseAcceptanceLock(); return; }
  // 跨会话互斥：别的会话正在跑 bg:verify / 矩阵 / 后台控制时，任务会互相干扰成假失败
  const foreign = await findForeignUiRunsNow({ selfPids: [process.pid, process.ppid] });
  if (foreign.length) {
    console.error('拒绝执行：另一个前台类验收正在进行');
    for (const f of foreign.slice(0, 3)) console.error('  pid=' + f.pid + ' ' + f.command);
    releaseAcceptanceLock();
    return;
  }
  console.log('=== 桌面代理端到端验收 ===');
  FRONT_AT_START = await frontmostApp();
  // 基线：验收开始时这批测试应用里谁在跑。用户自己开着的（比如本来就开着计算器）之后永远不动。
  // 采样带可信度：空集可能只是「pgrep 没跑成」，那种基线不能用来判定「新增」。
  const baseline = sampleRunningApps(TEST_APPS);
  APPS_AT_START = baseline.apps;
  APPS_BASELINE_TRUSTED = baseline.trusted;
  if (!baseline.trusted) {
    console.log('⚠ 基线采样不可信（' + baseline.reason + '）：本轮验收不做「意外应用」收尾，避免误退用户应用');
  } else if (APPS_AT_START.size) {
    console.log('验收开始时已在运行的测试应用（不会被收）：' + [...APPS_AT_START].join('、'));
  }
  const h = await checkOverlay();
  if (h.ok) await checkIdleHide();

  // 任务按顺序跑；每跑完一个都复查一次「用户是否回来 / 有没有别的验收插入」，
  // 一旦不满足就停掉后续任务、如实标环境跳过，而不是硬跑出假失败（评审指出入口只查一次不够）。
  const TASK_PLAN = [
    { name: 'multi-app' },
    { name: 'form-fill' },
    // 通用网页点击示例：替代已删除的 boss-scan，证明「任意页面按文字找按钮→后台点击→读回结果」。
    // 它不是 runner 任务，直接 spawn 示例脚本；自己打印 SKIP + exit 0 时算环境跳过。
    { name: 'web-click', example: 'examples/web-click/run.mjs', timeoutMs: 120000 },
    { name: 'platform-demo' },
    { name: 'browser-demo' },
    { name: 'electron-demo' },
    { name: 'cdp-channel', timeoutMs: 120000 },
    { name: 'applescript-channel', timeoutMs: 120000 },
    { name: 'background-control', timeoutMs: 150000 },
    // 并发验证：后台干活的同时，前台一次都不能被抢（安全任务，用户在场也能跑）
    { name: 'concurrent-demo', timeoutMs: 120000 },
    {
      name: 'app-matrix',
      timeoutMs: 420000,
      // 样本挑"不会自己抢前台"的两个：FastZip + 计算器都是原生应用，读起来稳定。
      // （iRightMouse/UURemote 历史报告里出现过前台被抢，已进风险名单，不适合当验收样本）
      env: {
        MATRIX_APPS_JSON: JSON.stringify([
          { name: 'FastZip', bundle: 'cn.better365.FastZip', process: 'FastZip' },
          { name: '计算器', bundle: 'com.apple.calculator', process: 'Calculator' },
        ]),
      },
    },
  ];
  let abortReason = '';
  let tidiedForAbort = false;
  for (const task of TASK_PLAN) {
    if (!abortReason) {
      const foreignRuns = await findForeignUiRunsNow({ selfPids: [process.pid, process.ppid] });
      abortReason = midRunAbortReason({ userActive: userRecentlyActive(90), foreignCount: foreignRuns.length });
    }
    if (abortReason) {
      // 用户回来了：先把已经弹出来的小窗收掉，再跳过后续任务（别留一屏幕窗口给用户）
      if (!tidiedForAbort) { tidiedForAbort = true; await tidyOverlayWindows(); }
      record(task.example ? '示例 ' + task.name : '任务 ' + task.name, true,
        '环境跳过（' + abortReason + '），本轮不再继续', true);
      continue;
    }
    if (task.example) {
      const r = await runExampleWebClick({ timeoutMs: task.timeoutMs });
      record('示例 ' + task.name, r.ok, r.detail, r.skipped);
      // 输出留在 RESULTS 并打到日志里（示例脚本的 PASS/SKIP/JSON 是排障证据）
      const last = RESULTS[RESULTS.length - 1];
      if (last) last.output = r.output;
      if (r.output.trim()) console.log(r.output.trim().split('\n').map((line) => '  | ' + line).join('\n'));
      await cleanupUnexpectedApps('示例 ' + task.name + ' 之后');
      if (await restoreUserFront()) console.log('  （已把前台还给 ' + FRONT_AT_START + '）');
    } else {
      await runTask(task.name, task.timeoutMs, task.env);
    }
  }

  // 收尾再还原一次（正常情况下每个任务之后已经还过了）
  await restoreUserFront();

  await cleanupAfterAcceptance();
  // M5：收尾用非 AppleEvent 的 frontName 复核终态前台；未授权导致还原被跳过时写进报告（不判失败）
  let finalFront = '';
  try { finalFront = await frontName(); } catch {}
  const frontNote = finalFrontWarning({ frontAtStart: FRONT_AT_START, finalFront, appleEventWarnings: APPLEEVENT_WARNINGS });
  if (frontNote) {
    CLEANUP_NOTES.push(frontNote);
    console.warn('  ⚠ ' + frontNote);
  }
  if (CLEANUP_NOTES.length) console.log('\n收尾：' + CLEANUP_NOTES.join('；'));
  if (APPLEEVENT_WARNINGS.length) console.log('\n自动化授权告警：' + APPLEEVENT_WARNINGS.join('；'));

  const { total, passed, skipped, failed } = summarizeResults(RESULTS);
  // 分母要写总项数：以前写 passed/(total-skipped)，13 项里 2 项跳过会显示「11/11」，
  // 看报告的人会以为只跑了 11 项
  console.log('\n结果: 共 ' + total + ' 项，通过 ' + passed + '，环境跳过 ' + skipped + (failed ? '，失败 ' + failed : ''));
  for (const r of RESULTS) {
    const mark = r.skipped ? '  ⏭ ' : (r.ok ? '  ✅ ' : '  ❌ ');
    console.log(mark + r.name);
  }

  const dir = path.join(ROOT, 'reports');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'acceptance-' + new Date().toISOString().replace(/[:.]/g, '-') + '.md');
  const lines = [
    '# 桌面代理验收报告',
    '',
    '时间：' + new Date().toISOString(),
    '结果：共 ' + total + ' 项，通过 ' + passed + '，环境跳过 ' + skipped + '，失败 ' + failed,
    '',
    '| 项目 | 结果 | 说明 |',
    '| --- | --- | --- |',
    ...RESULTS.map((r) => '| ' + r.name + ' | ' + (r.skipped ? 'SKIP' : (r.ok ? 'PASS' : 'FAIL')) + ' | ' + (r.detail || '') + ' |'),
    // 收尾说明单独成节：这些不是「验收项」，不该混进上面的通过/失败统计
    ...(CLEANUP_NOTES.length
      ? ['', '## 收尾说明', '', ...CLEANUP_NOTES.map((t) => '- ' + t)]
      : []),
    ...appleEventWarningSection(),
  ];
  fs.writeFileSync(file, lines.join('\n') + '\n');
  console.log('报告：' + file);
  // 环境跳过不算失败：只有"没通过且不是跳过"才返回 1
  releaseAcceptanceLock();
  process.exit(failed ? 1 : 0);
}

const invokedDirectly = isDirectRun(import.meta.url);

if (invokedDirectly) {
  main().catch((e) => {
    console.error('FAIL:', e.message);
    releaseAcceptanceLock();
    process.exit(2);
  });
}