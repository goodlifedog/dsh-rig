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
    try {
      const { stdout } = await exec('/usr/bin/pgrep', ['-f', bundleId], { timeout: 3000 });
      if (stdout.trim()) return true;
    } catch {}
  }
  return false;
}

/**
 * 后台启动应用：open -g 不激活前台；返回 { launched, front, frontUnchanged }。
 * 已经在运行的应用直接返回（不去碰它，避免某些应用被 open 唤起时抢前台）。
 */
export async function ensureAppRunning({ bundleId, appName, processName }) {
  const before = await frontName();
  const check = { bundleId, appName, processName };
  if (await isAppRunning(check)) {
    return { launched: false, running: true, front: before, frontUnchanged: true };
  }
  let error = '';
  // 优先按本地化应用名，其次 bundle id；两种都尝试一遍
  const attempts = [];
  if (appName) attempts.push(['-a', appName]);
  if (bundleId) attempts.push(['-b', bundleId]);
  for (const args of attempts) {
    try {
      await exec('/usr/bin/open', ['-g', ...args], { timeout: 8000 });
      for (let i = 0; i < 15; i += 1) {
        if (await isAppRunning(check)) break;
        await sleep(200);
      }
      if (await isAppRunning(check)) break;
    } catch (e) {
      error = String(e.message || e);
    }
  }
  const after = await frontName();
  const started = await isAppRunning(check);
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
  const frontStolen = Boolean(before && after && before !== after);
  if (frontStolen && opts.restore !== false) {
    await deps.restoreFront(before);
  }
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
  const frontStolen = Boolean(before && after && before !== after);
  if (frontStolen && opts.restore !== false) {
    await deps.restoreFront(before);
  }
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
