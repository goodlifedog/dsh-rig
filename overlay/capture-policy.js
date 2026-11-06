'use strict';

/**
 * 抓帧节奏策略（纯函数，便于单测）。
 *
 * 背景：小窗回显的是被控窗口。窗口内容经常长时间不变（看文档、停在某个页面），
 * 这时还按满帧率抓图纯属浪费 CPU 和电。策略是：连续多帧完全一样就逐步降频，
 * 一旦画面有变化立刻回到满帧率。
 */

/**
 * @param {object} input
 *   unchangedFrames 连续未变化的帧数（变化一次就归零）
 *   basePeriod 满帧率时的周期（毫秒）
 *   maxPeriod 降频上限（毫秒，默认 1000）
 * @returns {number} 下一帧应该等多久
 */
function nextCaptureDelay({ unchangedFrames = 0, basePeriod = 70, maxPeriod = 1000 } = {}) {
  const base = Number.isFinite(basePeriod) && basePeriod > 0 ? basePeriod : 70;
  const cap = Number.isFinite(maxPeriod) && maxPeriod > 0 ? maxPeriod : 1000;
  const unchanged = Number.isFinite(unchangedFrames) && unchangedFrames > 0 ? Math.floor(unchangedFrames) : 0;
  // 每多一帧不变，周期翻倍：70 → 140 → 280 → 560 → 1000（封顶）
  const grown = base * Math.pow(2, Math.min(unchanged, 8));
  return Math.min(cap, Math.round(grown));
}

module.exports = { nextCaptureDelay };
