'use strict';
/**
 * 操作用户自己的 Chrome（默认对象）。
 * 原则：只读界面、点它的坐标、给它按键，全程不抬窗口、不切标签页、不抢焦点。
 * 不用 AppleScript 切标签（那会改变用户看到的内容）。
 */
import { execFile } from 'node:child_process';
import { getOcuMcp } from './ocu-mcp.mjs';

export const CHROME_APP = process.env.CHROME_APP || 'Google Chrome';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function mcp() { return getOcuMcp(); }

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
    app: CHROME_APP,
    include_screenshot: false,
    max_tree_nodes: options.maxNodes || 4000,
    text_limit: options.textLimit || 300,
  }, options.timeoutMs || 45000);
}

/** 按文本/角色找元素，返回带坐标的匹配 */
export async function find(text, options = {}) {
  const m = await mcp();
  const r = await m.callTool('query', {
    app: CHROME_APP,
    text,
    limit: options.limit || 5,
    max_nodes: options.maxNodes || 4000,
    exact: Boolean(options.exact),
  }, options.timeoutMs || 45000);
  if (!r.json || !Array.isArray(r.json.matches)) return { matches: [], windowId: null };
  return { matches: r.json.matches, windowId: r.json.window_id };
}

/** 用 sky_click 点一个坐标：窗口不抬起、指针不动、前台不变 */
export async function clickAt(x, y, options = {}) {
  const m = await mcp();
  return m.callTool('click', {
    app: CHROME_APP,
    x: Math.round(x),
    y: Math.round(y),
    click_method: options.fallback === 'app_post' ? 'app_post' : 'sky_click',
    click_count: options.clickCount || 1,
  }, options.timeoutMs || 45000);
}

/** 找到文字并点击它的中心点 */
export async function clickText(text, options = {}) {
  const { matches } = await find(text, options);
  const hit = matches.find((m) => m.bounds && m.bounds.h > 0 && m.bounds.w > 0);
  if (!hit) return { ok: false, error: '没找到可点击的匹配: ' + text };
  const cx = hit.bounds.x + hit.bounds.w / 2;
  const cy = hit.bounds.y + hit.bounds.h / 2;
  const r = await clickAt(cx, cy, options);
  return { ok: r.ok, hit, x: cx, y: cy, raw: r.text };
}

/** 后台键入（sky_key），不激活窗口 */
export async function typeText(text, options = {}) {
  const m = await mcp();
  return m.callTool('type_text', { app: CHROME_APP, text, key_method: 'sky_key' }, options.timeoutMs || 60000);
}

/** 后台按键 */
export async function pressKey(key, options = {}) {
  const m = await mcp();
  return m.callTool('press_key', { app: CHROME_APP, key, key_method: 'sky_key' }, options.timeoutMs || 45000);
}

export default { CHROME_APP, ensureUserChrome, readState, find, clickAt, clickText, typeText, pressKey };
