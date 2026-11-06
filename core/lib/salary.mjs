'use strict';

/** 从岗位描述里解析薪资区间，返回 {min, max} 或 null。支持 8-10K / 8-10K·14薪 / 180-200元/天。 */
export function parseSalary(text) {
  if (!text) return null;
  const day = /(\d+)\s*[-–]\s*(\d+)\s*元\s*\/\s*天/.exec(text);
  if (day) {
    const min = Math.round((Number(day[1]) * 21) / 1000);
    const max = Math.round((Number(day[2]) * 21) / 1000);
    return { min, max, unit: 'K/月（按 21 天折算）' };
  }
  const m = /(\d+(?:\.\d+)?)\s*[-–]\s*(\d+(?:\.\d+)?)\s*K/i.exec(text) || /(\d+(?:\.\d+)?)\s*K/i.exec(text);
  if (!m) return null;
  const a = Number(m[1]);
  const b = m[2] ? Number(m[2]) : a;
  return { min: Math.min(a, b), max: Math.max(a, b), unit: 'K/月' };
}

export default { parseSalary };
