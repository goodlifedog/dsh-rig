'use strict';
/**
 * 宿主窗口选择：DSH 既可能是原生窗口，也可能被用户在浏览器里打开 Web 界面。
 *
 * 之前只认 CGWindowList 里 owner === 'DeepSeek Harness' 的窗口；用户改用 Chrome 里的
 * Web 界面时找不到宿主窗口，overlay 就按设计隐藏、抓帧暂停，看起来就是"小窗不出现"。
 *
 * 这里给出纯函数：优先原生宿主窗口；没有时退一步认「浏览器里标题含 DeepSeek Harness 的窗口」，
 * 并用浏览器窗口的标题作为 dshTitle，这样会话标题门控仍然对得上。
 */

const BROWSER_OWNER_RE = /Google Chrome|Chromium|Safari|Microsoft Edge|Arc|Firefox|Brave|Vivaldi/i;
const DSH_TITLE_RE = /DeepSeek\s*Harness/i;
const MIN_W = 200;
const MIN_H = 150;

/**
 * @param {Array<{owner?:string,title?:string,x?:number,y?:number,w?:number,h?:number,layer?:number}>} windows
 * @param {string} hostProcess 宿主进程名（默认 DeepSeek Harness）
 * @returns {{x:number,y:number,w:number,h:number,title:string,owner:string,kind:'native'|'browser'}|null}
 */
function selectHostWindow(windows, hostProcess) {
  const host = String(hostProcess || '');
  const list = (windows || []).filter((w) => {
    if (!w) return false;
    if (Number.isFinite(w.layer) && w.layer !== 0) return false;
    const width = Number(w.w) || 0;
    const height = Number(w.h) || 0;
    return width >= MIN_W && height >= MIN_H;
  });
  const toResult = (w, kind) => ({
    x: Number(w.x) || 0,
    y: Number(w.y) || 0,
    w: Number(w.w) || 0,
    h: Number(w.h) || 0,
    title: String(w.title || ''),
    owner: String(w.owner || ''),
    kind,
  });
  const largest = (arr) => arr.reduce((best, cur) => (!best || (cur.w * cur.h) > (best.w * best.h) ? cur : best), null);

  const native = list.filter((w) => String(w.owner || '') === host);
  if (native.length) return toResult(largest(native), 'native');

  // 浏览器里的 Web 界面：owner 是浏览器，标题里带 DeepSeek Harness（形如 "项目详情 — DeepSeek Harness"）
  const browser = list.filter((w) => BROWSER_OWNER_RE.test(String(w.owner || '')) && DSH_TITLE_RE.test(String(w.title || '')));
  if (browser.length) return toResult(largest(browser), 'browser');

  return null;
}

module.exports = { selectHostWindow, BROWSER_OWNER_RE, DSH_TITLE_RE };
