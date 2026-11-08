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
import { overlay } from './agentd.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const RESULTS = [];

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
    const child = spawn(cmd, args, { cwd: ROOT, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
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
      resolve({ code: 1, stdout, stderr: stderr + String(error && error.message || error), aborted, timedOut });
    });
    child.on('close', (code) => {
      clearInterval(poll);
      clearTimeout(timer);
      resolve({ code: code == null ? 1 : code, stdout, stderr, aborted, timedOut });
    });
  });
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

/** 把宿主切换前台：让"活动触发显示"每次都真跑，不依赖用户当时开着什么应用 */
function activateHost() {
  if (process.platform !== 'darwin') return false;
  try {
    execFileSync('/usr/bin/osascript', ['-e', 'tell application "System Events" to set frontmost of first process whose bundle identifier is "com.deepseek.dsh" to true'], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/** 还原前台到指定 bundle（拿不到就交给验收收尾统一还原） */
function restoreBundle(bundle) {
  if (!bundle || process.platform !== 'darwin') return;
  try {
    execFileSync('/usr/bin/osascript', ['-e', 'tell application "System Events" to set frontmost of first process whose bundle identifier is ' + JSON.stringify(bundle) + ' to true'], { timeout: 5000 });
  } catch {}
}

async function checkIdleHide() {
  const before = await overlay.health();
  if (!before.ok) return record('空闲自动隐藏', false, 'overlay 不在线');
  const frontBefore = frontmostBundle();
  await overlay.visible(false);
  await new Promise((r) => setTimeout(r, 500));
  const hidden = await overlay.health();
  record('手动隐藏生效', hidden.visible === false, 'visible=' + hidden.visible);
  // 主动把宿主切前台，再触发活动：这样这一项是确定性检查，不会因为"前台恰好是计算器"而跳过
  const activated = activateHost();
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
  restoreBundle(frontBefore);
  if (shown.visible === true) {
    record('活动触发显示', true, '');
  } else {
    // 小窗按设计只在 DSH 前台时显示；以下都算环境状态，不该判失败：
    //   前台是别的应用 / 锁屏 / 取不到前台 / 宿主窗口本身不可见
    const front = frontmostBundle();
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

function frontmostApp() {
  try {
    return execFileSync('/usr/bin/osascript', ['-e', 'tell application "System Events" to get name of first process whose frontmost is true'], { encoding: 'utf8', timeout: 4000 }).trim();
  } catch {
    return '';
  }
}

function frontmostBundle() {
  if (process.platform !== 'darwin') return null;
  try {
    return execFileSync('/usr/bin/osascript', ['-e',
      'tell application "System Events" to get bundle identifier of first process whose frontmost is true'],
      { encoding: 'utf8', timeout: 3000 }).trim();
  } catch { return null; }
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

function restoreUserFront() {
  if (process.platform !== 'darwin' || !FRONT_AT_START) return false;
  const current = frontmostApp();
  if (!shouldRestoreFront(current, FRONT_AT_START)) return false;
  try {
    execFileSync('/usr/bin/osascript', ['-e', 'tell application "System Events" to set frontmost of first process whose name is ' + JSON.stringify(FRONT_AT_START) + ' to true'], { timeout: 5000 });
    return true;
  } catch { return false; }
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
  // 每个任务之后把前台还给用户：下一个任务的判定基线必须是「用户原来的应用」
  if (restoreUserFront()) console.log('  （已把前台还给 ' + FRONT_AT_START + '）');
  return ok;
}


const LOCK_FILE = path.join(ROOT, 'reports', '.acceptance.lock');

/** 验收会切窗口、启动应用：同一时刻只允许一个，避免外部会话反复跑把用户屏幕切成幻灯片 */
function acquireAcceptanceLock() {
  const result = acquireLock(LOCK_FILE);
  if (!result.ok) {
    if (result.pid) console.error('另一个验收正在进行（pid ' + result.pid + '），本次退出（避免重复切窗口）。');
    else console.error('验收锁刚被另一个进程创建，本次退出（避免重复切窗口）。');
    return false;
  }
  if (result.warning) console.warn(result.warning);
  return true;
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
async function cleanupAfterAcceptance() {
  try {
    // 清理脚本现在是安全模式：笔记默认只报告（要 --force 才删）、TextEdit 只关带测试标记的文稿、
    // 只会退出测试应用，所以验收后可以直接真跑，把环境收拾干净。
    await run('node', ['scripts/cleanup-test-data.mjs'], { timeout: 240000 });
  } catch (error) {
    console.warn('清理失败：' + ((error && error.message) || error));
  }
}

let FRONT_AT_START = '';

// Ctrl-C / SIGTERM 也要释放锁，否则下一次会误判「另一个验收正在进行」（pid 被复用时尤其）
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    releaseAcceptanceLock();
    process.exit(signal === 'SIGINT' ? 130 : 143);
  });
}

async function main() {
  if (!acquireAcceptanceLock()) return;
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
  FRONT_AT_START = frontmostApp();
  const h = await checkOverlay();
  if (h.ok) await checkIdleHide();

  // 任务按顺序跑；每跑完一个都复查一次「用户是否回来 / 有没有别的验收插入」，
  // 一旦不满足就停掉后续任务、如实标环境跳过，而不是硬跑出假失败（评审指出入口只查一次不够）。
  const TASK_PLAN = [
    { name: 'boss-scan' },
    { name: 'multi-app' },
    { name: 'form-fill' },
    { name: 'platform-demo' },
    { name: 'browser-demo' },
    { name: 'electron-demo' },
    { name: 'cdp-channel', timeoutMs: 120000 },
    { name: 'applescript-channel', timeoutMs: 120000 },
    { name: 'background-control', timeoutMs: 150000 },
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
  for (const task of TASK_PLAN) {
    if (!abortReason) {
      const foreignRuns = await findForeignUiRunsNow({ selfPids: [process.pid, process.ppid] });
      abortReason = midRunAbortReason({ userActive: userRecentlyActive(90), foreignCount: foreignRuns.length });
    }
    if (abortReason) {
      record('任务 ' + task.name, true, '环境跳过（' + abortReason + '），本轮不再继续', true);
      continue;
    }
    await runTask(task.name, task.timeoutMs, task.env);
  }

  // 收尾再还原一次（正常情况下每个任务之后已经还过了）
  restoreUserFront();

  await cleanupAfterAcceptance();

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
  ];
  fs.writeFileSync(file, lines.join('\n') + '\n');
  console.log('报告：' + file);
  // 环境跳过不算失败：只有"没通过且不是跳过"才返回 1
  releaseAcceptanceLock();
  process.exit(failed ? 1 : 0);
}

const invokedDirectly = Boolean(process.argv[1])
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main().catch((e) => {
    console.error('FAIL:', e.message);
    releaseAcceptanceLock();
    process.exit(2);
  });
}