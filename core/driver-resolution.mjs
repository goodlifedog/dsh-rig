'use strict';
/**
 * 通道协商：控制一个应用之前，先问清楚"现在哪条路真的能用"，再决定顺序。
 *
 * 三层结构里这是承上启下的一层：
 *   - 运行时画像（识别层）给出默认通道链
 *   - 这里逐条验前提（应用在不在跑、AX 树有没有内容、CDP 端口开没开、AppleScript 授没授权、窗口在不在）
 *   - 输出一份"可用通道 + 降级顺序 + 每条不可用的原因"，调用方照着走
 *
 * 注意 visual（画面）通道的定位：这里只判断"能不能看到画面"，作为诊断和兜底提示；
 * 本仓库没有实现"按坐标自动点击"，所以它不参与无人值守执行。
 *
 * 安全约定：协商只做只读探测，不启动应用、不发业务 Apple 事件、不点任何东西。
 */
import { RUNTIME_CHAINS, DRIVER_INFO } from './app-runtime.mjs';

/**
 * 按"默认链 + 可用性"排出实际执行顺序（纯函数）。
 *
 * @param {string[]} baseChain 运行时默认链，如 ['ax','cdp','visual']
 * @param {Record<string, boolean>} available 每条通道是否可用
 * @param {{includeUnavailableTail?:boolean}} [options]
 * @returns {{plan:string[], skipped:Array<{driver:string, reason:string}>, reason:string}}
 */
export function choosePlan(baseChain, available, options = {}) {
  const opts = options || {};
  const chain = Array.isArray(baseChain) && baseChain.length ? baseChain : ['ax', 'visual'];
  const plan = [];
  const skipped = [];
  for (const driver of chain) {
    if (available && available[driver]) plan.push(driver);
    else skipped.push({ driver, reason: '不可用' });
  }
  if (!plan.length && opts.includeUnavailableTail !== false) {
    // 一条都不通时不要返回空数组：至少让调用方知道"全都试过但都不行"
    return { plan: [], skipped, reason: '所有通道都不可用（按原因逐条排查）' };
  }
  return { plan, skipped, reason: plan.length ? '' : '没有可用通道' };
}

/** 通道的中文名（给日志和报告用） */
export function driverLabel(driver) {
  const info = DRIVER_INFO[driver];
  return info ? info.label : String(driver);
}

export const DRIVER_ORDER_NOTE = Object.freeze({
  ax: '读界面树并做语义操作，最稳',
  cdp: '走页面调试口，适合 Chromium/Electron 的页面内容',
  applescript: '走应用自带脚本字典，语义清晰但受授权限制',
  visual: '兜底：抓画面 + 坐标',
});

/**
 * 逐条验通道前提，输出协商结果。
 *
 * @param {{appName:string, bundleId:string, appPath?:string, runtime?:string}} app
 * @param {{deps?:object, probeAx?:boolean}} [options]
 * @returns {Promise<{app:object, runtime:string, channels:object[], plan:string[], skipped:object[], usable:boolean}>}
 */
export async function negotiateChannels(app, options = {}) {
  const opts = options || {};
  const deps = Object.assign({
    isRunning: async () => false,
    readSafe: async () => ({ text: '', frontStolen: false }),
    windowCount: async () => -1,
    probeCdp: async () => ({ ok: false, error: '未探测' }),
    sdefCommands: async () => 0,
    automationPermission: async () => ({ status: 'unknown' }),
    debugPortFor: () => 9333,
    overlayWindows: async () => 0,
  }, opts.deps || {});

  const runtime = String(app.runtime || 'native');
  const baseChain = [...(RUNTIME_CHAINS[runtime] || RUNTIME_CHAINS.native)];
  const running = await deps.isRunning({ bundleId: app.bundleId, appName: app.appName, processName: app.processName });

  const channels = [];
  const record = (driver, available, reason) => channels.push({ driver, label: driverLabel(driver), available, reason });

  // 1) AX：应用要在跑，且界面树得有内容
  if (opts.probeAx === false) {
    record('ax', false, '按参数跳过 AX 探测');
  } else if (!running) {
    record('ax', false, '应用没运行，读不到界面树');
  } else {
    try {
      const read = await deps.readSafe(app.appName, { timeoutMs: 3000 });
      const len = String((read && read.text) || '').length;
      record('ax', len > 40, len > 40 ? '界面树可读（' + len + ' 字符）' : '界面树为空或过短（自绘界面常见）');
    } catch (e) {
      record('ax', false, '读取失败：' + String(e && e.message || e).slice(0, 60));
    }
  }

  // 2) CDP：端口得真的开着（应用自己开或我们带参数启动）
  const port = deps.debugPortFor(app.bundleId || app.appName);
  try {
    const cdp = await deps.probeCdp(port, { timeoutMs: 800 });
    record('cdp', Boolean(cdp && cdp.ok), cdp && cdp.ok ? '调试端口已开（' + port + '）' : '调试端口没开：' + String((cdp && cdp.error) || ''));
  } catch (e) {
    record('cdp', false, '探测失败：' + String(e && e.message || e).slice(0, 60));
  }

  // 3) AppleScript：要有字典 + 已授权（没授权绝不发事件）
  try {
    const commands = await deps.sdefCommands(app.appPath || '');
    if (!commands) {
      record('applescript', false, '应用没有脚本字典');
    } else if (!running) {
      record('applescript', false, '应用没运行，授权状态查不到');
    } else {
      const perm = await deps.automationPermission({ bundleId: app.bundleId });
      record('applescript', perm.status === 'granted',
        perm.status === 'granted' ? '已授权（' + commands + ' 条命令）' : '自动化权限：' + perm.status);
    }
  } catch (e) {
    record('applescript', false, '字典/权限检查失败：' + String(e && e.message || e).slice(0, 60));
  }

  // 4) 画面：窗口在不在（兜底通道）。AX 窗口数经常骗人（Finder 明明有窗口却是 0），
  //    所以再问一次系统窗口层（CGWindowList，overlay 提供）。
  if (!running) {
    record('visual', false, '应用没运行，没有窗口可抓');
  } else {
    const n = await deps.windowCount(app.appName);
    let overlayCount = 0;
    try {
      overlayCount = (await deps.overlayWindows(app)) || 0;
    } catch {}
    const usable = n > 0 || overlayCount > 0;
    record('visual', usable,
      usable
        ? '有窗口可抓（AX ' + Math.max(n, 0) + ' / 系统窗口层 ' + overlayCount + '）'
        : '读不到窗口（AX 窗口数为 0，系统窗口层也没有）');
  }

  const available = {};
  for (const c of channels) available[c.driver] = c.available;
  // 每条通道都必须出现在结果里，哪怕默认链里没有它（方便排障时看清"为什么没走这条路"）
  for (const driver of ['ax', 'cdp', 'applescript', 'visual']) {
    if (!channels.some((c) => c.driver === driver)) {
      record(driver, false, '不在该运行时的默认链里');
      available[driver] = false;
    }
  }
  const chosen = choosePlan(baseChain, available);
  const order = ['ax', 'cdp', 'applescript', 'visual'];
  channels.sort((a, b) => order.indexOf(a.driver) - order.indexOf(b.driver));

  return {
    app,
    runtime,
    baseChain,
    channels,
    plan: chosen.plan,
    skipped: chosen.skipped,
    usable: chosen.plan.length > 0,
    note: chosen.reason,
  };
}
