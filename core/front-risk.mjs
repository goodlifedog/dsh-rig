'use strict';
/**
 * 前台风险名单：记录「读界面会把应用自己顶到前台」的应用。
 *
 * 为什么需要它：有些应用（Ghostty/ChatGPT/QQ/Gemini 实测）在被 AX 读取后自己 activate，
 * 虽然 readSafe 会立刻把前台还原，但用户还是看到一次闪动。矩阵这种批量读取会把所有
 * 这类应用都闪一遍，非常打扰。所以：一旦实测到某应用抢过前台，就把它记进名单，
 * 后续矩阵/通道协商直接跳过它的界面读取（改成只抓画面或标环境跳过），不再反复闪。
 *
 * 名单是「按证据加、可随时清」的：应用升级后可能不抢了，npm run front:risk -- --clear "应用名" 即可重测。
 * 存 ~/.desktop-agent/front-risk.json（600），默认 30 天后自动过期，避免永久误伤。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const RISK_VERSION = 1;
export const DEFAULT_TTL_DAYS = 30;
export const DEFAULT_THRESHOLD = 1;

/** 名单文件位置 */
export function riskFile() {
  return path.join(os.homedir(), '.desktop-agent', 'front-risk.json');
}

export function emptyRiskState() {
  return { version: RISK_VERSION, apps: {} };
}

/**
 * 解析名单文件内容；坏文件当空名单处理（不能因为一个损坏的 json 让所有读取都失败）。
 * @param {string} text
 */
export function parseRiskState(text) {
  let data = null;
  try { data = JSON.parse(String(text || '')); } catch { return emptyRiskState(); }
  if (!data || typeof data !== 'object' || !data.apps || typeof data.apps !== 'object') return emptyRiskState();
  const apps = {};
  for (const [name, entry] of Object.entries(data.apps)) {
    if (!name || !entry || typeof entry !== 'object') continue;
    const count = Number(entry.count);
    const lastStolenAt = Number(entry.lastStolenAt);
    const expiresAt = Number(entry.expiresAt);
    if (!Number.isFinite(count) || count <= 0 || !Number.isFinite(expiresAt) || expiresAt <= 0) continue;
    apps[name] = {
      count,
      lastStolenAt: Number.isFinite(lastStolenAt) ? lastStolenAt : 0,
      expiresAt,
      reason: typeof entry.reason === 'string' ? entry.reason.slice(0, 120) : '',
    };
  }
  return { version: RISK_VERSION, apps };
}

/**
 * 这个应用现在是否应该跳过界面读取。
 * @param {{apps:Record<string,{count:number,expiresAt:number}>}} state
 * @param {string} app
 * @param {number} [now]
 * @param {{threshold?:number}} [options]
 */
export function isRisky(state, app, now = Date.now(), options = {}) {
  const threshold = Number.isFinite(options.threshold) ? options.threshold : DEFAULT_THRESHOLD;
  const entry = state && state.apps && state.apps[String(app || '')];
  if (!entry) return false;
  return entry.count >= threshold && entry.expiresAt > now;
}

/**
 * 记一次「读取抢前台」。纯函数，返回新状态。
 * @param {object} state
 * @param {string} app
 * @param {number} [now]
 * @param {{ttlDays?:number, reason?:string, count?:number}} [options]
 */
export function noteSteal(state, app, now = Date.now(), options = {}) {
  const name = String(app || '').trim();
  if (!name) return state || emptyRiskState();
  const ttlDays = Number.isFinite(options.ttlDays) && options.ttlDays > 0 ? options.ttlDays : DEFAULT_TTL_DAYS;
  const add = Number.isFinite(options.count) && options.count > 0 ? options.count : 1;
  const base = state && state.apps ? state : emptyRiskState();
  const prev = base.apps[name] || { count: 0, reason: '' };
  const apps = { ...base.apps };
  apps[name] = {
    count: prev.count + add,
    lastStolenAt: now,
    expiresAt: now + ttlDays * 24 * 60 * 60 * 1000,
    reason: String(options.reason || prev.reason || '').slice(0, 120),
  };
  return { version: RISK_VERSION, apps };
}

/**
 * 清名单：传 app 就清一个，不传就全清。
 * @param {object} state
 * @param {string} [app]
 */
export function clearRisk(state, app) {
  const base = state && state.apps ? state : emptyRiskState();
  const name = String(app || '').trim();
  if (!name) return emptyRiskState();
  const apps = { ...base.apps };
  delete apps[name];
  return { version: RISK_VERSION, apps };
}

/**
 * 给人看的名单摘要（含是否已过期）。
 * @param {object} state
 * @param {number} [now]
 */
export function riskSummary(state, now = Date.now()) {
  const apps = state && state.apps ? state.apps : {};
  return Object.entries(apps)
    .map(([name, entry]) => ({
      app: name,
      count: entry.count,
      lastStolenAt: entry.lastStolenAt,
      expiresAt: entry.expiresAt,
      active: entry.expiresAt > now,
      daysLeft: Math.max(0, Math.ceil((entry.expiresAt - now) / (24 * 60 * 60 * 1000))),
      reason: entry.reason || '',
    }))
    .sort((a, b) => (a.active === b.active ? a.app.localeCompare(b.app) : (a.active ? -1 : 1)));
}

export function loadRisk(file = riskFile()) {
  try {
    return parseRiskState(fs.readFileSync(file, 'utf8'));
  } catch {
    return emptyRiskState();
  }
}

export function saveRisk(state, file = riskFile()) {
  const target = file || riskFile();
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch {}
  const tmp = target + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, target);
  try { fs.chmodSync(target, 0o600); } catch {}
  return target;
}

/**
 * 给调用方用的门控对象：matrix / app-resolve 传进来就能"先查名单、再读、读到抢就记"。
 *
 * @param {{file?:string, enabled?:boolean, now?:Function, threshold?:number, ttlDays?:number}} [options]
 */
export function createRiskGate(options = {}) {
  const opts = options || {};
  const file = opts.file || riskFile();
  const enabled = opts.enabled !== false;
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
  const threshold = Number.isFinite(opts.threshold) ? opts.threshold : DEFAULT_THRESHOLD;
  const ttlDays = Number.isFinite(opts.ttlDays) ? opts.ttlDays : DEFAULT_TTL_DAYS;
  let cache = null;
  const ensure = () => {
    if (!cache) cache = loadRisk(file);
    return cache;
  };
  return {
    file,
    enabled,
    shouldSkip(app) {
      if (!enabled) return false;
      return isRisky(ensure(), app, now(), { threshold });
    },
    note(app) {
      if (!enabled) return;
      cache = noteSteal(ensure(), app, now(), { ttlDays });
      try { saveRisk(cache, file); } catch {}
    },
    clear(app) {
      cache = clearRisk(ensure(), app);
      try { saveRisk(cache, file); } catch {}
    },
    state: ensure,
  };
}

/** 从历史矩阵报告里挖「抢过前台」的证据，用于一次性把已知应用种进名单（避免下次又闪一遍） */
export function seedFromMatrixRows(rows, options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  let state = options.state || emptyRiskState();
  const hits = new Map();
  for (const row of rows || []) {
    if (!row || !row.app) continue;
    const stole = row.frontStolen === true || row.frontUnchanged === false || row.captureStoleFront === true;
    if (!stole) continue;
    hits.set(row.app, (hits.get(row.app) || 0) + 1);
  }
  for (const [app, count] of hits) state = noteSteal(state, app, now, { count, reason: '历史矩阵报告实测抢过前台' });
  return state;
}
