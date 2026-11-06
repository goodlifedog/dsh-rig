'use strict';

/** 岗位适配度打分。纯函数，便于测试与调整标准。 */
import { parseSalary } from './salary.mjs';

export const DEFAULT_CRITERIA = {
  salaryMin: 5,
  salaryMax: 12,
  keywords: ['Java', 'Agent', 'AI', '后端', '全栈', '大模型', '工作流'],
  excludeCompanies: ['外包', '人力', '派遣', '猎头'],
};

export function scoreJob(job, criteria = DEFAULT_CRITERIA) {
  const c = Object.assign({}, DEFAULT_CRITERIA, criteria);
  const hay = (job.title || '') + ' ' + (job.ctx || '');
  const reasons = [];
  let score = 0;

  const kw = c.keywords.find((k) => hay.includes(k));
  if (kw) { score += 30; reasons.push('方向匹配：' + kw); }

  const sal = parseSalary(hay);
  if (sal) {
    if (sal.min <= c.salaryMax && sal.max >= c.salaryMin) {
      score += 25;
      reasons.push('薪资 ' + sal.min + '-' + sal.max + 'K 在区间内');
    } else if (sal.min > c.salaryMax) {
      score -= 20;
      reasons.push('薪资偏高（' + sal.min + 'K 起），可能够不着');
    } else {
      score -= 5;
      reasons.push('薪资偏低（' + sal.max + 'K 封顶）');
    }
  } else {
    reasons.push('薪资未标注');
  }

  if (/在校|应届|经验不限|实习|1年以内/.test(hay)) { score += 20; reasons.push('接受应届/在校'); }
  if (/1-3年/.test(hay)) { score += 8; reasons.push('1-3 年，可尝试'); }
  if (/3-5年|5-10年/.test(hay)) { score -= 30; reasons.push('经验要求偏高'); }
  if (/硕士/.test(hay)) { score -= 40; reasons.push('要求硕士'); }

  const bad = c.excludeCompanies.find((x) => hay.includes(x));
  if (bad) { score -= 15; reasons.push('公司类型可疑：' + bad); }

  return { score, reasons };
}

export default { scoreJob, DEFAULT_CRITERIA };
