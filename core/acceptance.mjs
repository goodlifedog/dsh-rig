#!/usr/bin/env node
// 端到端验收：把关键能力跑一遍并出结论表
// 用法：node core/acceptance.mjs
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { envSkipReason } from './run-classify.mjs';
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

async function runTask(name, timeoutMs = 180000, env) {
  const r = await run('node', ['core/runner.mjs', 'run', name, '--timeout', String(timeoutMs)], env ? { env } : {});
  const out = r.stdout + r.stderr;
  // 环境原因跳过不算失败；规则与健康面板共用一份（core/run-classify.mjs）
  const reason = envSkipReason(out);
  const skipped = Boolean(reason);
  const ok = r.code === 0 || skipped;
  record('任务 ' + name, ok, ok ? (reason ? '环境跳过（' + reason + '）' : '') : out.slice(-200).replace(/\n/g, ' '), skipped);
  return ok;
}


const LOCK_FILE = path.join(ROOT, 'reports', '.acceptance.lock');

/** 验收会切窗口、启动应用：同一时刻只允许一个，避免外部会话反复跑把用户屏幕切成幻灯片 */
function acquireAcceptanceLock() {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      const info = String(fs.readFileSync(LOCK_FILE, 'utf8')).trim().split(' ');
      const pid = Number(info[0]) || 0;
      let alive = false;
      if (pid) { try { process.kill(pid, 0); alive = true; } catch {} }
      if (alive) {
        console.error('另一个验收正在进行（pid ' + pid + '），本次退出（避免重复切窗口）。');
        return false;
      }
    }
    fs.mkdirSync(path.dirname(LOCK_FILE), { recursive: true });
    fs.writeFileSync(LOCK_FILE, process.pid + ' ' + new Date().toISOString());
    return true;
  } catch {
    return true;
  }
}

function releaseAcceptanceLock() {
  try {
    const pid = Number(String(fs.readFileSync(LOCK_FILE, 'utf8')).trim().split(' ')[0]);
    if (pid === process.pid) fs.unlinkSync(LOCK_FILE);
  } catch {}
}

/** 用户最近有没有在用电脑：HID 空闲时间小于 180 秒就算在用；验收会切窗口，不该这时候跑 */
function userRecentlyActive() {
  if (process.env.ACCEPT_FORCE === '1') return false;
  if (process.platform !== 'darwin') return false;
  try {
    const out = execFileSync('/usr/sbin/ioreg', ['-c', 'IOHIDSystem', '-d', '4'], { encoding: 'utf8', timeout: 4000 });
    const m = out.match(/"HIDIdleTime" = (\d+)/);
    if (!m) return false;
    const idleSec = Number(m[1]) / 1e9;
    if (idleSec < 180) {
      console.error('检测到你正在使用电脑（空闲 ' + idleSec.toFixed(0) + ' 秒），验收会切窗口，先不跑。');
      console.error('确实要跑：ACCEPT_FORCE=1 npm run accept');
      return true;
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
  } catch {}
}

let FRONT_AT_START = '';

async function main() {
  if (!acquireAcceptanceLock()) return;
  if (userRecentlyActive()) { releaseAcceptanceLock(); return; }
  console.log('=== 桌面代理端到端验收 ===');
  FRONT_AT_START = frontmostApp();
  const h = await checkOverlay();
  if (h.ok) await checkIdleHide();

  const scanOk = await runTask('boss-scan');
  const multiOk = await runTask('multi-app');
  const writeOk = await runTask('form-fill');
  const platformOk = await runTask('platform-demo');
  const browserOk = await runTask('browser-demo');
  const electronOk = await runTask('electron-demo');
  // 新通道也要过验收闸门：否则等于"写完就算完成"（外部评审 P0）
  const cdpOk = await runTask('cdp-channel', 120000);
  const asOk = await runTask('applescript-channel', 120000);
  const bgOk = await runTask('background-control', 150000);
  const matrixOk = await runTask('app-matrix', 420000, {
    // 样本挑"不抢前台"的两个：Steam 会短暂抢前台（矩阵能兜住，但它不该当验收样本）
    MATRIX_APPS_JSON: JSON.stringify([
      { name: 'FastZip', bundle: 'cn.better365.FastZip', process: 'FastZip' },
      { name: 'iRightMouse', bundle: 'cn.better365.iRightMouse', process: 'iRightMouse' },
    ]),
  });

  // 验收里有些 demo 会把目标应用留到前台；结束时按"用户原来所在的应用"还原。
  // 用户中途自己切走了（浏览器/终端）就不要动，避免被硬拽。
  if (process.platform === 'darwin' && FRONT_AT_START) {
    const TARGETS = ['Calculator', 'Notes', 'TextEdit', 'DeepSeek Harness', 'iMovie', 'Steam', 'FastZip', 'iRightMouse', 'TencentMeeting', 'Keynote', 'Numbers', 'Pages'];
    const current = frontmostApp();
    const isTouched = TARGETS.some((name) => current === name || current.includes(name)) || current === FRONT_AT_START;
    if (current !== FRONT_AT_START && isTouched) {
      try {
        execFileSync('/usr/bin/osascript', ['-e', 'tell application "System Events" to set frontmost of first process whose name is ' + JSON.stringify(FRONT_AT_START) + ' to true'], { timeout: 5000 });
      } catch {}
    }
  }

  await cleanupAfterAcceptance();

  const passed = RESULTS.filter((r) => r.ok && !r.skipped).length;
  const skipped = RESULTS.filter((r) => r.skipped).length;
  const total = RESULTS.length;
  console.log('\n结果: ' + passed + '/' + (total - skipped) + ' 通过' + (skipped ? '，' + skipped + ' 项环境跳过' : ''));
  for (const r of RESULTS) console.log((r.ok ? '  ✅ ' : '  ❌ ') + r.name);

  const dir = path.join(ROOT, 'reports');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'acceptance-' + new Date().toISOString().replace(/[:.]/g, '-') + '.md');
  const lines = [
    '# 桌面代理验收报告',
    '',
    '时间：' + new Date().toISOString(),
    '结果：' + passed + '/' + (total - skipped) + (skipped ? '（环境跳过 ' + skipped + ' 项）' : ''),
    '',
    '| 项目 | 结果 | 说明 |',
    '| --- | --- | --- |',
    ...RESULTS.map((r) => '| ' + r.name + ' | ' + (r.ok ? 'PASS' : 'FAIL') + ' | ' + (r.detail || '') + ' |'),
  ];
  fs.writeFileSync(file, lines.join('\n') + '\n');
  console.log('报告：' + file);
  // 环境跳过不算失败：只有"没通过且不是跳过"才返回 1
  releaseAcceptanceLock();
  process.exit(passed === total - skipped ? 0 : 1);
}

main().catch((e) => {
  console.error('FAIL:', e.message);
  releaseAcceptanceLock();
  process.exit(2);
});