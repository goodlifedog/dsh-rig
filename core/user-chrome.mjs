'use strict';
/**
 * 操作用户自己的 Chrome（默认对象）。
 * 原则：只读界面、点它的坐标、给它按键，全程不抬窗口、不切标签页、不抢焦点。
 * 不用 AppleScript 切标签（那会改变用户看到的内容）。
 *
 * 拟人化分两层（细节在 core/humanize.mjs）：
 *   - 落点：先手抖，再按贝塞尔曲线「分步移动」过去，最后才点；
 *   - 节奏：动手前顿一下、段间随机延迟、输入偶发打错字再退格纠正。
 * macOS 后台路径没有「移动鼠标」这个图元（ocu 只暴露 click/type/press_key），
 * 所以轨迹在这里表现为「逐步等待 + 落点规划」，并由调用方通过 emitMove 决定谁来画：
 * 能画的地方（CDP 页面鼠标 / 小窗虚拟光标）传 emitMove，画不了就只保留节奏。
 */
import { execFile } from 'node:child_process';
import { getOcuMcp } from './ocu-mcp.mjs';
import {
  jitterPoint,
  preActionPause,
  betweenActions,
  humanType,
  buildTrajectory,
  playTrajectory,
  sleep,
  rand,
} from './humanize.mjs';

export const CHROME_APP = process.env.CHROME_APP || 'Google Chrome';

/** 记忆上一次落点，作为下一次移动的起点（和真人一样，光标是从上一处走过来的） */
let cursor = { x: rand(200, 600), y: rand(200, 400) };

export function getCursor() {
  return { ...cursor };
}

export function resetCursor() {
  cursor = { x: rand(200, 600), y: rand(200, 400) };
  return { ...cursor };
}

async function mcp() { return getOcuMcp(); }

/**
 * 截图像素差：macOS 的 AX 坐标是「逻辑点」，ocu 的坐标点击要的是「截图像素」，
 * Retina 屏上差 2 倍。ocu 还要求坐标点击前必须先取一张截图，
 * 所以这里一次拿全：PNG 尺寸 + 窗口点尺寸 → scale。
 */
function pngSize(b64) {
  const buf = Buffer.from(b64, 'base64');
  if (buf.length < 24 || buf.slice(1, 4).toString() !== 'PNG') return null;
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

const shotCache = new Map();

async function frontLine() {
  const m = await mcp();
  const r = await m.callTool('list_apps', {}, 20000);
  return (r.text || '').split('\n')[0] || '';
}

/** list_apps 每行是「应用名 — bundleId [frontmost, running, last-used=..., uses=NNN]」，
 *  uses 计数会变，比较「前台是否变了」只能比应用身份，不能比整行文本。 */
export function frontAppName(line) {
  return (line || '').split(' — ')[0].trim();
}

/** 取一张截图并算出「点 → 像素」的缩放；同时也是 ocu 坐标点击的前置条件 */
export async function ensureScreenshot(app = CHROME_APP, options = {}) {
  const m = await mcp();
  // 取截图会不会把目标应用抬到前台，是这条链路的关键风险点：截图前后各看一次前台。
  // （实测：对后台 TextEdit 取截图不会置前；对后台 Chrome 取截图后曾出现前台上到 Chrome。）
  const frontBefore = options.skipFrontCheck ? null : await frontLine();
  const st = await m.callTool('get_app_state', {
    app,
    include_screenshot: true,
    max_tree_nodes: options.maxNodes || 400,
    text_limit: options.textLimit || 60,
  }, options.timeoutMs || 45000);
  const img = ((st.raw && st.raw.content) || []).find((c) => c && c.type === 'image' && typeof c.data === 'string');
  if (!img) throw new Error('ocu 没有返回截图，无法做坐标换算: ' + app);
  const png = pngSize(img.data);
  const q = await m.callTool('query', { app, role: 'window', limit: 1, max_nodes: options.maxNodes || 800 });
  const win = q.json && q.json.matches && q.json.matches[0] ? q.json.matches[0].bounds : null;
  const scale = png && win && win.w ? png.w / win.w : 1;
  const frontAfter = options.skipFrontCheck ? null : await frontLine();
  const info = {
    app,
    png,
    window: win,
    scale: Math.round(scale * 100) / 100,
    bytes: Math.round((img.data.length * 3) / 4),
    front: frontBefore === null
      ? null
      : { before: frontBefore, after: frontAfter, changed: frontAppName(frontBefore) !== frontAppName(frontAfter) },
    at: Date.now(),
  };
  shotCache.set(app, info);
  return info;
}

/** 最近一次截图换算结果（没有就返回 null，不主动截图） */
export function screenshotInfo(app = CHROME_APP) {
  return shotCache.get(app) || null;
}

/** 确认用户 Chrome 在运行；没运行就后台启动（-g 不抢焦点） */
export async function ensureUserChrome() {
  const m = await mcp();
  const apps = await m.callTool('list_apps', {});
  if ((apps.text || '').includes(CHROME_APP)) return { ok: true, started: false };
  await new Promise((resolve) => execFile('/usr/bin/open', ['-g', '-a', CHROME_APP], () => resolve()));
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    const again = await m.callTool('list_apps', {});
    if ((again.text || '').includes(CHROME_APP)) return { ok: true, started: true };
  }
  return { ok: false, started: false };
}

/** 读界面树（只读，不影响用户） */
export async function readState(options = {}) {
  const m = await mcp();
  return m.callTool('get_app_state', {
    app: options.app || CHROME_APP,
    include_screenshot: false,
    max_tree_nodes: options.maxNodes || 4000,
    text_limit: options.textLimit || 300,
  }, options.timeoutMs || 45000);
}

/** 按文本/角色找元素，返回带坐标的匹配 */
export async function find(text, options = {}) {
  const m = await mcp();
  const r = await m.callTool('query', {
    app: options.app || CHROME_APP,
    text,
    limit: options.limit || 5,
    max_nodes: options.maxNodes || 4000,
    exact: Boolean(options.exact),
  }, options.timeoutMs || 45000);
  if (!r.json || !Array.isArray(r.json.matches)) return { matches: [], windowId: null };
  return { matches: r.json.matches, windowId: r.json.window_id };
}

/**
 * 坐标点击的准入策略（规矩已定死）：
 *   - 对用户自己的 App：**禁止** include_screenshot=true，因此也禁止坐标点击；
 *     统一走 element_index + accessibility 点击（不需要截图）。
 *   - 对我们自己的 headless / 离屏实例：它们没有窗口，坐标点击由 CDP 提供，
 *     不经过这条系统截图路径。
 *   - 只有调用方显式传 allowScreenshot:true（明确知道会把窗口抬前台的风险）才放行老路径。
 */
export function coordinateClickPolicy(options = {}) {
  if (options.pixels === true) {
    return { allowed: true, reason: 'pixels:true：调用方直接给截图像素，自证截图来源是离屏实例' };
  }
  if (options.allowScreenshot === true) {
    return { allowed: true, reason: 'allowScreenshot:true：调用方显式接受系统截图与置前风险' };
  }
  return {
    allowed: false,
    reason: '禁止对用户 App 截图：坐标点击需要 include_screenshot=true，会把窗口抬到前台。请改用 element_index + accessibility 点击（clickText/clickElement）',
  };
}

/**
 * 拟人点击一个坐标：仅在离屏/headless 或显式 allowScreenshot 时可用。
 *
 * 步骤：先顿一下（看一眼）→ 手抖定落点 → 沿曲线分步「移动」过去（每步带耗时）
 *      → 到点后点下去，并记住落点作为下次起点。
 *
 * @param {object} options
 *   human:false      完全拟人关掉，直接精确点击（调试用）
 *   jitter           落点抖动半径（默认 3px，0 = 精确）
 *   emitMove         可选 async (point, i) => {}，谁来执行「移动这步」
 *   rng              随机源，传 makeRng(seed) 可复现同一条轨迹
 *   allowScreenshot  显式允许系统截图（默认 false：用户 App 一律拒绝）
 */
export async function clickAt(x, y, options = {}) {
  const policy = coordinateClickPolicy(options);
  if (!policy.allowed) {
    return { ok: false, disallowed: true, error: policy.reason, hint: 'clickText(text) 或 clickElement(index) 走 AX 语义点击' };
  }
  const m = await mcp();
  const app = options.app || CHROME_APP;
  const rng = options.rng || Math.random;
  const clickMethod = options.fallback === 'app_post' ? 'app_post' : 'sky_click';

  // x/y 默认是 AX 逻辑点坐标；传 pixels:true 则按截图像素直传（和 ocu 原生口径一致）
  const toPixels = (p, shot) => {
    if (options.pixels) return { x: Math.round(p.x), y: Math.round(p.y) };
    const scale = shot && shot.scale ? shot.scale : 1;
    return { x: Math.round(p.x * scale), y: Math.round(p.y * scale) };
  };

  if (options.human === false) {
    const shot = options.pixels ? null : await ensureScreenshot(app, options);
    const px = toPixels({ x, y }, shot);
    const r = await m.callTool('click', { app, x: px.x, y: px.y, click_method: clickMethod, click_count: options.clickCount || 1 }, options.timeoutMs || 45000);
    return { ...r, click: { ...px, pixels: true } };
  }

  // 1. 动手前顿一下
  await preActionPause(options.pauseScale ?? 1, { rng });

  // 2. 规划：先手抖出落点，再从「上次落点」沿曲线走过去
  const landing = jitterPoint(x, y, options.jitter ?? 3, rng);
  const from = options.from || cursor;
  const path = buildTrajectory(from, landing, { rng, speed: options.speed });

  // 3. 分步移动（有 emitMove 就画出来，没有就只走节奏）
  const played = await playTrajectory(path, { emit: options.emitMove, scale: options.speed ?? 1 });
  cursor = played.end;

  // 4. 坐标点击前必须有一张截图（ocu 的硬性要求），顺便拿到换算比例
  const shot = options.pixels ? null : await ensureScreenshot(app, options);

  // 护栏：如果「取截图」这一步把别的应用抬到了前台，就别再点了——宁可不操作，也不抢前台
  if (shot && shot.front && shot.front.changed && options.abortOnFocusChange !== false) {
    return {
      ok: false,
      skipped: true,
      error: '取截图时前台变了，已中止点击: ' + shot.front.before + ' → ' + shot.front.after,
      front: shot.front,
      trajectory: { steps: played.steps, waitedMs: played.waitedMs, movedPx: played.movedPx, landing: played.end },
      raw: '',
    };
  }

  const px = toPixels(played.end, shot);

  // 5. 到点后点下去
  const r = await m.callTool('click', { app, x: px.x, y: px.y, click_method: clickMethod, click_count: options.clickCount || 1 }, options.timeoutMs || 45000);

  return {
    ...r,
    trajectory: {
      steps: played.steps,
      waitedMs: played.waitedMs,
      movedPx: played.movedPx,
      from: { x: Math.round(from.x), y: Math.round(from.y) },
      landing: played.end,
      pixels: px,
      scale: shot ? shot.scale : 1,
    },
  };
}

/**
 * 用 element_index 做 AX 语义点击：不需要截图、不会把窗口抬到前台。
 * 这是操作用户 App 的正路（Chrome 上验证过 app_post/sky_click 都能点网页元素）。
 */
export async function clickElement(index, options = {}) {
  const m = await mcp();
  const app = options.app || CHROME_APP;
  const method = options.clickMethod || 'accessibility';
  if (options.human !== false) await preActionPause(options.pauseScale ?? 1, { rng: options.rng });
  const r = await m.callTool('click', {
    app,
    element_index: String(index),
    click_method: method,
    click_count: options.clickCount || 1,
  }, options.timeoutMs || 45000);
  if (options.human !== false) await betweenActions(options.pauseScale ?? 1, { rng: options.rng });
  return { ...r, index: String(index), method };
}

/** 找到文字后用 AX 语义点击它（默认 accessibility，不截图、不按坐标） */
export async function clickText(text, options = {}) {
  const { matches } = await find(text, options);
  const hit = matches.find((m) => m.index != null && m.bounds && m.bounds.h > 0 && m.bounds.w > 0)
    || matches.find((m) => m.index != null);
  if (!hit) return { ok: false, error: '没找到可点击的匹配: ' + text };
  const r = await clickElement(hit.index, options);
  return { ok: r.ok, hit, index: String(hit.index), method: r.method, text: r.text, raw: r.text };
}

/** 只做「移动」不做点击：给能画光标的地方（CDP 页面 / 小窗虚拟光标）用 */
export async function moveCursorTo(to, options = {}) {
  const from = options.from || cursor;
  const rng = options.rng || Math.random;
  const target = options.jitter === 0 ? { x: Math.round(to.x), y: Math.round(to.y) } : jitterPoint(to.x, to.y, options.jitter ?? 2, rng);
  const path = buildTrajectory(from, target, { rng, speed: options.speed });
  const played = await playTrajectory(path, { emit: options.emitMove, scale: options.speed ?? 1 });
  cursor = played.end;
  return { ...played, path, from };
}

/** 后台按一次退格：sky_key，不激活窗口 */
async function backspaceN(app, count, timeoutMs = 30000) {
  const m = await mcp();
  for (let i = 0; i < count; i++) {
    await m.callTool('press_key', { app, key: 'Backspace', key_method: 'sky_key' }, timeoutMs);
  }
}

/**
 * 后台键入（sky_key），不激活窗口。
 *
 * 拟人：按码点分段、段间随机延迟、偶尔长停顿；默认 5% 概率打错一个字，
 * 退格删掉再敲对的（像真人打字），可用 typoChance: 0 关掉。
 */
export async function typeText(text, options = {}) {
  const m = await mcp();
  const app = options.app || CHROME_APP;
  const timeoutMs = options.timeoutMs || 60000;

  if (options.human === false) {
    return m.callTool('type_text', { app, text, key_method: 'sky_key' }, timeoutMs);
  }

  const startedAt = Date.now();
  const meta = await humanType(
    (part) => m.callTool('type_text', { app, text: part, key_method: 'sky_key' }, timeoutMs),
    text,
    {
      ...options,
      backspace: options.backspace === false ? null : (n) => backspaceN(app, n, timeoutMs),
      typoChance: options.typoChance ?? 0.05,
    },
  );

  return {
    ok: true,
    human: true,
    chars: meta.chars,
    chunks: meta.chunks,
    typos: meta.typos,
    elapsedMs: Date.now() - startedAt,
  };
}

/** 组合动作：先停一下再点，像人一样 */
export async function humanClickText(text, options = {}) {
  await preActionPause(options.pauseScale ?? 1, { rng: options.rng });
  const r = await clickText(text, options);
  await betweenActions(options.pauseScale ?? 1, { rng: options.rng });
  return r;
}

/** 后台按键 */
export async function pressKey(key, options = {}) {
  const m = await mcp();
  const keyMethod = options.keyMethod === false ? undefined : 'sky_key';
  const args = { app: options.app || CHROME_APP, key };
  if (keyMethod) args.key_method = keyMethod;
  return m.callTool('press_key', args, options.timeoutMs || 45000);
}

export default {
  CHROME_APP,
  ensureUserChrome,
  readState,
  find,
  ensureScreenshot,
  screenshotInfo,
  frontAppName,
  coordinateClickPolicy,
  clickAt,
  clickElement,
  clickText,
  moveCursorTo,
  typeText,
  humanClickText,
  pressKey,
  getCursor,
  resetCursor,
};
