'use strict';
/**
 * AppleEvent 静默预检（H2）：发 AppleEvent 之前先查「自动化」授权，避免在未授权机器上弹授权框。
 *
 * 背景：控制 System Events / 第三方应用需要 TCC「自动化」授权。首次未授权时直接
 * osascript 会弹系统授权框，而验收/清理是无人值守跑的，弹框会打断用户。
 * core/applescript-driver.mjs 已有基于 AEDeterminePermissionToAutomateTarget 的静默探测
 * （askUserIfNeeded=false，不会弹框）。这里把它收口成一个可注入、可复用的预检 helper，
 * 供 acceptance / browser / headless-demo 等裸 AppleEvent 入口共用（task-57/58）。
 *
 * 关键语义（与清理类调用方不同，务必注意）：
 *   - granted  → 放行，调用方行为与改造前完全一致；
 *   - denied / needs-consent → 明确未授权：跳过该 AppleEvent，返回安全兜底值并给出 warning；
 *   - unknown / 超时 / 探测抛错 → 仍然尝试。探测抖动不能导致前台还原/窗口读取失效，
 *     那比偶发一次系统授权框风险更大（如果真没授权，osascript 自己会失败并被原逻辑 catch）。
 *   - 单次预检默认 800ms 硬超时；探测失败不阻塞 AppleEvent 原逻辑。
 */

/** 这些 AppleScript 实际 tell 的是 System Events，自动化授权要查它的 bundle id。 */
export const SYSTEM_EVENTS_BUNDLE_ID = 'com.apple.systemevents';

/** 默认预检超时：短到不阻塞（探测本身通常几十 ms），又足够覆盖首次启动 helper。 */
export const PREFLIGHT_TIMEOUT_MS = 800;

/** checkAutomationPermission 的 status → 允许/跳过（纯函数，便于单测）。 */
export function decideAutomationAllow(status) {
  const s = String(status == null ? '' : status).trim() || 'unknown';
  if (s === 'denied' || s === 'needs-consent') {
    return {
      allow: false,
      skipped: true,
      status: s,
      reason: '自动化未授权（' + s + '），已跳过该 AppleEvent（不弹授权框）',
    };
  }
  // granted / unknown / app-not-running / timeout / 探测异常：都按「未知」放行，
  // 交给原有 osascript 逻辑自己失败/成功，避免一次探测抖动让前台还原失效。
  return { allow: true, skipped: false, status: s, reason: '' };
}

/** 把 checkAutomationPermission 的返回值归一成 granted/denied/unknown。 */
export function normalizeAutomationStatus(result) {
  const status = result && typeof result === 'object' ? String(result.status || '') : '';
  if (status === 'granted') return 'granted';
  if (status === 'denied' || status === 'needs-consent') return 'denied';
  return 'unknown';
}

/** 给 Promise 套硬超时；超时按异常抛出，由调用方按 unknown 处理。 */
export function withTimeout(promise, timeoutMs) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return Promise.resolve(promise);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('preflight-timeout')), timeoutMs);
    Promise.resolve(promise).then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

/** 默认探测：延迟 import，避免不跑验收时也加载 applescript-driver 的整条依赖链。 */
async function defaultCheckAutomationPermission(app, options) {
  const { checkAutomationPermission } = await import('./applescript-driver.mjs');
  return checkAutomationPermission(app, options);
}

/**
 * 创建预检函数（可注入 checkAutomationPermission 便于单测/复用）。
 *
 * @param {{
 *   checkAutomationPermission?: (app:{bundleId:string}, options?:object)=>Promise<{status?:string}>,
 *   bundleId?: string,
 *   timeoutMs?: number,
 *   cacheMs?: number,
 * }} [options]
 * @returns {(input?:{action?:string, bundleId?:string})=>Promise<{allowed:boolean,status:string,warning?:string,error?:string,cached?:boolean}>}
 */
export function createAppleEventPreflight(options = {}) {
  const opts = options || {};
  const check = typeof opts.checkAutomationPermission === 'function'
    ? opts.checkAutomationPermission
    : defaultCheckAutomationPermission;
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : PREFLIGHT_TIMEOUT_MS;
  const defaultBundleId = String(opts.bundleId || SYSTEM_EVENTS_BUNDLE_ID);
  // 授权状态在一次验收里基本稳定：缓存已得出结论的状态，避免每个 helper 都起一次探测进程。
  const cacheMs = Number.isFinite(opts.cacheMs) ? opts.cacheMs : 5000;
  let cached = null;

  return async function preflight(input = {}) {
    const target = String((input && input.bundleId) || defaultBundleId);
    const action = String((input && input.action) || 'AppleEvent');
    if (cached && cached.status !== 'unknown' && cached.bundleId === target && Date.now() - cached.at < cacheMs) {
      if (cached.status === 'granted') return { allowed: true, status: 'granted', cached: true };
      return {
        allowed: false,
        status: 'denied',
        warning: action + '：' + cached.reason,
        cached: true,
      };
    }

    let result = null;
    let probeError = '';
    try {
      result = await withTimeout(
        Promise.resolve().then(() => check({ bundleId: target }, { askUserIfNeeded: false })),
        timeoutMs,
      );
    } catch (error) {
      // 超时/探测失败：按未知放行（仍尝试），不把还原链路弄失效
      probeError = String((error && error.message) || error).slice(0, 120);
    }

    const status = probeError ? 'unknown' : normalizeAutomationStatus(result);
    const decision = decideAutomationAllow(status);
    if (!decision.allow) {
      const warning = action + '：' + decision.reason;
      if (cacheMs > 0) cached = { status: 'denied', at: Date.now(), bundleId: target, reason: decision.reason };
      return { allowed: false, status, warning };
    }
    if (status === 'granted' && cacheMs > 0) cached = { status: 'granted', at: Date.now(), bundleId: target };
    const response = { allowed: true, status };
    if (probeError) response.error = probeError;
    return response;
  };
}

/** 一次性预检（默认 System Events），供简单调用方直接 await。 */
export async function preflightAppleEvent(options = {}) {
  const opts = options || {};
  const preflight = createAppleEventPreflight(opts);
  return preflight({ action: opts.action, bundleId: opts.bundleId });
}

/**
 * 带预检执行一次 AppleEvent：
 *   - 预检明确未授权 → 不执行 run，返回 fallback 并调用 onWarning；
 *   - 预检 granted / unknown / 探测抛错 → 执行 run（行为与改造前一致）；
 *   - run 抛错 → 返回 fallback（保持调用方原来的 catch 语义）。
 *
 * @param {{
 *   action?: string,
 *   bundleId?: string,
 *   preflight?: Function,
 *   run?: Function,
 *   fallback?: any,
 *   onWarning?: (message:string)=>void,
 * }} options
 * @returns {Promise<{ran:boolean, allowed:boolean, status:string, value:any, warning?:string, error?:string}>}
 */
export async function runAppleEventGuarded(options = {}) {
  const opts = options || {};
  const action = String(opts.action || 'AppleEvent');
  const bundleId = String(opts.bundleId || SYSTEM_EVENTS_BUNDLE_ID);
  const preflight = typeof opts.preflight === 'function'
    ? opts.preflight
    : createAppleEventPreflight({ bundleId });
  const onWarning = typeof opts.onWarning === 'function' ? opts.onWarning : () => {};

  let decision;
  try {
    decision = await preflight({ action, bundleId });
  } catch (error) {
    // 预检自身抛错也不能拦事件：按 unknown 仍尝试（还原失效比偶发授权框更糟）
    decision = { allowed: true, status: 'unknown', error: String((error && error.message) || error).slice(0, 120) };
  }

  const denied = decision && decision.allowed === false;
  if (denied) {
    const warning = (decision && decision.warning) || (action + '：自动化未授权，已跳过该 AppleEvent（不弹授权框）');
    onWarning(warning);
    return { ran: false, allowed: false, status: String((decision && decision.status) || 'denied'), value: opts.fallback, warning };
  }

  try {
    const value = await (typeof opts.run === 'function' ? opts.run() : undefined);
    return { ran: true, allowed: true, status: String((decision && decision.status) || 'unknown'), value };
  } catch (error) {
    return {
      ran: true,
      allowed: true,
      status: String((decision && decision.status) || 'unknown'),
      value: opts.fallback,
      error: String((error && error.message) || error).slice(0, 160),
    };
  }
}
