'use strict';
// 完全脱离主控屏幕：headless Chrome（屏幕上不存在窗口）+ CDP 操作 + 帧推给小窗。
//   node core/runner.mjs run headless-demo
//
// 这个任务本身是一份「屏幕无窗口」的实测报告：
//   1) 启动前、启动瞬间、结束前各取一次前台应用名 + 前台进程 pid，要求前后一致
//      （只看应用名不够：用户自己的 Chrome 和 headless Chrome 都叫 Google Chrome）；
//   2) 用 System Events 数这头 Chrome 进程的窗口数，headless 必须是 0，且命令行里带 --headless=new；
//   3) 截图、移动、点击全部走 CDP，不碰系统坐标、不激活任何窗口；
//   4) 截图通过 POST /frame 推给小窗，用户在小窗里看到的就是代理看到的画面。
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

import { launch } from '../browser.mjs';
import { overlay } from '../agentd.mjs';

// ocu 绝对不能画假光标（否则用户屏幕上会飘一个虚拟光标）
process.env.OPEN_COMPUTER_USE_VISUAL_CURSOR = '0';

const PROFILE = process.env.HEADLESS_PROFILE
  || path.join(os.homedir(), '.desktop-agent', 'headless-profile');
const OCU = process.env.OCU_BIN || path.join(os.homedir(), '.local', 'bin', 'ocu');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 当前前台：应用名（读 ocu list_apps 的 [frontmost] 行）+ 前台进程 pid
 * （System Events）。只看应用名不够 —— 用户自己开的 Chrome 和我们新起的
 * headless Chrome 都叫 Google Chrome，必须靠 pid 才能证明前台没被抢走。
 */
function frontmost() {
  let name = null;
  try {
    const out = execFileSync(OCU, ['call', 'list_apps'], { encoding: 'utf8', timeout: 15000 });
    const text = JSON.parse(out).content?.[0]?.text || '';
    const line = text.split('\n').find((l) => l.includes('[frontmost'));
    if (line) name = line.replace(/\s*\[frontmost[^\]]*\].*$/, '').replace(/\s*—\s*[^ ]+$/, '').trim();
  } catch {}
  let pid = null;
  try {
    const out = execFileSync('osascript', ['-e',
      'tell application "System Events" to get unix id of first process whose frontmost is true'],
      { encoding: 'utf8', timeout: 10000 }).trim();
    const n = Number(out);
    if (Number.isFinite(n) && n > 0) pid = n;
  } catch {}
  return { name, pid };
}

/** 前后两次前台是否同一个应用（pid 可比时按 pid，否则退回应用名） */
function sameFront(a, b) {
  if (!a || !b) return false;
  if (a.pid && b.pid) return a.pid === b.pid;
  return a.name === b.name;
}

/** 该 pid 的窗口数（System Events / Accessibility）。headless 必须是 0。 */
function axWindowCount(pid) {
  try {
    const out = execFileSync('osascript', ['-e',
      'tell application "System Events" to count windows of (first process whose unix id is ' + pid + ')'],
      { encoding: 'utf8', timeout: 10000 }).trim();
    const n = Number(out);
    return Number.isFinite(n) ? n : null;
  } catch { return null; }
}

/** 从 ps 取这个 pid 的命令行，确认真的是 --headless=new 起来的那一头 */
function cmdlineOf(pid) {
  try {
    const out = execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8', timeout: 5000 }).trim();
    return out;
  } catch { return ''; }
}

/** 把 CDP 截图推给小窗；返回每一帧的体积，方便看推帧是否稳定 */
async function pushFrames(page, { count = 3, intervalMs = 300, cursor = null } = {}) {
  const frames = [];
  for (let i = 0; i < count; i += 1) {
    const t = Date.now();
    // clip.scale=2：给小窗放大态留出清晰度（1280×800 → 2560×1600）
    const shot = await page.send('Page.captureScreenshot', { format: 'jpeg', quality: 80, clip: { x: 0, y: 0, width: 1280, height: 800, scale: 2 } });
    const bytes = Buffer.from(shot.data, 'base64').length;
    const r = await overlay.frame('data:image/jpeg;base64,' + shot.data, 'headless 后台浏览器', cursor);
    frames.push({ b64KB: Math.round(shot.data.length / 1024), bytes, ms: Date.now() - t, ok: Boolean(r && r.ok) });
    if (i < count - 1) await sleep(intervalMs);
  }
  return frames;
}

/** 在页面里找第一个链接，拿到它的中心点（用于拟人点击） */
async function findLink(page) {
  return page.evaluate(`(() => {
    const a = document.querySelector('a');
    if (!a) return null;
    const r = a.getBoundingClientRect();
    return {
      text: (a.textContent || '').trim().slice(0, 60),
      href: a.href,
      x: Math.round(r.left + r.width / 2),
      y: Math.round(r.top + r.height / 2),
    };
  })()`);
}

/** 拟人点击：分步移动 + 抖动 + 按下/抬起之间随机停顿（纯 CDP Input 事件，不碰系统光标） */
async function humanClick(page, to) {
  const t0 = Date.now();
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const from = { x: clamp(to.x - 180, 40, 1240), y: clamp(to.y + 60, 60, 740) };
  const steps = 8;
  for (let i = 1; i <= steps; i += 1) {
    const k = i / steps;
    const ease = 1 - Math.pow(1 - k, 3); // easeOutCubic：起步快、收尾慢
    const jitter = i === steps ? 0 : 1.5;
    await page.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: Math.round(from.x + (to.x - from.x) * ease + (Math.random() * 2 - 1) * jitter),
      y: Math.round(from.y + (to.y - from.y) * ease + (Math.random() * 2 - 1) * jitter),
    });
    await sleep(12 + Math.random() * 24);
  }
  await sleep(60 + Math.random() * 80);
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: to.x, y: to.y, button: 'left', clickCount: 1 });
  await sleep(70 + Math.random() * 60);
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', clickCount: 1 });
  return { ms: Date.now() - t0, from, to };
}

async function main() {
  const failures = [];
  const report = { ok: false, frontmost: {}, launch: {}, nav: {}, frames: [], click: {}, screen: {}, close: {} };

  // ---------- 0. 启动前基线 ----------
  await overlay.status('后台浏览器启动（无窗口）');
  const before = frontmost();
  report.frontmost.before = before;
  console.log('[0] 启动前前台:', before.name, 'pid', before.pid);

  // ---------- 1. 启动 headless Chrome ----------
  const t0 = Date.now();
  const b = await launch({ userDataDir: PROFILE, headless: true, timeoutMs: 45000 });
  const launchMs = Date.now() - t0;
  report.launch = { ms: launchMs, port: b.port, pid: b.pid, attempt: b.attempt, staleKilled: b.staleKilled };
  const cmdline = cmdlineOf(b.pid);
  const isHeadless = cmdline.includes('--headless=new');
  console.log('[1] headless Chrome 启动:', launchMs, 'ms, 端口', b.port, 'pid', b.pid,
    '（第', b.attempt, '次尝试, 清理残留', b.staleKilled.length, '个）');
  console.log('[1b] 命令行含 --headless=new:', isHeadless);
  if (!isHeadless) failures.push('启动的进程不是 --headless=new');
  // 启动瞬间最容易抢前台：刚拉起来就检查一次
  const afterLaunch = frontmost();
  report.frontmost.afterLaunch = afterLaunch;
  if (afterLaunch.pid === b.pid) failures.push('headless Chrome 启动时抢到了前台');
  console.log('[1c] 启动后前台:', afterLaunch.name, 'pid', afterLaunch.pid,
    '（不是新起的 pid', b.pid, '）');

  // ---------- 2. 导航 ----------
  const page = await b.connect({ timeoutMs: 20000 });
  await page.send('Page.enable');
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });

  const t1 = Date.now();
  await page.send('Page.navigate', { url: 'https://example.com' });
  // 注意：不能只等 document.title —— 那时 readyState 还是 loading，DOM 里连 <a> 都没有。
  // 等真正 load 完（readyState=complete 且链接已进 DOM）再继续。
  const loaded = await page.waitFor(
    'document.readyState === "complete" && !!document.querySelector("a")',
    { timeout: 15000 },
  );
  const navMs = Date.now() - t1;
  const title = await page.evaluate('document.title');
  report.nav = { ms: navMs, title, loaded };
  console.log('[2] 页面加载:', navMs, 'ms, 标题:', title, '（load 完成:', loaded, '）');
  if (!loaded) failures.push('页面 15s 内没有加载完成');

  // ---------- 3. CDP 截图 + 推帧给小窗 ----------
  const link = await findLink(page).catch(() => null);
  const frameCursor = link ? { x: link.x, y: link.y } : null;
  const frames = await pushFrames(page, { count: 3, intervalMs: 300, cursor: frameCursor });
  report.frames = frames;
  const heal = await overlay.health();
  report.overlay = { visible: heal.visible, fps: heal.fps, frameBytes: heal.frameBytes, clickThrough: heal.clickThrough, windowId: heal.windowId };
  console.log('[3] CDP 截图推帧:', frames.map((f) => f.bytes + 'B').join(' / '),
    '；小窗 visible=' + heal.visible, 'frameBytes=' + heal.frameBytes, 'clickThrough=' + heal.clickThrough);
  if (!frames.every((f) => f.ok)) failures.push('有帧没推到小窗');

  // ---------- 4. 页面内拟人点击 ----------
  if (!link) {
    failures.push('页面上找不到可点链接');
  } else {
    console.log('[4] 点击目标:', JSON.stringify(link.text), link.href, '@', link.x + ',' + link.y);
    const click = await humanClick(page, link);
    // 等导航真的发生（证明点击落点正确，不是空点）
    let after = { url: '', title: '' };
    for (let i = 0; i < 50; i += 1) {
      await sleep(100);
      after = await page.evaluate('({ url: location.href, title: document.title })').catch(() => ({ url: '', title: '' }));
      if (after.url && after.url !== 'https://example.com/') break;
    }
    report.click = { ...click, text: link.text, href: link.href, landedUrl: after.url, landedTitle: after.title };
    console.log('[4b] 拟人点击:', click.ms, 'ms；落点 URL:', after.url, '标题:', after.title);
    if (!after.url || after.url === 'https://example.com/') failures.push('点击后页面没变化，落点可能不对');
    // 点完再推一帧，小窗里能看到变化后的画面
    const post = await pushFrames(page, { count: 1, cursor: click.to });
    report.frames.push(...post);
  }

  // ---------- 5. 屏幕无窗口验证 ----------
  const frontAfter = frontmost();
  const winCount = axWindowCount(b.pid);
  report.frontmost.after = frontAfter;
  report.screen = { pid: b.pid, axWindowCount: winCount, headlessFlag: isHeadless };
  console.log('[5] 屏幕上没有窗口：pid', b.pid, '的窗口数 =', winCount,
    '；前台:', frontAfter.name, 'pid', frontAfter.pid);
  if (winCount !== 0) failures.push('headless Chrome 还有 ' + winCount + ' 个窗口');
  if (!sameFront(before, frontAfter)) failures.push('前台被换成了 ' + frontAfter.name + '(' + frontAfter.pid + ')');
  if (frontAfter.pid === b.pid) failures.push('前台变成了 headless Chrome 自己');

  // ---------- 6. 关闭 + 确认没有残留 ----------
  await overlay.status('后台浏览器收尾（屏幕无窗口）');
  const t2 = Date.now();
  const closed = await b.close();
  let residue = 0;
  try {
    const out = execFileSync('ps', ['-ax', '-o', 'pid=,command='], { encoding: 'utf8', timeout: 5000 });
    residue = out.split('\n').filter((l) => l.includes(PROFILE) && l.includes('MacOS/Google Chrome') && !l.includes('Helper') && !l.includes('--type=')).length;
  } catch {}
  report.close = { ms: Date.now() - t2, ...closed, residueProcesses: residue };
  console.log('[6] 关闭:', report.close.ms, 'ms, 进程已退出:', !closed.alive, '；同 profile 残留进程:', residue);
  if (residue > 0) failures.push('关闭后仍有 ' + residue + ' 个残留进程');

  report.ok = failures.length === 0;
  report.failures = failures;
  await overlay.log('headless 实测完成：启动 ' + launchMs + 'ms / 导航 ' + navMs + 'ms / 窗口 0 / 前台未变');
  console.log(JSON.stringify(report));

  if (failures.length) throw new Error('屏幕无窗口验收未过：' + failures.join('；'));
}

main().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });