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

/** 应用是否在运行：优先按本地化名称问 AppleScript，其次按 bundle id 找进程 */
export async function isAppRunning({ bundleId, appName }) {
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
export async function ensureAppRunning({ bundleId, appName }) {
  const before = await frontName();
  if (await isAppRunning({ bundleId, appName })) {
    return { launched: false, running: true, front: before, frontUnchanged: true };
  }
  let error = '';
  try {
    if (appName) await exec('/usr/bin/open', ['-g', '-a', appName], { timeout: 8000 });
    else await exec('/usr/bin/open', ['-g', '-b', bundleId], { timeout: 8000 });
  } catch (e) {
    error = String(e.message || e);
  }
  // 等进程起来（最多 6 秒）
  for (let i = 0; i < 30; i += 1) {
    if (await isAppRunning({ bundleId, appName })) break;
    await sleep(200);
  }
  const after = await frontName();
  const started = await isAppRunning({ bundleId, appName });
  return {
    launched: started,
    running: started,
    error: started ? '' : (error || '启动后仍检测不到进程'),
    appName,
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
