import { overlayBase } from './ports.mjs';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { resolveOcu } from './platform.mjs';
import { tokenHeadersFor } from './local-token.mjs';
import { frontRiskGate } from './background.mjs';
const OCU = resolveOcu() || path.join(os.homedir(), '.local/bin/ocu');
const OVERLAY = overlayBase();
// 当前 agent 所属的 DSH 会话：每个会话召唤自己的小窗，缺省 default（旧行为不变）
const AGENT_SESSION = (process.env.AGENT_SESSION || '').trim() || 'default';

function run(cmd, args, { timeout = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ code: err ? (err.code ?? 1) : 0, stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

// ---------- overlay 客户端（按会话隔离，缺省 default） ----------
async function post(pathname, body) {
  const url = OVERLAY + pathname;
  try {
    const res = await fetch(url, {
      method: 'POST',
      // token 只发给回环地址：OVERLAY_URL 可自定义，非回环默认不带（M-5）
      headers: tokenHeadersFor(url, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ session: AGENT_SESSION, ...(body || {}) }),
      signal: AbortSignal.timeout(1500),
    });
    return await res.json();
  } catch {
    return { ok: false, offline: true };
  }
}

export const overlay = {
  // 当前会话 id；同一个会话的所有推送都落到同一个小窗
  session: AGENT_SESSION,
  log: (text) => post('/log', { text }),
  // titleHint：多会话小窗按"会话标题 = 当前宿主标题"决定显示哪个会话，缺了就会被门控隐藏
  status: (text, state, titleHint) => post('/status', titleHint ? { text, state, titleHint } : { text, state }),
  window: (windowId, title) => post('/window', title ? { windowId, title } : { windowId }),
  visible: (visible) => post('/visible', { visible }),
  frame: (dataUrl, note, cursor) => post('/frame', { dataUrl, note, cursor }),
  expand: () => post('/expand', {}),
  // 小窗当前需要多大的帧（收起 600px / 放大 1920px）：推帧方按它出图，别固定推 2560px
  async frameTarget() {
    try {
      const url = OVERLAY + '/frame-target?session=' + encodeURIComponent(AGENT_SESSION);
      const res = await fetch(url, { headers: tokenHeadersFor(url), signal: AbortSignal.timeout(1500) });
      return await res.json();
    } catch { return { ok: false, offline: true }; }
  },
  close: () => post('/close', {}),
  async health() {
    try {
      const url = OVERLAY + '/health?session=' + encodeURIComponent(AGENT_SESSION);
      const res = await fetch(url, { headers: tokenHeadersFor(url), signal: AbortSignal.timeout(1500) });
      return await res.json();
    } catch { return { ok: false, offline: true }; }
  },
  async sessions() {
    try {
      const url = OVERLAY + '/sessions';
      const res = await fetch(url, { headers: tokenHeadersFor(url), signal: AbortSignal.timeout(1500) });
      return await res.json();
    } catch { return { ok: false, offline: true }; }
  },
  async findWindow(pattern) {
    try {
      const url = OVERLAY + '/windows';
      const res = await fetch(url, { headers: tokenHeadersFor(url), signal: AbortSignal.timeout(3000) });
      const data = await res.json();
      const re = pattern instanceof RegExp ? pattern : new RegExp(pattern, 'i');
      return (data.windows || []).find((w) => re.test(w.title || '')) || null;
    } catch { return null; }
  },
};

// ---------- ocu 封装 ----------

/**
 * 把一批 ocu 调用写到私有临时文件，返回 { dir, file }。
 *
 * 安全（评审 L-1）：以前固定写 /tmp/ocu-calls-<pid>.json，路径可预测——同机别的用户
 * 可以提前在同名路径放符号链接，我们 writeFile 会跟随链接把 JSON 写进（我们拥有的）任意文件。
 * 现在用 mkdtemp 建 0700 私有目录（名字带随机后缀，不可预测），文件 0600，用完整目录删除。
 *
 * @param {Array} list ocu call/--calls-file 的内容
 * @returns {Promise<{dir:string, file:string}>}
 */
export async function writeCallsTempFile(list) {
  const fs = await import('node:fs/promises');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ocu-calls-'));
  try {
    const file = path.join(dir, 'calls.json');
    await fs.writeFile(file, JSON.stringify(list), { mode: 0o600 });
    return { dir, file };
  } catch (error) {
    await removeCallsTempDir(dir);
    throw error;
  }
}

/** 删除 writeCallsTempFile 建的私有目录（失败也吞掉，不掩盖真正错误） */
export async function removeCallsTempDir(dir) {
  if (!dir) return;
  try {
    const fs = await import('node:fs/promises');
    await fs.rm(dir, { recursive: true, force: true });
  } catch {}
}

export const ocu = {
  async listApps() {
    const { stdout } = await run(OCU, ['call', 'list_apps']);
    try {
      const parsed = JSON.parse(stdout);
      return parsed.content?.[0]?.text || '';
    } catch { return stdout; }
  },

  async frontmost() {
    const text = await this.listApps();
    const line = text.split('\n').find((l) => l.includes('[frontmost')) || '';
    return line.split(' — ')[0].trim() || '(unknown)';
  },

  async snapshot(app, { nodes = 6000 } = {}) {
    const { stdout, stderr } = await run(OCU, ['snapshot', '--max-tree-nodes', String(nodes), app]);
    return stdout + (stderr || '');
  },

  async call(tool, args, { timeout = 60000 } = {}) {
    const { stdout, stderr } = await run(OCU, ['call', tool, '--args', JSON.stringify(args)], { timeout });
    try {
      const parsed = JSON.parse(stdout);
      const item = parsed.content?.[0];
      return { ok: true, text: item?.text || '', raw: parsed };
    } catch {
      return { ok: false, text: stdout + stderr, raw: null };
    }
  },

  async calls(list, { sleep = 1 } = {}) {
    // 见 writeCallsTempFile：不再用可预测的 /tmp/ocu-calls-<pid>.json
    const { dir, file } = await writeCallsTempFile(list);
    try {
      const { stdout, stderr } = await run(OCU, ['call', '--calls-file', file, '--sleep', String(sleep)], { timeout: 180000 });
      return stdout + stderr;
    } finally {
      await removeCallsTempDir(dir);
    }
  },
};

// ---------- 应用锁（同一应用串行，不同应用并行） ----------
function slug(name) {
  return String(name).replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 60);
}

function lockPath(app) {
  return path.join(os.tmpdir(), 'agentd-' + slug(app) + '.lock');
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function withAppLock(app, fn, { timeoutMs = 120000, staleMs = 180000 } = {}) {
  const file = lockPath(app);
  const started = Date.now();

  for (;;) {
    try {
      const fd = fs.openSync(file, 'wx');
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      let stale = false;
      try {
        const st = fs.statSync(file);
        // 先看持锁进程还活着没：活着就不算过期，否则长任务（>staleMs）会被后来者抢锁，
        // 两个任务同时控制同一个应用——这正是这把锁要防的事。
        let holder = 0;
        try { holder = Number.parseInt(String(fs.readFileSync(file, 'utf8')).trim(), 10) || 0; } catch {}
        let alive = false;
        if (holder > 0) {
          try { process.kill(holder, 0); alive = true; } catch { alive = false; }
        }
        stale = !alive && Date.now() - st.mtimeMs > staleMs;
      } catch { stale = true; }
      if (stale) {
        try { fs.unlinkSync(file); } catch {}
        continue;
      }
      if (Date.now() - started > timeoutMs) {
        throw new Error('等待应用锁超时：' + app + '（可能有其它任务正在控制它）');
      }
      await sleep(300);
    }
  }

  // 持锁期间心跳续期：mtime 一直被刷新，配合上面的 pid 存活性判断，双保险
  const heartbeat = setInterval(() => {
    try { fs.utimesSync(file, new Date(), new Date()); } catch {}
  }, Math.max(1000, Math.floor(staleMs / 3)));
  if (typeof heartbeat.unref === 'function') heartbeat.unref();

  try {
    return await fn();
  } finally {
    clearInterval(heartbeat);
    try { fs.unlinkSync(file); } catch {}
  }
}

// ---------- 安全护栏 ----------

/** 把前台还原给指定应用；名字不可信（带引号/控制字符）时直接放弃，避免拼出坏 AppleScript */
export async function restoreFrontTo(appName) {
  const name = String(appName || '').trim();
  if (!name || name === '(unknown)' || !/^[^"\\\r\n]{1,120}$/.test(name)) return false;
  try {
    await run('/usr/bin/osascript', ['-e', 'tell application "System Events" to set frontmost of process ' + JSON.stringify(name) + ' to true'], { timeout: 4000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * 后台操作护栏：开始前目标不能已经是前台，操作后目标不能被激活。
 *
 * 只报错不还原是不够的——实测部分应用是在 AX 读取「完成后」才异步激活自己的，
 * 只抛错会把它留在前台，用户看到的就是一次切屏。所以这里检测到被激活时
 * 先把前台还给操作前的应用（尽力而为），再抛错。
 *
 * @param {string} targetApp
 * @param {Function} fn
 * @param {{label?:string, deps?:{frontmost?:Function, restoreFront?:Function, log?:Function}}} [options]
 */
export async function guard(targetApp, fn, options = {}) {
  const opts = options || {};
  const label = opts.label || '';
  const deps = opts.deps || {};
  const frontmost = typeof deps.frontmost === 'function' ? deps.frontmost : () => ocu.frontmost();
  const restoreFront = typeof deps.restoreFront === 'function' ? deps.restoreFront : restoreFrontTo;
  const log = typeof deps.log === 'function' ? deps.log : (text) => overlay.log(text);
  // 被激活的应用记进前台风险名单：以后再读它（readSafe/矩阵/协商）就默认跳过，不再反复闪
  const noteRisk = typeof deps.noteRisk === 'function'
    ? deps.noteRisk
    : (app) => { try { frontRiskGate().note(app); } catch {} };

  const before = await frontmost();
  if (before === targetApp) {
    throw new Error('目标应用当前就是前台，为避免干扰用户，拒绝在后台执行：' + targetApp);
  }
  const result = await fn();
  const after = await frontmost();
  if (after === targetApp) {
    const restored = await restoreFront(before).catch(() => false);
    try { noteRisk(targetApp); } catch {}
    const where = restored ? '已把前台还原到 ' + before : '前台还原失败';
    await log('警告：操作期间 ' + targetApp + ' 变成了前台，' + where + '，已中止后续动作').catch(() => {});
    throw new Error('前台发生了变化：' + targetApp + ' 被激活，' + where + '，操作已中止');
  }
  if (label) await log(label + '（前台始终：' + after + '）');
  return { result, before, after };
}

export function countElements(axText) {
  return (String(axText == null ? '' : axText).match(/^\s*\d+ /gm) || []).length;
}