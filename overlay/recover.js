'use strict';
/**
 * 抓帧目标恢复：目标窗口关掉又重开时 windowId 会变。
 *
 * 之前的行为：连续抓帧失败到阈值后只把状态切成 error，既不解绑也不重新找窗口，
 * 于是小窗一直卡在「目标窗口已失效」，直到调用方主动重新绑定。
 *
 * 这里给出纯函数：根据上次绑定的 owner/title 在最新窗口列表里找"同一个应用的新窗口"。
 */

/**
 * @param {Array<{windowId:number, owner?:string, title?:string}>} windows 最新窗口列表
 * @param {{windowId?:number, owner?:string, title?:string}|null} hint 上次绑定的窗口信息
 * @param {{excludeIds?:Set<number>, selfIds?:Set<number>}} [options]
 * @returns {object|null} 最匹配的窗口
 */
function pickReplacementWindow(windows, hint, options = {}) {
  const opts = options || {};
  const exclude = opts.excludeIds || new Set();
  const self = opts.selfIds || new Set();
  const list = (windows || []).filter((w) => w && w.windowId && !exclude.has(w.windowId) && !self.has(w.windowId));
  if (!list.length || !hint) return null;
  const owner = String(hint.owner || '');
  const title = String(hint.title || '');
  const scored = list.map((w) => {
    let score = 0;
    const wo = String(w.owner || '');
    const wt = String(w.title || '');
    if (owner) {
      if (wo === owner) score += 3;
      else if (wo && (wo.includes(owner) || owner.includes(wo))) score += 2;
    }
    if (title) {
      if (wt === title) score += 2;
      else if (wt && (wt.includes(title) || title.includes(wt))) score += 1;
    }
    if (hint.windowId && w.windowId === hint.windowId) score += 1;
    return { w, score };
  });
  const bestScore = scored.reduce((m, x) => Math.max(m, x.score), 0);
  if (bestScore <= 0) return null;
  const winners = scored.filter((x) => x.score === bestScore);
  // 并列时不要盲选：两个都叫「备忘录」的窗口谁是谁分不清，宁可解绑让调用方重新绑定
  if (winners.length !== 1) return null;
  return winners[0].w;
}

module.exports = { pickReplacementWindow };
