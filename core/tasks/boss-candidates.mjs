/**
 * 只筛选 BOSS 列表页岗位并打分，产出候选清单，不投递
 */
'use strict';
// 只做筛选、不投递：读当前 BOSS 列表页，按可配置标准打分，产出候选清单供人工圈定。
import { execFile } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { overlay } from '../agentd.mjs';
import { scoreJob } from '../lib/score.mjs';
import { isScreenLocked, lockedSkipNotice } from '../platform.mjs';
import { frontName, settleFront, frontRiskGate } from '../background.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');
import { resolveOcu } from '../platform.mjs';
const OCU = resolveOcu() || path.join(os.homedir(), '.local/bin/ocu');

const CFG = {
  salaryMin: Number(process.env.SALARY_MIN || 5),
  salaryMax: Number(process.env.SALARY_MAX || 12),
  allowIntern: process.env.ALLOW_INTERN !== '0',
  allowCampus: process.env.ALLOW_CAMPUS !== '0',
  keywords: (process.env.KEYWORDS || 'Java,Agent,AI,后端,全栈,大模型,工作流').split(','),
  excludeCompanies: (process.env.EXCLUDE_COMPANIES || '外包,人力,派遣,猎头').split(','),
};

// 打分与薪资解析统一走 core/lib，便于单测
function score(job) {
  return scoreJob({ title: job.title, ctx: job.ctx }, CFG);
}

const inner = [
  'var app = await cua.getApp("Google Chrome", { initialState: false });',
  'var s = await app.getAXState({ includeScreenshot: false, maxTreeNodes: 12000 });',
  'var t = typeof s === "string" ? s : JSON.stringify(s);',
  'var lines = t.split("\\n");',
  'var jobs = [];',
  'for (var i = 0; i < lines.length; i++) {',
  '  var m = /(\\d+)\\s+link \\[([^\\]]+)\\]\\(https:\\/\\/www\\.zhipin\\.com\\/job_detail\\/([^?)]+)/.exec(lines[i]);',
  '  if (!m) continue;',
  '  var title = m[2].trim();',
  '  var ctx = [];',
  '  for (var k = i + 1; k < Math.min(i + 9, lines.length); k++) {',
  '    if (lines[k].indexOf("link [") >= 0) break;',
  '    var txt = lines[k].replace(/^\\s*/,"");',
  '    txt = txt.replace(/^\\d+\\s+/,"");',
  '    if (/^(container|组|文本|静态文本|图像|link|按钮|标签)/.test(txt)) {',
  '      txt = txt.replace(/^[^ ]*\\s+/,"");',
  '    }',
  '    if (txt && !/^\\(/.test(txt)) ctx.push(txt);',
  '  }',
  '  jobs.push({ index: Number(m[1]), title: title, id: m[3], ctx: ctx.join(" | ").slice(0, 160) });',
  '}',
  'var seen = {}; jobs = jobs.filter(function (j) { return j.id && !seen[j.id] && (seen[j.id] = 1); });',
  'nodeRepl.write(JSON.stringify({ url: (/URL: (https:\\/\\/[^\\s,)]+)/.exec(t) || [])[1] || "", jobs: jobs }));',
].join('\n');
async function main() {
  // 锁屏下 AX 整体不可用：这是环境限制，不是任务失败
  if (await isScreenLocked()) {
    console.log(lockedSkipNotice('boss-candidates.mjs'));
    return;
  }
  // 读的是 Chrome 的页面树：Chrome 本身在 AX 读取后可能激活自己，统一走「前台风险名单 + 还原」
  const target = 'Google Chrome';
  const risk = frontRiskGate();
  if (risk.shouldSkip(target)) {
    console.log('环境跳过：' + target + ' 读取会抢前台（前台风险名单），先不读它的界面树；确认修好后 npm run front:risk -- --clear "' + target + '"');
    return;
  }
  const frontBefore = await frontName();
  await overlay.status('BOSS：只筛选，不投递');
  const tmp = path.join(os.tmpdir(), 'boss-candidates-' + Date.now() + '.mjs');
  await fsp.writeFile(tmp, inner, 'utf8');
  const raw = await new Promise((resolve) => {
    execFile(OCU, ['js', '--timeout', '90000', '--file', tmp], { timeout: 120000, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, OPEN_COMPUTER_USE_VISUAL_CURSOR: '0' } }, (_e, stdout) => resolve(stdout || ''));
  });
  await fsp.rm(tmp, { force: true });
  let data = null;
  for (const line of raw.trim().split('\n').reverse()) {
    if (!line.trim().startsWith('{')) continue;
    try { data = JSON.parse(line); break; } catch {}
  }
  // 读页面期间 Chrome 可能自己抢前台：立刻还给用户，并把这次行为记进风险名单
  const settled = await settleFront(frontBefore, { waitMs: 200, retries: 2 });
  if (settled.stolen) {
    risk.note(target);
    console.error('提示：读取期间前台被 ' + target + ' 抢走，已' + (settled.restored ? '还原到 ' + frontBefore : '尝试还原（未成功）') + '，并记入前台风险名单');
  }
  if (!data || !data.jobs) { console.error('FAIL: 读不到岗位列表'); process.exit(1); }

  const scored = data.jobs.map((j) => Object.assign({}, j, score(j))).sort((a, b) => b.score - a.score);
  const pass = scored.filter((j) => j.score >= 40);
  const maybe = scored.filter((j) => j.score >= 20 && j.score < 40);

  const lines = [];
  lines.push('# BOSS 候选岗位（仅筛选，未投递）');
  lines.push('');
  lines.push('页面：' + (data.url || 'unknown'));
  lines.push('标准：薪资 ' + CFG.salaryMin + '-' + CFG.salaryMax + 'K，关键词 ' + CFG.keywords.join('/') + '，排除 ' + CFG.excludeCompanies.join('/'));
  lines.push('');
  lines.push('## 推荐投递（' + pass.length + '）');
  lines.push('');
  for (const j of pass) lines.push('- [' + j.score + '] ' + j.title + '  \n  ' + j.reasons.join('；'));
  lines.push('');
  lines.push('## 可考虑（' + maybe.length + '）');
  lines.push('');
  for (const j of maybe) lines.push('- [' + j.score + '] ' + j.title + '  \n  ' + j.reasons.join('；'));
  lines.push('');
  lines.push('## 未通过（' + (scored.length - pass.length - maybe.length) + '）');
  lines.push('');
  for (const j of scored.filter((j) => j.score < 20)) lines.push('- [' + j.score + '] ' + j.title + '  \n  ' + j.reasons.join('；'));

  const reports = path.join(ROOT, 'reports');
  await fsp.mkdir(reports, { recursive: true });
  const out = path.join(reports, 'candidates-' + new Date().toISOString().replace(/[:.]/g, '-') + '.md');
  await fsp.writeFile(out, lines.join('\n'));
  await overlay.status('筛选完成：推荐 ' + pass.length + ' 个');
  console.log(lines.join('\n'));
  console.log('\n报告：' + out);
}

main().catch(async (e) => { console.error('FAIL:', e.message); process.exit(1); });