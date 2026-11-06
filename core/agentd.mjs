import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const OCU = process.env.OCU_BIN || path.join(os.homedir(), '.local/bin/ocu');
const OVERLAY = process.env.OVERLAY_URL || 'http://127.0.0.1:7788';
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
  try {
    const res = await fetch(OVERLAY + pathname, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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
  status: (text, state) => post('/status', { text, state }),
  window: (windowId) => post('/window', { windowId }),
  visible: (visible) => post('/visible', { visible }),
  frame: (dataUrl, note, cursor) => post('/frame', { dataUrl, note, cursor }),
  expand: () => post('/expand', {}),
  close: () => post('/close', {}),
  async health() {
    try {
      const res = await fetch(OVERLAY + '/health?session=' + encodeURIComponent(AGENT_SESSION), { signal: AbortSignal.timeout(1500) });
      return await res.json();
    } catch { return { ok: false, offline: true }; }
  },
  async sessions() {
    try {
      const res = await fetch(OVERLAY + '/sessions', { signal: AbortSignal.timeout(1500) });
      return await res.json();
    } catch { return { ok: false, offline: true }; }
  },
  async findWindow(pattern) {
    try {
      const res = await fetch(OVERLAY + '/windows', { signal: AbortSignal.timeout(3000) });
      const data = await res.json();
      const re = pattern instanceof RegExp ? pattern : new RegExp(pattern, 'i');
      return (data.windows || []).find((w) => re.test(w.title || '')) || null;
    } catch { return null; }
  },
};

// ---------- ocu 封装 ----------
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
    const file = path.join(os.tmpdir(), 'ocu-calls-' + process.pid + '.json');
    const fs = await import('node:fs/promises');
    await fs.writeFile(file, JSON.stringify(list));
    const { stdout, stderr } = await run(OCU, ['call', '--calls-file', file, '--sleep', String(sleep)], { timeout: 180000 });
    await fs.unlink(file).catch(() => {});
    return stdout + stderr;
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
        stale = Date.now() - st.mtimeMs > staleMs;
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

  try {
    return await fn();
  } finally {
    try { fs.unlinkSync(file); } catch {}
  }
}

// ---------- 安全护栏 ----------
export async function guard(targetApp, fn, { label = '' } = {}) {
  const before = await ocu.frontmost();
  if (before === targetApp) {
    throw new Error('目标应用当前就是前台，为避免干扰用户，拒绝在后台执行：' + targetApp);
  }
  const result = await fn();
  const after = await ocu.frontmost();
  if (after === targetApp) {
    await overlay.log('警告：操作期间 ' + targetApp + ' 变成了前台，已中止后续动作');
    throw new Error('前台发生了变化：' + targetApp + ' 被激活，操作已中止');
  }
  if (label) await overlay.log(label + '（前台始终：' + after + '）');
  return { result, before, after };
}

export function parseJobs(axText) {
  const jobs = [];
  const lines = axText.split('\n');
  for (const line of lines) {
    const m = line.match(/link \[([^\]]+)\]\(https:\/\/www\.zhipin\.com\/job_detail\/([^)]+)\)/);
    if (m) jobs.push({ title: m[1].trim(), url: 'https://www.zhipin.com/job_detail/' + m[2] });
  }
  const seen = new Set();
  return jobs.filter((j) => (seen.has(j.url) ? false : (seen.add(j.url), true)));
}

export function countElements(axText) {
  return (axText.match(/^\s*\d+ /gm) || []).length;
}