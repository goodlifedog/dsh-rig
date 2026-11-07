/**
 * 后台控制层：启动、点击、设值、输入，全程不抢前台。
 *
 * 三条通路（按“不打扰用户”的优先级）：
 *   1. AX 语义动作（点击元素 / 给可设置控件设值）—— 不需要截图、不需要前台
 *   2. sky_key 后台键入 —— 部分应用接受（计算器），文档类应用通常要求前台
 *   3. 启动应用用 `open -g`（后台打开，不激活）
 *
 * 每一步都记录窗口前台应用，声称“没变”必须有证据。
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getOcuMcp } from './ocu-mcp.mjs';
import { restoreFront } from './front-watch.mjs';
import { loadCache, saveCache, methodOrder, recordMethod } from './capabilities.mjs';
import { isSafeIdentifier, pidMatchesProcess } from './safety.mjs';
import os from 'node:os';
import path from 'node:path';

const exec = promisify(execFile);

/** 当前前台应用（中文名） */
export async function frontName() {
  try {
    const { stdout } = await exec('/usr/bin/osascript', ['-e', 'tell application "System Events" to get name of first process whose frontmost is true'], { timeout: 4000 });
    return stdout.trim();
  } catch {
    return '(unknown)';
  }
}

/**
 * 应用是否在运行。
 * 进程名（英文可执行名，如 Calculator / Notes）最可靠；其次问 AppleScript 本地化名称；
 * 最后按 bundle id 匹配进程命令行。
 */
export async function isAppRunning({ bundleId, appName, processName }) {
  if (processName) {
    try {
      const { stdout } = await exec('/usr/bin/pgrep', ['-x', processName], { timeout: 3000 });
      if (stdout.trim()) return true;
    } catch {}
  }
  if (appName) {
    try {
      const { stdout } = await exec('/usr/bin/osascript', ['-e', 'application ' + JSON.stringify(appName) + ' is running'], { timeout: 4000 });
      if (/true/i.test(stdout)) return true;
    } catch {}
  }
  if (bundleId) {
    // 用 LaunchServices 判断（application id ... is running），不要用 pgrep -f：
    // pgrep -f 会命中 "com.apple.SafariPlatformSupport.Helper" 这类辅助进程，把没运行的 Safari 当成在跑。
    try {
      const { stdout } = await exec('/usr/bin/osascript', ['-e', 'application id ' + JSON.stringify(bundleId) + ' is running'], { timeout: 4000 });
      if (/true/i.test(stdout)) return true;
      if (/false/i.test(stdout)) return false;
    } catch {}
    // 拿不到明确答案时才退回进程名匹配，但要求是可执行文件路径（排除辅助进程/框架）
    try {
      const { stdout } = await exec('/usr/bin/pgrep', ['-fl', bundleId], { timeout: 3000 });
      if (stdout.split('\n').some((line) => line.includes('/Contents/MacOS/'))) return true;
    } catch {}
  }
  return false;
}

/**
 * 后台启动参数（纯函数）：-g 不切前台，-j 连窗口都不显示。
 *
 * 实测（FastZip / iRightMouse）加 -j 后窗口仍建出来、AX 树照样可读写，
 * 但用户不会再看到一闪而过的窗口。需要旧行为（窗口正常显示）时设 AGENT_LAUNCH_HIDDEN=0。
 */
export function launchFlags(options = {}) {
  const env = (options && options.env) || process.env;
  return env.AGENT_LAUNCH_HIDDEN === '0' ? ['-g'] : ['-g', '-j'];
}

/**
 * 后台启动应用：open -g -j 不激活前台、不闪窗口；返回 { launched, front, frontUnchanged }。
 * 已经在运行的应用直接返回（不去碰它，避免某些应用被 open 唤起时抢前台）。
 */
export async function ensureAppRunning({ bundleId, appName, processName }, options = {}) {
  const opts = options || {};
  const deps = Object.assign({
    frontName,
    isAppRunning,
    sleep,
    openApp: (args) => exec('/usr/bin/open', [...launchFlags(), ...args], { timeout: 8000 }),
  }, opts.deps || {});
  const waitMs = Number.isFinite(opts.waitMs) ? opts.waitMs : 8000;
  const before = await deps.frontName();
  const check = { bundleId, appName, processName };
  if (await deps.isAppRunning(check)) {
    return { launched: false, running: true, front: before, frontUnchanged: true };
  }
  let error = '';
  // 优先按本地化应用名，其次 bundle id；两种都尝试一遍
  const attempts = [];
  if (appName) attempts.push(['-a', appName]);
  if (bundleId) attempts.push(['-b', bundleId]);
  for (const args of attempts) {
    try {
      await deps.openApp(args);
      const deadline = Date.now() + waitMs;
      while (Date.now() < deadline) {
        if (await deps.isAppRunning(check)) break;
        await deps.sleep(250);
      }
      if (await deps.isAppRunning(check)) break;
    } catch (e) {
      error = String(e.message || e);
    }
  }
  const after = await deps.frontName();
  const started = await deps.isAppRunning(check);
  return {
    launched: started,
    running: started,
    error: started ? '' : (error || '启动后仍检测不到进程'),
    appName,
    processName,
    front: after,
    frontUnchanged: before === after,
    before,
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 确保应用不仅有进程、还有一个可读窗口。
 *
 * 为什么单列一个函数：应用「在跑但没有窗口」是常见状态——用户关掉了最后一个文档、
 * 之前的测试把窗口关了、应用以 -j 隐藏启动后从没建过窗口。这时 ensureAppRunning 看到
 * 进程在就返回了，waitForWindow 却永远等不到窗口，任务只能报「应用没启动」，
 * 而这个结论是错的（实际是应用壳在、窗口没了）。实测：文本编辑就会停在这个状态，
 * 后台稳定性检查因此整项跳过。
 *
 * 处理办法：进程在但没窗口时，用 open -g -j 再唤一次（不抢前台、不显示），
 * 让应用自己新建/重新显示窗口；仍然没有就如实返回 window:false。
 *
 * @param {{bundleId:string, appName:string, processName:string}} app
 * @param {{waitMs?:number, windowMs?:number, deps?:object}} [options]
 * @returns {Promise<{launched:boolean, running:boolean, window:boolean, windows:number, summoned:boolean, front:string, frontUnchanged:boolean, error:string}>}
 */
export async function ensureAppWindow(app, options = {}) {
  const opts = options || {};
  const deps = Object.assign({
    ensureAppRunning,
    waitForWindow,
    openApp: (args) => exec('/usr/bin/open', [...launchFlags(), ...args], { timeout: 8000 }),
    frontName,
    sleep,
  }, opts.deps || {});
  const waitMs = Number.isFinite(opts.waitMs) ? opts.waitMs : 8000;
  const windowMs = Number.isFinite(opts.windowMs) ? opts.windowMs : 12000;
  const name = app.appName || app.processName;
  const altNames = [app.processName, app.appName].filter(Boolean);
  const before = await deps.frontName();

  const run = await deps.ensureAppRunning(app, { waitMs });
  if (!run.running) return Object.assign({}, run, { window: false, windows: 0, summoned: false });

  // 「有没有窗口」有两个口径：System Events 的窗口计数，和真正要用的 AX 界面树。
  // 实测文本编辑会出现「系统窗口数 0、但 ocu 能读到 AXWindow」的状态（窗口在 (0,0)），
  // 只看前者会误判成"应用没启动"。所以 opts.probe 可以作为第二判据（由调用方给）。
  const probe = typeof opts.probe === 'function' ? opts.probe : null;
  const checkReady = async (timeoutMs) => {
    const started = Date.now();
    const counted = await deps.waitForWindow(name, { timeoutMs, altNames });
    if (counted.ok || !probe) return Object.assign({}, counted, { viaProbe: false });
    for (;;) {
      let ok = false;
      try { ok = Boolean(await probe()); } catch {}
      if (ok) return { ok: true, windows: counted.windows, attempts: counted.attempts, waitedMs: Date.now() - started, viaProbe: true };
      if (Date.now() - started >= timeoutMs) return Object.assign({}, counted, { viaProbe: false });
      await deps.sleep(400);
    }
  };

  let ready = await checkReady(Math.min(windowMs, 2500));
  let summoned = false;
  if (!ready.ok) {
    // 进程在、窗口没了：让应用自己建一个窗口
    summoned = true;
    const attempts = [];
    if (app.bundleId) attempts.push(['-b', app.bundleId]);
    if (app.appName) attempts.push(['-a', app.appName]);
    for (const args of attempts) {
      try { await deps.openApp(args); } catch {}
      ready = await checkReady(Math.max(2000, windowMs - 2500));
      if (ready.ok) break;
    }
  }

  const after = await deps.frontName();
  return {
    launched: Boolean(run.launched),
    running: true,
    window: ready.ok,
    windows: ready.windows,
    viaProbe: Boolean(ready.viaProbe),
    summoned,
    front: after,
    frontUnchanged: before === after,
    error: ready.ok ? '' : '应用在运行但一直没有可读窗口（已尝试 open 唤起）',
  };
}

async function mcp() {
  return getOcuMcp();
}

/** 读界面树文本 */
export async function state(app) {
  const m = await mcp();
  const r = await m.callTool('get_app_state', { app, include_screenshot: false });
  return String(r.text || (r.raw && r.raw.content && r.raw.content[0] && r.raw.content[0].text) || '');
}

/** 按角色/文本查元素，返回 [{index, title, role, bounds}] */
export async function find(app, { role, text, limit = 10 } = {}) {
  const m = await mcp();
  const args = { app, limit, max_nodes: 8000 };
  if (role) args.role = role;
  if (text) args.text = text;
  const r = await m.callTool('query', args);
  return (r.json && r.json.matches) || [];
}

/** AX 语义点击（不需要截图、不需要前台） */
export async function click(app, elementIndex) {
  const m = await mcp();
  const before = await frontName();
  const r = await m.callTool('click', { app, element_index: String(elementIndex), click_method: 'accessibility' });
  const after = await frontName();
  return { ok: !r.isError, front: after, frontUnchanged: before === after, error: r.isError ? firstText(r) : '' };
}

/** 给可设置控件设值（文本区/输入框） */
export async function setValue(app, elementIndex, value) {
  const m = await mcp();
  const before = await frontName();
  const r = await m.callTool('set_value', { app, element_index: String(elementIndex), value: String(value) });
  const after = await frontName();
  return { ok: !r.isError, front: after, frontUnchanged: before === after, error: r.isError ? firstText(r) : '' };
}

/** 后台键入（部分应用接受，别的会忽略） */
export async function typeText(app, text) {
  const m = await mcp();
  const before = await frontName();
  const r = await m.callTool('type_text', { app, text: String(text), key_method: 'sky_key' });
  const after = await frontName();
  return { ok: !r.isError, front: after, frontUnchanged: before === after, error: r.isError ? firstText(r) : '' };
}

function firstText(r) {
  const c = (r.raw && r.raw.content) || r.content || [];
  const hit = c.find((x) => x && x.type === 'text' && x.text);
  return hit ? String(hit.text).slice(0, 160) : '未知错误';
}

/**
 * 智能输入：不同应用接受的输入方式不一样（计算器吃键盘、文档类吃 AX 设值，
 * 还有的两种都能用）。这里按可靠性顺序尝试，并用「读回来能不能看到」做最终判定，
 * 避免"接口返回成功但其实没写进去"。
 *
 * @param {string} app
 * @param {{elementIndex?: number|string, text: string, verify?: boolean, deps?: object}} options
 * @returns {{ok:boolean, method:string, verified:boolean, attempts:Array}}
 */
export async function smartType(app, options = {}) {
  const opts = options || {};
  const text = String(opts.text == null ? '' : opts.text);
  const deps = Object.assign({ state, setValue, typeText }, opts.deps || {});
  const verify = opts.verify !== false;
  const attempts = [];
  // 尝试顺序：调用方给的 order > 有元素索引时默认 AX 设值优先 > 直接键入
  const order = Array.isArray(opts.order) && opts.order.length
    ? opts.order.slice()
    : (opts.elementIndex != null ? ['set_value', 'type_text'] : ['type_text']);

  // 读回校验：要区分「内容没写进去」和「读不出来」——后者如果继续降级再输入一遍，
  // 很可能造成重复内容（设值其实成功了）。
  const check = async () => {
    try {
      const tree = await deps.state(app);
      return { readable: true, seen: String(tree || '').includes(text) };
    } catch {
      return { readable: false, seen: false };
    }
  };

  for (const method of order) {
    if (method === 'set_value') {
      if (opts.elementIndex == null) continue;
      try {
        const r = await deps.setValue(app, opts.elementIndex, text);
        attempts.push({ method: 'set_value', ok: Boolean(r && r.ok), frontUnchanged: r ? r.frontUnchanged !== false : true });
        if (r && r.ok) {
          if (!verify) return { ok: true, method: 'set_value', verified: null, attempts };
          const c = await check();
          if (c.seen) return { ok: true, method: 'set_value', verified: true, attempts };
          if (!c.readable) return { ok: true, method: 'set_value', verified: null, note: '读回失败，按成功处理以免重复输入', attempts };
        }
      } catch (error) {
        attempts.push({ method: 'set_value', ok: false, error: String(error && error.message || error).slice(0, 80) });
      }
      continue;
    }
    if (method === 'type_text') {
      try {
        const r = await deps.typeText(app, text);
        attempts.push({ method: 'type_text', ok: Boolean(r && r.ok), frontUnchanged: r ? r.frontUnchanged !== false : true });
        if (r && r.ok) {
          if (!verify) return { ok: true, method: 'type_text', verified: null, attempts };
          const c = await check();
          if (c.seen) return { ok: true, method: 'type_text', verified: true, attempts };
          if (!c.readable) return { ok: true, method: 'type_text', verified: null, note: '读回失败，按成功处理以免重复输入', attempts };
        }
      } catch (error) {
        attempts.push({ method: 'type_text', ok: false, error: String(error && error.message || error).slice(0, 80) });
      }
    }
  }

  return { ok: false, method: 'none', verified: false, attempts };
}

/**
 * 菜单栏命令：分两步——先点开菜单栏项（File / 文件），再点菜单项（保存）。
 * 为什么必须两步：菜单不展开时，系统根本不会把菜单项放进无障碍树
 * （实测矩阵里 AXMenuItem 数量恒为 0 就是这个原因）。
 *
 * @param {string} app
 * @param {{menu?:string, item:string, deps?:object, menuOpenMs?:number}} options
 */
export async function clickMenuItem(app, options = {}) {
  const opts = options || {};
  const item = String(opts.item == null ? '' : opts.item).trim();
  const menu = String(opts.menu == null ? '' : opts.menu).trim();
  const deps = Object.assign({ find, click }, opts.deps || {});
  const waitMs = Number.isFinite(opts.menuOpenMs) ? opts.menuOpenMs : 250;
  const sleepFn = typeof opts.sleep === 'function' ? opts.sleep : (ms) => new Promise((r) => setTimeout(r, ms));
  if (!item) return { ok: false, reason: '没有指定菜单项文字' };

  // 第一步：点开菜单栏项（给了 menu 才做）
  if (menu) {
    let bars = [];
    try {
      bars = await deps.find(app, { role: 'AXMenuBarItem', text: menu, limit: 8 });
    } catch (error) {
      return { ok: false, reason: '菜单栏查询失败：' + String(error && error.message || error).slice(0, 80) };
    }
    const bar = bars.find((b) => String(b.title || '').trim() === menu) || bars[0];
    if (!bar) return { ok: false, reason: '菜单栏项没找到：' + menu };
    const opened = await deps.click(app, bar.index);
    if (!opened || !opened.ok) return { ok: false, reason: '点开菜单失败：' + menu, menuOpened: false };
    await sleepFn(waitMs);
  }

  // 第二步：点菜单项
  let matches = [];
  try {
    matches = await deps.find(app, { role: 'AXMenuItem', text: item, limit: 12 });
  } catch (error) {
    return { ok: false, reason: '菜单项查询失败：' + String(error && error.message || error).slice(0, 80) };
  }
  const exact = matches.find((m) => String(m.title || '').trim() === item);
  const partial = matches.find((m) => String(m.title || '').includes(item));
  const hit = exact || partial;
  if (!hit) return { ok: false, reason: '菜单项没找到：' + item, menuOpened: Boolean(menu) };
  const r = await deps.click(app, hit.index);
  return { ok: Boolean(r && r.ok), index: hit.index, menuOpened: Boolean(menu), frontUnchanged: r ? r.frontUnchanged !== false : true };
}

/** 窗口控制按钮（关闭 / 最小化 / 缩放）：不同应用角色名不完全一样，两者都找 */
export async function windowControls(app, options = {}) {
  const opts = options || {};
  const deps = Object.assign({ find }, opts.deps || {});
  const buttons = [];
  try {
    const found = await deps.find(app, { role: 'AXButton', limit: 80 });
    for (const b of found) {
      const title = String(b.title || '');
      if (/关闭|close|最小化|minimi[sz]e|缩放|zoom/i.test(title)) buttons.push({ index: b.index, title });
    }
  } catch {}
  return buttons;
}

/**
 * AX 层常见的瞬时错误：元素索引过期、查询失效、超时。
 * 这类错误重试一次通常就好；断言类失败（找不到就是找不到）不该重试。
 */
export function isTransientAxError(message) {
  return /expired|no longer available|stale|invalid element|timeout|timed out|超时|索引.*失效|无法.*响应/i.test(String(message || ''));
}

/**
 * 通用重试封装：只对瞬时错误重试，非瞬时错误立即返回。
 * @param {Function} fn 返回 {ok, ...} 或抛错
 * @param {{retries?:number, delayMs?:number, isTransient?:Function}} [options]
 */
export async function withRetry(fn, options = {}) {
  const retries = Number.isFinite(options.retries) ? options.retries : 1;
  const delayMs = Number.isFinite(options.delayMs) ? options.delayMs : 150;
  const isTransient = typeof options.isTransient === 'function' ? options.isTransient : isTransientAxError;
  let last = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      last = await fn(attempt);
      if (!last || last.ok !== false) return last;
      const reason = last.reason || last.error || '';
      if (!isTransient(reason)) return last;
    } catch (error) {
      last = { ok: false, reason: String(error && error.message || error).slice(0, 160) };
      if (!isTransient(last.reason)) return last;
    }
    if (attempt < retries) await new Promise((r) => setTimeout(r, delayMs));
  }
  return last || { ok: false, reason: '未知失败' };
}

/**
 * 按文字找元素并点击（找不到会重新查一次，应对索引过期）。
 * 比"拿一个索引直接点"稳：索引在两次调用之间可能失效。
 */
export async function clickByText(app, text, options = {}) {
  const opts = options || {};
  const deps = Object.assign({ find, click }, opts.deps || {});
  const target = String(text == null ? '' : text).trim();
  if (!target) return { ok: false, reason: '没有指定元素文字' };

  let lastReason = '没找到元素：' + target;
  const attempts = 2;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    let matches = [];
    try {
      matches = await deps.find(app, { text: target, limit: 10 });
    } catch (error) {
      lastReason = '查询失败：' + String(error && error.message || error).slice(0, 80);
    }
    const exact = matches.find((m) => String(m.title || '').trim() === target);
    const hit = exact || matches.find((m) => String(m.title || '').includes(target));
    if (!hit) {
      if (attempt < attempts - 1) await new Promise((r) => setTimeout(r, 150));
      continue;
    }
    const r = await deps.click(app, hit.index);
    if (r && r.ok) {
      return { ok: true, index: hit.index, frontUnchanged: r.frontUnchanged !== false, attempts: attempt + 1 };
    }
    lastReason = (r && (r.error || r.reason)) || '点击失败';
    if (!isTransientAxError(lastReason)) break;
    if (attempt < attempts - 1) await new Promise((r2) => setTimeout(r2, 150));
  }
  return { ok: false, reason: lastReason };
}

/**
 * 带前台保护的读取。
 *
 * 实测（2026-11-07）：读 Ghostty / ChatGPT 这类应用的界面树时，应用会被顶到前台。
 * 这违反「不影响用户」的原则，所以所有"探索性读取"都应该走这里：
 * 读之前记下前台，读之后如果变了立刻还原，并把「这次读取抢了前台」如实返回。
 */
export async function readSafe(app, options = {}) {
  const opts = options || {};
  const deps = Object.assign({ frontName, state, restoreFront }, opts.deps || {});
  const before = await deps.frontName();
  let text = '';
  let error = '';
  try {
    text = await deps.state(app);
  } catch (e) {
    error = String(e && e.message || e).slice(0, 120);
  }
  const after = await deps.frontName();
  // 有些应用是在 AX 操作完成后才异步激活的：延迟再复查几轮
  const settle = opts.restore === false
    ? { stolen: false }
    : await settleFront(before, { waitMs: 180, retries: 2, deps });
  // 还原统一交给 settleFront 做（它还会兜住"操作完才异步激活"的情况），这里不再重复还原，
  // 否则一次读取会触发两次前台还原，日志和统计都会失真。
  const frontStolen = Boolean(before && after && before !== after) || settle.stolen;
  return { text, error, frontStolen, frontBefore: before, frontAfter: after };
}

/** 带前台保护的元素查询（同 readSafe，防止 query 把应用顶起来） */
export async function findSafe(app, query, options = {}) {
  const opts = options || {};
  const deps = Object.assign({ frontName, find, restoreFront }, opts.deps || {});
  const before = await deps.frontName();
  let matches = [];
  let error = '';
  try {
    matches = await deps.find(app, query || {});
  } catch (e) {
    error = String(e && e.message || e).slice(0, 120);
  }
  const after = await deps.frontName();
  const settle = opts.restore === false
    ? { stolen: false }
    : await settleFront(before, { waitMs: 180, retries: 2, deps });
  // 同 readSafe：还原只由 settleFront 负责，避免重复还原
  const frontStolen = Boolean(before && after && before !== after) || settle.stolen;
  return { matches, error, frontStolen, frontBefore: before, frontAfter: after };
}
/** 能力缓存文件位置 */
export function capabilityFile() {
  return path.join(os.homedir(), '.desktop-agent', 'capabilities.json');
}

/**
 * 带能力缓存的智能输入：按上次成功的方式优先尝试，并把结果写回缓存。
 * 这样同一个应用第二次就不需要盲目试错。
 */
export async function smartTypeWithCache(app, options = {}) {
  const opts = options || {};
  const file = opts.cacheFile || capabilityFile();
  const cache = loadCache(file);
  const order = methodOrder(cache, app, 'type') || (opts.elementIndex != null ? ['set_value', 'type_text'] : ['type_text']);
  const result = await smartType(app, Object.assign({}, opts, { order }));
  if (result.method && result.method !== 'none') {
    saveCache(file, recordMethod(cache, app, 'type', result.method, result.ok));
  }
  return result;
}

/**
 * 调用元素暴露的「次要动作」（secondary action）。
 * 例如备忘录的笔记行有「置顶 / 删除」，Finder 的项有「显示简介」。
 * 这类动作不在菜单里、也不是普通按钮，必须走 AX 的 perform action。
 */
export async function secondaryAction(app, elementIndex, action, options = {}) {
  const opts = options || {};
  const call = typeof opts.call === 'function'
    ? opts.call
    : async (tool, args) => (await getOcuMcp()).callTool(tool, args);
  const before = await frontName();
  let result = { ok: false, error: '' };
  try {
    const r = await call('perform_secondary_action', { app, element_index: String(elementIndex), action: String(action) });
    const failure = r.isError ? firstText(r) : toolFailureText(r);
    result = { ok: !failure, error: failure };
  } catch (error) {
    result = { ok: false, error: String(error && error.message || error).slice(0, 120) };
  }
  const after = await frontName();
  const stolen = before !== after;
  if (stolen) await restoreFront(before);
  return Object.assign(result, { action: String(action), frontUnchanged: !stolen });
}

/** 滚动某个元素（列表/文档），不移动系统指针 */
export async function scrollElement(app, options = {}) {
  const opts = options || {};
  const call = typeof opts.call === 'function'
    ? opts.call
    : async (tool, args) => (await getOcuMcp()).callTool(tool, args);
  const before = await frontName();
  let result = { ok: false, error: '' };
  try {
    const args = { app, direction: opts.direction || 'down', pages: String(opts.pages || 1) };
    if (opts.elementIndex != null) args.element_index = String(opts.elementIndex);
    const r = await call('scroll', args);
    const failure = r.isError ? firstText(r) : toolFailureText(r);
    result = { ok: !failure, error: failure };
  } catch (error) {
    result = { ok: false, error: String(error && error.message || error).slice(0, 120) };
  }
  const after = await frontName();
  const stolen = before !== after;
  if (stolen) await restoreFront(before);
  return Object.assign(result, { frontUnchanged: !stolen });
}

/** 在文本元素里选中一段文字 / 放置光标 */
export async function selectTextIn(app, options = {}) {
  const opts = options || {};
  const call = typeof opts.call === 'function'
    ? opts.call
    : async (tool, args) => (await getOcuMcp()).callTool(tool, args);
  const before = await frontName();
  let result = { ok: false, error: '' };
  try {
    const args = { app, element_index: String(opts.elementIndex) };
    if (opts.text) args.text = String(opts.text);
    if (opts.prefix) args.prefix = String(opts.prefix);
    if (opts.suffix) args.suffix = String(opts.suffix);
    if (opts.selection) args.selection = String(opts.selection);
    const r = await call('select_text', args);
    const failure = r.isError ? firstText(r) : toolFailureText(r);
    result = { ok: !failure, error: failure };
  } catch (error) {
    result = { ok: false, error: String(error && error.message || error).slice(0, 120) };
  }
  const after = await frontName();
  const stolen = before !== after;
  if (stolen) await restoreFront(before);
  return Object.assign(result, { frontUnchanged: !stolen });
}

/**
 * 从工具返回里提取"实际是失败"的信息。
 *
 * 实测（2026-11-07）：perform_secondary_action 在索引过期时返回 isError=false，
 * 但正文里写着 "Query index ... has expired or is no longer available"。
 * 只看 isError 会把失败当成功，所以统一再扫一遍正文里的错误特征。
 */
export function toolFailureText(result) {
  if (!result) return '';
  const content = (result.raw && result.raw.content) || result.content || [];
  const text = content.filter((x) => x && x.type === 'text' && x.text).map((x) => String(x.text)).join('\n');
  const firstLine = text.split('\n').map((s) => s.trim()).filter(Boolean)[0] || '';
  if (/expired or is no longer available|no longer available|not supported|unsupportedTool|is not allowed|failed to|error:/i.test(firstLine)) {
    return firstLine.slice(0, 160);
  }
  return '';
}

/**
 * 延迟复查前台并还原。
 *
 * 实测（2026-11-07）：QQ / Gemini 这类应用是在 AX 操作「完成之后」才异步激活的，
 * 读完立刻比对会漏判。所以操作完先等一小会儿，再连续复查几轮，发现被抢就还原。
 *
 * @param {string} expect 期望的前台应用名
 * @param {{waitMs?:number, retries?:number, deps?:object}} [options]
 * @returns {{stolen:boolean, restores:number, finalFront:string}}
 */
export async function settleFront(expect, options = {}) {
  const opts = options || {};
  const deps = Object.assign({ frontName, restoreFront }, opts.deps || {});
  const waitMs = Number.isFinite(opts.waitMs) ? opts.waitMs : 250;
  const retries = Number.isFinite(opts.retries) ? opts.retries : 3;
  let restores = 0;
  let stolen = false;
  let finalFront = expect;
  for (let i = 0; i < retries; i += 1) {
    await new Promise((r) => setTimeout(r, waitMs));
    const seen = await deps.frontName();
    finalFront = seen;
    if (!expect || !seen || seen === expect) continue;
    stolen = true;
    await deps.restoreFront(expect);
    restores += 1;
  }
  // restored：最终前台是否真的回到了期望值。调用方不能只看"尝试过还原"，要看最终状态。
  return { stolen, restores, finalFront, restored: Boolean(expect) && finalFront === expect };
}


/**
 * 读某个应用的窗口数量（System Events，比 AX 全树快很多）。
 *
 * 为什么要单独一条通路：首启欢迎弹窗会让应用不响应 Apple 事件（Pages Creator Studio 实测
 * 连 count documents 都超时），但 System Events 仍然能读到窗口结构，用它做"窗口好了没"的探测最稳。
 *
 * @returns {Promise<number>} 窗口数；-1 表示查不到（应用没起来 / 无辅助功能权限）
 */
export async function windowCount(app, options = {}) {
  const opts = options || {};
  const timeout = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : 5000;
  const run = (opts.deps && opts.deps.exec) || exec;
  // 显示名和进程名会不一致（Keynote Creator Studio 的进程名是 Keynote），
  // 所以按候选名依次问一遍，谁先问到用谁。
  const candidates = [String(app), ...((opts.altNames || []).filter(Boolean).map(String))];
  for (const name of candidates) {
    // 名字要拼进 AppleScript：含引号/反斜杠/控制字符的一律拒绝，避免脚本注入
    if (!isSafeIdentifier(name)) continue;
    const script = 'tell application "System Events" to tell process ' + JSON.stringify(name) + ' to count windows';
    try {
      const { stdout } = await run('/usr/bin/osascript', ['-e', script], { timeout });
      const n = Number.parseInt(String(stdout).trim(), 10);
      if (Number.isFinite(n) && n >= 0) return n;
    } catch {}
  }
  return -1;
}

/**
 * 等窗口出现。
 *
 * 实测（2026-11-07）：Steam / 抖音 / Antigravity 这类 Electron 应用 open -g 之后
 * 进程先起来、窗口要几秒才建好，立刻采集只会得到"没有窗口"的假结论。
 *
 * @param {string} app 应用名
 * @param {{timeoutMs?:number, intervalMs?:number, deps?:{count?:Function, sleep?:Function}}} [options]
 * @returns {Promise<{ok:boolean, windows:number, waitedMs:number, attempts:number}>}
 */
export async function waitForWindow(app, options = {}) {
  const opts = options || {};
  const altNames = opts.altNames || [];
  const deps = Object.assign({ count: (name) => windowCount(name, { altNames }), sleep }, opts.deps || {});
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : 15000;
  const intervalMs = Number.isFinite(opts.intervalMs) ? opts.intervalMs : 400;
  const started = Date.now();
  let attempts = 0;
  for (;;) {
    attempts += 1;
    const count = await deps.count(app);
    if (count > 0) return { ok: true, windows: count, waitedMs: Date.now() - started, attempts };
    const waitedMs = Date.now() - started;
    if (waitedMs >= timeoutMs) return { ok: false, windows: Math.max(count, 0), waitedMs, attempts };
    await deps.sleep(Math.min(intervalMs, Math.max(0, timeoutMs - waitedMs)));
  }
}

/**
 * 把 System Events 导出的弹窗结构文本解析成对象。
 *
 * 文本格式（每行一条）：WIN|<标题> / IDX|<窗口序号> / TXT|<正文> / BTN|<按钮名>
 *
 * @param {string} text
 * @returns {Array<{index:number, title:string, texts:string[], buttons:string[]}>}
 */
export function parseDialogDump(text) {
  const out = [];
  let cur = null;
  for (const rawLine of String(text || '').split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const sep = line.indexOf('|');
    if (sep < 0) continue;
    const kind = line.slice(0, sep);
    const value = line.slice(sep + 1).trim();
    if (kind === 'WIN') {
      cur = { index: 0, title: value, texts: [], buttons: [] };
      out.push(cur);
    } else if (kind === 'IDX') {
      if (cur) cur.index = Number.parseInt(value, 10) || 0;
    } else if (kind === 'TXT') {
      if (cur && value) cur.texts.push(value);
    } else if (kind === 'BTN') {
      if (cur && value) cur.buttons.push(value);
    }
  }
  return out;
}

/** 首启欢迎/引导弹窗的特征（只有命中它才去点，避免误点"删除并退出"这类危险按钮） */
export const ONBOARDING_TEXT_RE = /欢迎|首次|开始使用|新功能|更新说明|引导|点亮|欢迎使用|Welcome|Get Started|What's New|Onboarding/i;

/** 引导弹窗里可以安全点的按钮（默认不点"存储/删除/取消"这类有副作用的） */
export const ONBOARDING_BUTTON_RE = /^(继续|下一步|开始使用|开始|知道了|我知道了|好的|好|关闭|稍后|跳过|Continue|Next|Get Started|Got it|OK|Start|Skip|Later|Done)$/i;

/**
 * 从按钮列表里挑一个"安全点掉引导"的按钮；挑不到就返回 null（宁可不点）。纯函数，便于单测。
 * @param {string[]} buttons
 * @param {{buttonRe?:RegExp}} [options]
 * @returns {string|null}
 */
export function pickOnboardingButton(buttons, options = {}) {
  const re = (options && options.buttonRe) || ONBOARDING_BUTTON_RE;
  const list = Array.isArray(buttons) ? buttons : [];
  for (const name of list) {
    if (re.test(String(name).trim())) return String(name).trim();
  }
  return null;
}

/**
 * 列出应用的 app-modal 弹窗（首启欢迎页、更新说明这类）。
 * @param {string} app
 * @param {{timeoutMs?:number}} [options]
 * @returns {Promise<Array<{index:number,title:string,texts:string[],buttons:string[]}>>}
 */
export async function dialogs(app, options = {}) {
  if (!isSafeIdentifier(String(app || ''))) return [];
  const timeout = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 8000;
  const script = [
    'tell application "System Events" to tell process ' + JSON.stringify(String(app)),
    'set out to ""',
    'repeat with i from 1 to (count of windows)',
    '  set w to window i',
    '  try',
    '    if (subrole of w) is "AXDialog" then',
    '      set out to out & "WIN|" & (name of w) & linefeed',
    '      set out to out & "IDX|" & i & linefeed',
    '      -- 弹窗内容经常嵌在 group 里，只看窗口直接子元素会漏掉按钮和正文',
    '      repeat with el in (entire contents of w)',
    '        try',
    '          set c to (class of el) as text',
    '          if c is "static text" then',
    '            set v to (value of el) as text',
    '            if v is not "" then set out to out & "TXT|" & v & linefeed',
    '          else if c is "button" then',
    '            set n to (name of el) as text',
    '            if n is not "" then set out to out & "BTN|" & n & linefeed',
    '          end if',
    '        end try',
    '      end repeat',
    '    end if',
    '  end try',
    'end repeat',
    'return out',
    'end tell',
  ].join('\n');
  try {
    const { stdout } = await exec('/usr/bin/osascript', ['-e', script], { timeout });
    return parseDialogDump(stdout);
  } catch {
    return [];
  }
}

/**
 * 按候选名（显示名 + 进程名）收集弹窗并去重。
 * 应用显示名和进程名经常不一致，只问一个名字会漏掉弹窗——退出保护尤其不能漏。
 */
async function collectDialogs(deps, names, options = {}) {
  const out = [];
  const seen = new Set();
  for (const name of (names || []).filter(Boolean).map(String)) {
    let list = [];
    try {
      list = (await deps.dialogs(name, options)) || [];
    } catch {}
    for (const d of list) {
      const key = JSON.stringify([d.index, d.title, d.texts || [], d.buttons || []]);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(d);
    }
  }
  return out;
}

/**
 * 点掉首启欢迎/引导弹窗（只认白名单按钮，宁可不点也不乱点）。
 * @param {string} app
 * @param {{timeoutMs?:number, buttonRe?:RegExp, deps?:object}} [options]
 * @returns {Promise<{dismissed:boolean, button:string, dialog:string, frontUnchanged:boolean}>}
 */
export async function dismissOnboarding(app, options = {}) {
  const opts = options || {};
  const deps = Object.assign({ dialogs, frontName, settleFront, exec: exec }, opts.deps || {});
  const before = await deps.frontName();
  const list = await collectDialogs(deps, [app, ...(opts.altNames || [])], opts);
  for (const d of list) {
    const hay = [d.title, ...(d.texts || [])].join(' ');
    if (!ONBOARDING_TEXT_RE.test(hay)) continue;
    const button = pickOnboardingButton(d.buttons, opts);
    if (!button) continue;
    const clickScript = 'tell application "System Events" to tell process ' + JSON.stringify(String(app)) +
      ' to click button ' + JSON.stringify(button) + ' of window ' + (d.index || 1);
    try {
      await deps.exec('/usr/bin/osascript', ['-e', clickScript], { timeout: 8000 });
    } catch {
      continue;
    }
    const settled = await deps.settleFront(before, { waitMs: 250, retries: 2 });
    return { dismissed: true, button, dialog: String(d.title || d.texts[0] || '').slice(0, 80), frontUnchanged: settled.finalFront === before || !settled.stolen };
  }
  return { dismissed: false, button: '', dialog: '', frontUnchanged: true };
}

/**
 * 关掉应用：先好好退（Apple 事件），退不掉再 TERM 进程。
 *
 * 只该用在我们自己为测试拉起来的应用上——用户正在用的应用不要调这个。
 *
 * @param {{appName?:string, bundleId?:string, processName?:string}} app
 * @param {{graceMs?:number}} [options]
 * @returns {Promise<{quit:boolean, mode:'already-stopped'|'quit'|'term'|'still-running'|'no-pid', detail:string}>}
 */
export async function quitApp(app, options = {}) {
  const opts = options || {};
  const deps = Object.assign({ isAppRunning, sleep, dialogs, exec }, opts.deps || {});
  const graceMs = Number.isFinite(opts.graceMs) ? opts.graceMs : 4000;
  const check = { bundleId: app.bundleId, appName: app.appName, processName: app.processName };
  if (!(await deps.isAppRunning(check))) return { quit: true, mode: 'already-stopped', detail: '' };
  const target = app.bundleId ? 'id ' + JSON.stringify(app.bundleId) : JSON.stringify(String(app.appName || ''));
  try {
    await deps.exec('/usr/bin/osascript', ['-e', 'with timeout of ' + Math.ceil(graceMs / 1000) + ' seconds\ntell application ' + target + ' to quit\nend timeout'], { timeout: graceMs + 2000 });
  } catch {}
  await deps.sleep(600);
  if (!(await deps.isAppRunning(check))) return { quit: true, mode: 'quit', detail: '' };

  // 退不掉时先看有没有「要不要保存」这类弹窗：有就绝不能强杀，
  // 否则用户没保存的内容会被直接丢掉（文本编辑实测就会弹这个）。
  let openDialogs = [];
  try {
    openDialogs = await collectDialogs(deps, [app.appName, app.processName], { timeoutMs: 5000 });
  } catch {}
  const risky = openDialogs.find((d) => /保存|存储|Save|删除|Delete|覆盖|Replace|替换/i.test(
    [d.title, ...(d.texts || []), ...(d.buttons || [])].join(' '),
  ));
  if (risky) {
    const snippet = [risky.title, ...(risky.texts || [])].filter(Boolean).join(' ').slice(0, 60);
    return { quit: false, mode: 'needs-confirm', detail: '有未保存/确认弹窗，未强杀：' + snippet };
  }

  // 弹窗卡住 Apple 事件时优雅退出会失败，按进程名 TERM；拿不到进程名就只能报仍然在跑
  if (app.processName) {
    try {
      const { stdout } = await deps.exec('/usr/bin/pgrep', ['-x', app.processName], { timeout: 3000 });
      const pid = Number.parseInt(String(stdout).trim().split('\n')[0], 10);
      if (Number.isFinite(pid) && pid > 0) {
        // 杀之前再核对一次这个 pid 现在还是不是目标进程：pgrep 和 kill 之间 pid 可能已被复用，
        // 不复核就可能误杀用户别的程序。
        let comm = '';
        try {
          const ps = await deps.exec('/bin/ps', ['-p', String(pid), '-o', 'comm='], { timeout: 3000 });
          comm = String(ps.stdout || '');
        } catch {}
        if (!pidMatchesProcess(comm, app.processName)) {
          return { quit: false, mode: 'pid-mismatch', detail: 'pid ' + pid + ' 已不是 ' + app.processName + '（' + String(comm).trim().slice(0, 60) + '），不杀' };
        }
        await deps.exec('/bin/kill', ['-TERM', String(pid)], { timeout: 3000 });
        // 退出可能要好几秒（ChatGPT/大应用实测 TERM 后 3 秒还没走），给到 6 秒再判失败
        for (let i = 0; i < 20; i += 1) {
          await deps.sleep(300);
          if (!(await deps.isAppRunning(check))) return { quit: true, mode: 'term', detail: 'Apple 事件被弹窗卡住，按进程 TERM' };
        }
      }
    } catch {}
  }
  return { quit: false, mode: 'still-running', detail: '优雅退出和 TERM 都没成功' };
}

