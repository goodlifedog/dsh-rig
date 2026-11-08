'use strict';
/**
 * 验收期间的「意外应用」兜底：任务把应用拉起来留在后台时，把它收掉。
 *
 * 现场（2026-11-08 16:09 验收）：multi-app 意外拉起了一个原本没在运行的计算器并留在后台；
 * 后面任务退出别的应用时，前台被带到这个计算器上，验收就判「前台被抢占」。
 * 这不是某个任务独有的问题，所以做成验收层的通用兜底：
 *   验收开始采样一次（基线）→ 每跑完一个任务再采样 → 只在基线上「新出现」的才收。
 *
 * 安全边界：
 *   - 只认 TEST_APPS 里的应用，绝不碰用户其它程序；
 *   - 基线里就有的（用户自己开着的）永远不动；
 *   - **应用标识统一归一**（大小写/空白/分隔符不敏感），避免同一个应用换种写法就被当成「新拉起」；
 *   - **基线不可信时一律不动手**（见 sampleRunningApps 的 trusted）；
 *   - 真正的「退出应用」由调用方注入（acceptance.mjs 用 quitAppSync，只发 AppleScript quit）。
 *
 * 这个模块只做纯逻辑 + 可注入采样，方便单测；不 import 任何会动应用的东西。
 */
import { execFileSync as defaultExecFileSync } from 'node:child_process';
import { normalizeFrontName } from './front-restore.mjs';

/**
 * 应用标识归一（P2）。复用前台还原那一套：小写 + 去首尾空白 + 去常见分隔符，
 * 于是 " Calculator " / "calculator" / "CALCULATOR" 都是同一个应用。
 * 注意：这里不做中英文别名翻译——应用的身份以 TEST_APPS 里的**进程名**为准，
 * 采样结果本身就只用进程名，所以不会出现「中文名 vs 英文名」两套标识。
 */
export function normalizeAppName(value) {
  return normalizeFrontName(value);
}

/** 把「名字集合」的几种写法统一成 Set（Set / 数组 / 单个字符串 / 空值） */
export function toNameSet(input) {
  const out = new Set();
  if (input == null) return out;
  if (typeof input === 'string') {
    const name = input.trim();
    if (name) out.add(name);
    return out;
  }
  const iterable = input instanceof Set || Array.isArray(input) ? input : [];
  for (const value of iterable) {
    const name = String(value == null ? '' : value).trim();
    if (name) out.add(name);
  }
  return out;
}

/** 归一化后的「规范名」表：normalized -> TEST_APPS 里那个规范写法（先出现的赢） */
function canonicalMap(testApps) {
  const map = new Map();
  for (const name of toNameSet(testApps)) {
    const key = normalizeAppName(name);
    if (key && !map.has(key)) map.set(key, name);
  }
  return map;
}

/**
 * 把一个名字映射成「归一 key + 规范写法」。
 * 给了 testApps 时，不在名单里的应用直接返回 null（不归我们管，绝不碰）。
 */
function canonicalize(name, allowedMap) {
  const raw = String(name == null ? '' : name).trim();
  if (!raw) return null;
  const key = normalizeAppName(raw);
  if (!key) return null;
  if (!allowedMap) return { key, name: raw };
  const display = allowedMap.get(key);
  if (!display) return null;
  return { key, name: display };
}

/**
 * 核心判定（纯函数）：返回「before 时没在跑、after 时在跑」的应用名。
 *
 * 比较用归一化后的标识（P2）：大小写、首尾空白、空格/连字符/下划线/点 都不影响判定；
 * 命名单里有的应用，输出统一用名单里的规范写法。
 *
 * @param {Iterable<string>} before 验收开始时的运行集合
 * @param {Iterable<string>} after  现在的运行集合
 * @param {Iterable<string>} [testApps] 只认这批应用；不传则不限制
 * @returns {string[]} 新增的应用名（顺序按 after 的遍历顺序，便于断言）
 */
export function diffNewlyRunning(before, after, testApps) {
  const allowedMap = testApps == null ? null : canonicalMap(testApps);
  const was = new Set();
  for (const name of toNameSet(before)) {
    const item = canonicalize(name, allowedMap);
    if (item) was.add(item.key);          // 本来就在跑 → 可能是用户自己的，绝不动
  }
  const out = [];
  const seen = new Set();
  for (const name of toNameSet(after)) {
    const item = canonicalize(name, allowedMap);
    if (!item || was.has(item.key) || seen.has(item.key)) continue;
    seen.add(item.key);
    out.push(item.name);
  }
  return out;
}

/**
 * 某个应用现在是否在跑（pgrep -x，精确匹配进程名）。
 * 用 execFileSync 注入便于单测；pgrep 退出码非 0 = 没在跑。
 */
export function isAppRunning(name, options = {}) {
  const appName = String(name == null ? '' : name).trim();
  if (!appName) return false;
  const opts = options || {};
  const exec = opts.execFileSync || defaultExecFileSync;
  try {
    exec('/usr/bin/pgrep', ['-x', appName], { timeout: opts.timeoutMs || 2000, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * 采样一批测试应用的运行集合。
 *
 * P3：返回结果带可信度。因为「基线为空」有两种完全不同的原因：
 *   - 真的一个都没在跑（可信，之后出现的确实都是新拉起的）；
 *   - 采样本身没跑成（非 macOS / pgrep 全挂 → 空集但不可信）。
 * 后者如果当成真基线，就会把用户本来就开着的应用全列成「新增」然后退掉。
 *
 * @param {Iterable<string>} testApps
 * @param {{isRunning?:Function, execFileSync?:Function, timeoutMs?:number, platform?:string}} [options]
 * @returns {{apps:Set<string>, trusted:boolean, reason:string, probes:number, errors:number}}
 */
export function sampleRunningApps(testApps, options = {}) {
  const opts = options || {};
  const platform = opts.platform || process.platform;
  const apps = [...toNameSet(testApps)];
  const running = new Set();

  // 非 macOS 不跑 pgrep（不猜别的平台的进程名语义）；此时「空集」不代表「真没在跑」
  if (platform !== 'darwin') {
    return { apps: running, trusted: false, reason: '非 macOS，无法用 pgrep 采样', probes: 0, errors: 0 };
  }

  const probe = typeof opts.isRunning === 'function'
    ? opts.isRunning
    : (name) => isAppRunning(name, opts);

  let errors = 0;
  for (const name of apps) {
    let hit = false;
    try {
      hit = Boolean(probe(name));
    } catch {
      errors += 1;                        // 单个探测失败不影响其它应用
    }
    if (hit) running.add(name);
  }

  let trusted = true;
  let reason = '';
  if (apps.length > 0 && errors === apps.length) {
    trusted = false;
    reason = '全部探测失败';
  } else if (errors > 0 && running.size === 0) {
    trusted = false;
    reason = '探测失败且一个应用都没采到';
  }
  return { apps: running, trusted, reason, probes: apps.length, errors };
}

/**
 * 这一轮到底要不要执行「收掉意外应用」的决策（纯函数，P3）。
 *
 * 只要基线或本次采样有一个不可信，就一律不动手：宁可少收一个残留应用，
 * 也不能把用户本来开着的应用当成「任务拉起的」退掉。
 *
 * @param {boolean} baselineTrusted 验收开始时那次采样是否可信
 * @param {{trusted?:boolean, reason?:string}|null} [sample] 本次采样结果；传 null 表示只看基线
 * @returns {{run:boolean, reason:string}}
 */
export function shouldRunCleanup(baselineTrusted, sample) {
  if (!baselineTrusted) return { run: false, reason: '基线不可信' };
  if (!sample) return { run: true, reason: '' };
  if (!sample.trusted) return { run: false, reason: String(sample.reason || '本次采样不可信') };
  return { run: true, reason: '' };
}

/**
 * 收尾写进报告的那句话（纯函数）。
 * @param {string[]} names
 * @param {string} [stage] 哪个阶段发现的（如「任务 multi-app 之后」「验收收尾」）
 */
export function cleanupMessages(names, stage = '') {
  const list = [...toNameSet(names)];
  return list.map((name) => '收掉验收期间被拉起的 ' + name + (stage ? '（' + stage + '）' : ''));
}
