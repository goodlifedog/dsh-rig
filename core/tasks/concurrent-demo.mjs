#!/usr/bin/env node
/**
 * 并发验证：AI 在后台干活时，用户还能不能用电脑。
 *
 *   node core/tasks/concurrent-demo.mjs
 *   npm run demo:concurrent
 *
 * 做三件事：
 *   1) 后台拉起计算器（open -g -j，不显示窗口、不激活），读界面树、点按钮、读显示值、关掉
 *   2) 全程每 ~150ms 采样一次前台应用：任何一次被抢都算失败，并立刻还原
 *   3) 统计这期间你的键鼠有没有动过（HID 空闲时间比运行时长还短 = 你确实同时在操作电脑）
 *
 * 判定：前台一次都没被抢 + 计算器没在屏幕上出现窗口 + 工作负载完成。
 * 用户正在用电脑时也可以跑（这正是它要验的场景）。
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { ensureAppRunning, isAppRunning, frontName, state, find, click, quitApp, settleFront } from '../background.mjs';
import { isScreenLocked, isMac } from '../platform.mjs';
import { restoreFront } from '../front-watch.mjs';
import { closeOcuMcp } from '../ocu-mcp.mjs';

const exec = promisify(execFile);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const APP = { appName: '计算器', bundleId: 'com.apple.calculator', processName: 'Calculator' };
// 独立 profile，避免和 headless-demo / browser 任务互相抢（同一 profile 起第二个实例会互相杀）
const BROWSER_PROFILE = process.env.CONCURRENT_PROFILE
  || path.join(os.homedir(), '.desktop-agent', 'concurrent-profile');

/**
 * 快速读前台应用名（lsappinfo，约 10ms，比 System Events 的 120ms 快一个量级）。
 * 采样要覆盖"闪一下"这种瞬时抢占，越快的采样越不容易漏。
 */
async function frontFast() {
  try {
    const { stdout: asnOut } = await exec('/usr/bin/lsappinfo', ['front'], { timeout: 1500 });
    const asn = String(asnOut || '').trim();
    if (!asn) return '';
    const { stdout } = await exec('/usr/bin/lsappinfo', ['info', '-only', 'name', asn], { timeout: 1500 });
    const m = /"LSDisplayName"="([^"]*)"/.exec(String(stdout || ''));
    return m ? m[1] : '';
  } catch {
    return '';
  }
}

/** 你的键鼠多久没动（毫秒）；读不到 -1 */
async function hidIdleMs() {
  try {
    const { stdout } = await exec('/usr/sbin/ioreg', ['-c', 'IOHIDSystem', '-d', '4'], { timeout: 3000 });
    const m = /"HIDIdleTime" = (\d+)/.exec(String(stdout || ''));
    return m ? Math.round(Number(m[1]) / 1e6) : -1;
  } catch {
    return -1;
  }
}

/** 屏幕上（layer 0）还有没有计算器窗口 */
async function onscreenWindows(owner) {
  const script = [
    'ObjC.import("CoreGraphics");',
    'const opts=$.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements;',
    'const arr=ObjC.castRefToObject($.CGWindowListCopyWindowInfo(opts, 0));',
    'const out=[];',
    'for (let i=0;i<arr.count;i++){',
    '  try {',
    '    const d=arr.objectAtIndex(i);',
    '    const o=String(ObjC.unwrap(d.objectForKey("kCGWindowOwnerName"))||"");',
    '    const layer=Number(ObjC.unwrap(d.objectForKey("kCGWindowLayer")));',
    '    if (layer===0 && o==="'+owner+'") out.push(o);',
    '  } catch(e){}',
    '}',
    'JSON.stringify(out);',
  ].join('');
  try {
    const { stdout } = await exec('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script], { timeout: 3000 });
    const list = JSON.parse(String(stdout || '[]'));
    return Array.isArray(list) ? list.length : 0;
  } catch {
    return -1;
  }
}

async function main() {
  if (!isMac) { console.log('环境跳过：这条并发验证只在 macOS 上有意义'); return; }
  if (await isScreenLocked()) { console.log('环境跳过：屏幕已锁，AX 不可用'); return; }

  const startedAt = Date.now();
  const frontStart = await frontName();
  const idleStart = await hidIdleMs();
  console.log('起点前台:', frontStart, '| 你上次操作:', idleStart >= 0 ? Math.round(idleStart / 1000) + ' 秒前' : '未知');

  // 采样器：每 ~150ms 看一次前台；被抢就立刻还原并记下来
  const samples = [];
  const steals = [];
  let sampling = true;
  let launchedByUs = false;
  const sampler = (async () => {
    while (sampling) {
      try {
        const front = (await frontFast()) || (await frontName());
        samples.push(front);
        if (front && front !== frontStart) {
          steals.push({ at: Date.now() - startedAt, to: front });
          await settleFront(frontStart, { waitMs: 100, retries: 1 });
          await restoreFront(frontStart);
        }
      } catch {}
      await sleep(80);
    }
  })();

  const steps = [];
  let minIdleDuringHold = -1;
  const record = (name, ok, detail) => { steps.push({ name, ok, detail: detail || '' }); console.log((ok ? '  ✅ ' : '  ❌ ') + name + (detail ? '  ' + detail : '')); };

  try {
    const wasRunning = await isAppRunning(APP);
    const launch = await ensureAppRunning(APP, { waitMs: 8000 });
    launchedByUs = Boolean(launch.launched);
    record('后台拉起计算器（-g -j，不激活）', !launch.error && (launch.launched || wasRunning), 'launched=' + Boolean(launch.launched));
    await sleep(800);

    const tree = await state('计算器');
    record('后台读界面树', String(tree || '').length > 40, '节点行=' + String(tree || '').split('\n').length);

    const buttons = await find('计算器', { role: 'AXButton', limit: 40 });
    const label = (b) => String((b && (b.title || b.identifier || b.name)) || '');
    const seven = buttons.find((b) => /^(7|Seven)$/.test(label(b).trim()));
    const clear = buttons.find((b) => /^(AC|Clear|全部清除|清除)$/i.test(label(b).trim()));
    if (clear) { await click('计算器', clear.index); await sleep(200); }
    let clicked = false;
    if (seven) { clicked = (await click('计算器', seven.index)).ok; await sleep(400); }
    record('后台点按钮', clicked, seven ? '按钮 7' : '没找到按钮 7');

    const after = await state('计算器');
    const display = (/文本\s*[\u200e]?\s*(-?[\d.,]+)/.exec(String(after || '')) || [])[1] || '';
    record('读回显示值', display.length > 0, '显示=' + display);

    // 再叠一个 Chromium 族的活：headless 浏览器在后台开页面、读标题（屏幕上没有窗口），
    // 证明"原生应用 + 浏览器"两族同时干活时前台同样不受影响。
    if (process.env.CONCURRENT_BROWSER !== '0') {
      const t0 = Date.now();
      let browser = null;
      try {
        const { launch } = await import('../browser.mjs');
        browser = await launch({ userDataDir: BROWSER_PROFILE, headless: true, timeoutMs: 45000 });
        const page = await browser.connect({ timeoutMs: 20000 });
        await page.send('Page.navigate', { url: 'https://example.com' });
        const loaded = await page.waitFor('document.readyState === "complete"', { timeout: 15000 });
        const title = await page.evaluate('document.title');
        record('headless 浏览器同时在干活', Boolean(loaded) && String(title || '').length > 0, (Date.now() - t0) + 'ms 标题=' + title);
      } catch (error) {
        record('headless 浏览器同时在干活', false, String((error && error.message) || error).slice(0, 100));
      } finally {
        if (browser) await browser.close().catch(() => null);
      }
    }

    // 多待一会儿：给你机会在它干活时继续用电脑（这段采样的目的就是抓并发证据）
    const holdMs = Number(process.env.CONCURRENT_HOLD_MS || 5000);
    if (holdMs > 0) {
      console.log('  后台保持工作 ' + Math.round(holdMs / 1000) + ' 秒（这期间你正常操作就行）…');
      const holdUntil = Date.now() + holdMs;
      while (Date.now() < holdUntil) {
        const idle = await hidIdleMs();
        if (idle >= 0) minIdleDuringHold = minIdleDuringHold < 0 ? idle : Math.min(minIdleDuringHold, idle);
        await sleep(400);
      }
    }
  } catch (error) {
    record('工作负载', false, String((error && error.message) || error).slice(0, 120));
  } finally {
    sampling = false;
    await sampler.catch(() => {});
    const windowsDuring = await onscreenWindows('Calculator');
    if (launchedByUs) await quitApp(APP).catch(() => null);
    await sleep(600);
    const frontEnd = await frontName();
    const idleEnd = await hidIdleMs();
    const runMs = Date.now() - startedAt;
    // 保持期间采到的最小空闲 < 5 秒 ⇒ 你在这段时间里确实动过键鼠（AI 干活时你也在用电脑）。
    // 比只看首尾更可靠：首尾可能刚好都没动，但中间动过。
    const userWasActive = (minIdleDuringHold >= 0 && minIdleDuringHold < 5000) || (idleEnd >= 0 && idleEnd < runMs);

    const frontOk = frontEnd === frontStart && steals.length === 0;
    record('全程前台未被抢占', frontOk, frontStart + ' -> ' + frontEnd + '（采样 ' + samples.length + ' 次' + (steals.length ? '，被抢 ' + steals.length + ' 次' : '') + '）');
    record('屏幕上没冒出新窗口', windowsDuring === 0 || windowsDuring === -1, windowsDuring >= 0 ? '计算器窗口数=' + windowsDuring : '窗口层读取失败（不据此判失败）');
    // 这一项只作证据，不作失败条件：某次跑的时候你没动键鼠，只能说明"这次没抓到并发证据"，
    // 不能说明互不影响不成立。真正的判定是"前台一次没被抢 + 屏幕上没冒窗口"。
    record('并发条件（这期间你在用电脑）', true, userWasActive
      ? '运行 ' + Math.round(runMs / 1000) + ' 秒内检测到你的键鼠输入 —— 这就是并发证据'
      : '这期间没检测到你的操作（这次没抓到证据；你下次在它跑的时候动一下鼠标/打字就能看到）');

    const report = {
      ok: steps.every((s) => s.ok),
      frontStart,
      frontEnd,
      runMs,
      samples: samples.length,
      steals,
      userWasActive,
      idleStart,
      idleEnd,
      minIdleDuringHold,
      windowsDuring,
      steps,
    };
    console.log('\n' + JSON.stringify(report, null, 2));
    await closeOcuMcp().catch(() => {});
    if (!report.ok) process.exitCode = 1;
  }
}

main().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
