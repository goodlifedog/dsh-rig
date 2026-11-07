'use strict';
/**
 * 操控策略判定：探测完一个应用，自动决定该怎么控它。
 *
 * 这一步是给"以后碰到新软件"用的——不用人肉分析报告，按规则直接得出结论：
 *   ax      元素级驱动（读树 + AX 点击/设值），最稳
 *   ax-read 只能读状态，没有可点元素（自绘窗口、纯展示应用）
 *   visual  读不到树但画面可回显：只能按坐标/快捷键，或者在宿主里用画面做判断
 *   dedicated 走专用通道（Chrome 这类会抢前台，用独立 headless 实例）
 *   no-touch  不接管（用户的关键工具、宿主自己）
 *   blocked 应用侧限制（启动即退、窗口起不来、既读不到也抓不到）
 *   unknown 还没测，或数据不足
 */

export const STRATEGY_LABELS = Object.freeze({
  ax: '元素级驱动',
  'ax-read': '只读状态',
  visual: '画面+坐标',
  dedicated: '专用通道',
  'no-touch': '不接管',
  blocked: '应用侧限制',
  unknown: '未判定',
});

/**
 * @param {object|null} row 探测结果行（readable/nodes/buttons/capture/windowReady/launch...）
 * @param {{special?:{status:string,detail?:string}|null, installed?:boolean, tested?:boolean}} [options]
 * @returns {{mode:string, label:string, reasons:string[], canType:boolean}}
 */
export function recommendStrategy(row, options = {}) {
  const opts = options || {};
  const reasons = [];
  const special = opts.special || null;
  if (special && special.status === '不动') {
    return { mode: 'no-touch', label: STRATEGY_LABELS['no-touch'], reasons: [special.detail || '关键工具，不接管'], canType: false };
  }
  if (special && special.status === '专用方案') {
    return { mode: 'dedicated', label: STRATEGY_LABELS.dedicated, reasons: [special.detail || '走专用通道'], canType: false };
  }
  if (opts.installed === false) {
    return { mode: 'unknown', label: STRATEGY_LABELS.unknown, reasons: ['本机没装，无从判断'], canType: false };
  }
  if (!row || row.skipped) {
    return { mode: 'unknown', label: STRATEGY_LABELS.unknown, reasons: ['还没测'], canType: false };
  }

  const readable = Boolean(row.readable);
  const buttons = Number.isFinite(row.buttons) ? row.buttons : -1;
  const nodes = Number.isFinite(row.nodes) ? row.nodes : 0;
  const capture = String(row.capture || 'none');
  const windowReady = row.windowReady !== false;
  const canType = (Number(row.textFields) || 0) + (Number(row.textAreas) || 0) > 0;

  if (readable) {
    if (buttons > 0) {
      reasons.push('界面树可读（' + nodes + ' 个节点），有 ' + buttons + ' 个可点元素');
      if (row.frontUnchanged === false) reasons.push('注意：探测中抢过前台，动作后要复查');
      return { mode: 'ax', label: STRATEGY_LABELS.ax, reasons, canType };
    }
    reasons.push('界面树可读但没有任何可点元素，只能读状态' + (canType ? '、可以试着写输入框' : ''));
    return { mode: 'ax-read', label: STRATEGY_LABELS['ax-read'], reasons, canType };
  }

  if (capture === 'live' || capture === 'offscreen') {
    reasons.push('读不到界面树' + (windowReady ? '' : '（AX 窗口数为 0）') + '，但画面能回显（' + capture + '）');
    reasons.push('只能按坐标或快捷键操作；坐标依赖窗口位置，容易失效');
    return { mode: 'visual', label: STRATEGY_LABELS.visual, reasons, canType: false };
  }

  if (row.selfExited) {
    reasons.push('启动成功但随后自行退出（应用侧行为），没法接管');
    return { mode: 'blocked', label: STRATEGY_LABELS.blocked, reasons, canType: false };
  }
  if (row.launch === 'error' || !windowReady) {
    reasons.push('启动后窗口起不来（应用侧限制）');
    return { mode: 'blocked', label: STRATEGY_LABELS.blocked, reasons, canType: false };
  }
  reasons.push('既读不到界面树也抓不到画面');
  return { mode: 'blocked', label: STRATEGY_LABELS.blocked, reasons, canType: false };
}
