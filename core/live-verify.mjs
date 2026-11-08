/**
 * 一条命令跑完「需要解锁屏幕」的全部验收（acceptance / bg:verify / 小窗回归 / 会话隔离 / 帧率）。
 *
 * 为什么单独一层：这些验证都要求解锁且用户离开，平时没条件跑，解锁窗口又很短；
 * 一个统一入口按顺序跑完、统一分类（通过 / 环境跳过 / 真实失败）并出报告，
 * 避免漏跑或把环境跳过误当通过。
 *
 * 这里只放纯逻辑（分类、汇总），进程编排在 scripts/live-verify.mjs。
 */
import { envSkipReason } from './run-classify.mjs';

/**
 * 单个步骤的分类（纯函数）。
 * @param {{code?:number|null, out?:string, timedOut?:boolean, limitMs?:number}} result
 * @returns {{status:'PASS'|'SKIP'|'FAIL', detail:string}}
 */
export function classifyLiveStep(result = {}) {
  const out = String((result && result.out) || '');
  if (result && result.timedOut) {
    return { status: 'FAIL', detail: '超时（超过 ' + Math.round((Number(result.limitMs) || 0) / 1000) + 's 未结束，已终止）' };
  }
  // 真失败优先：验收里会同时出现「部分环境跳过」和「通过」的行，
  // 只要存在失败证据就不能被环境跳过文案豁免（同 run-classify 的原则）。
  const hardFail = out.split('\n').find((line) => /❌|\bFAIL\b|存在失败项|未送达/.test(line));
  if (hardFail) return { status: 'FAIL', detail: hardFail.replace(/^[\s✅❌]*/, '').trim().slice(0, 80) };
  // 有没有「真的跑通过了」的证据：验收输出里有 PASS/✅/通过 N 项，就不是整步环境跳过
  const passEvidence = /(^|\s)(PASS|✅)\b|全部通过|通过\s*\d+/.test(out);
  const skipReason = envSkipReason(out);
  if (skipReason && !passEvidence) return { status: 'SKIP', detail: '环境跳过：' + skipReason };
  if (result && result.code === 0) {
    if (skipReason) return { status: 'PASS', detail: '（部分子项环境跳过：' + skipReason + '）' };
    return { status: 'PASS', detail: '' };
  }
  return { status: 'FAIL', detail: '退出码 ' + (result && result.code) };
}

/**
 * 汇总（纯函数）：skipped 不算失败。
 * @param {Array<{name:string, status:string, ms?:number, detail?:string}>} steps
 */
export function summarizeLiveSteps(steps) {
  const list = Array.isArray(steps) ? steps : [];
  const passed = list.filter((s) => s && s.status === 'PASS').length;
  const skipped = list.filter((s) => s && s.status === 'SKIP').length;
  const failed = list.filter((s) => s && s.status === 'FAIL').length;
  return {
    total: list.length,
    passed,
    skipped,
    failed,
    ok: failed === 0,
    text: '共 ' + list.length + ' 项：通过 ' + passed + '，环境跳过 ' + skipped + '，失败 ' + failed,
  };
}

/** 中途要不要停（锁屏 / 用户回来）：和验收同一套判断，避免后半程全是假失败 */
export function midRunStopReason({ locked, userActive, userActiveSec = 180 } = {}) {
  if (locked) return '屏幕已锁，后续步骤无法验证';
  if (userActive) return '用户回到电脑前（键鼠空闲 < ' + userActiveSec + ' 秒）';
  return '';
}
