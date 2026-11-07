/**
 * 重试策略（纯函数）：哪些失败值得再跑一次，哪些别浪费时间。
 *
 * 只对「外部暂时不可用」重试：Chrome 启动慢/端口没起来、临时的系统忙。
 * 用户正在使用目标应用、锁屏、缺权限、页面改版这类，重试也没用，直接算环境结果。
 */

// 值得重试的特征：换一次时机大概率就好了
import { ENV_RULES } from './run-classify.mjs';

const TRANSIENT = [
  /等待 Chrome 调试端口超时/,
  /启动 Chrome 失败/,
  /ECONNREFUSED|EAGAIN|ETIMEDOUT/,
  /CDP .*超时/,
  /连接被拒绝/,
];

// 明确不该重试：属于环境或用户行为，重试只会打扰用户。
// 复用 run-classify 的环境规则，别再各写一份——评审就抓到过一次两边规则分叉
// （分类器已删掉「改成了指定关键词|已恢复原值」，这边还留着，后来对不上）。
const NO_RETRY = [
  ...ENV_RULES.map(([re]) => re),
  /环境跳过/,
];

function isTransient(text) {
  const raw = String(text || '');
  if (NO_RETRY.some((re) => re.test(raw))) return false;
  return TRANSIENT.some((re) => re.test(raw));
}

/**
 * @param {{ok:boolean, text:string, attempt:number, maxAttempts:number, code?:number|null}} input
 *   attempt 是「已经跑过几次」，从 0 开始。
 * @returns {{retry:boolean, reason:string, delayMs:number}}
 */
export function decideRetry({ ok, text, attempt = 0, maxAttempts = 1, code = null } = {}) {
  if (ok) return { retry: false, reason: '成功', delayMs: 0 };
  if (code === null || code === undefined) {
    // 被超时杀掉（code=null）往往是外部卡住，值得再给一次机会
    if (attempt < maxAttempts) return { retry: true, reason: '被超时终止', delayMs: backoff(attempt) };
    return { retry: false, reason: '多次超时', delayMs: 0 };
  }
  if (attempt >= maxAttempts) return { retry: false, reason: '已用完重试次数', delayMs: 0 };
  if (!isTransient(text)) return { retry: false, reason: '不是临时性失败', delayMs: 0 };
  return { retry: true, reason: '临时性失败（' + firstHit(text) + '）', delayMs: backoff(attempt) };
}

function firstHit(text) {
  const raw = String(text || '');
  for (const re of TRANSIENT) {
    const m = raw.match(re);
    if (m) return m[0].slice(0, 24);
  }
  return '外部暂时不可用';
}

// 3s、6s、12s…… 最长 30s，避免锁屏期间连续重试把 CPU 打满
function backoff(attempt) {
  return Math.min(30000, 3000 * Math.pow(2, Math.max(0, attempt)));
}

export { isTransient, TRANSIENT, NO_RETRY };
