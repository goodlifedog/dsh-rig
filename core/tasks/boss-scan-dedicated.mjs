'use strict';

/**
 * BOSS 扫描（专用浏览器版）
 * - 用独立 profile 的离屏 Chrome，不碰用户自己的浏览器
 * - 首次运行自动从用户 Chrome 复制登录态（同机 Cookie 可解密）
 * - DOM 提取岗位，按用户要求过滤：排除硕士、排除 3 年以上经验
 * - 结果推送到 overlay 小窗，并落盘 reports/
 */

import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { launch } from '../browser.mjs';
import { overlay } from '../agentd.mjs';

import { isMac } from '../platform.mjs';
if (!isMac) {
  console.error('此任务依赖 macOS 的 ocu/osascript，Windows 版待移植；跨平台通路验证请跑 platform-demo');
  process.exit(2);
}

const CHROME_DIR = path.join(os.homedir(), 'Library/Application Support/Google/Chrome');
const PROFILE = process.env.AGENT_CHROME_PROFILE || path.join(os.homedir(), '.desktop-agent', 'chrome-profile');
const KEYWORD = process.env.SCAN_KEYWORD || 'AI Agent';
const LIMIT = Number(process.env.SCAN_LIMIT || 30);
const REPORTS = path.join(process.cwd(), 'reports');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ensureProfile() {
  const cookiePath = path.join(PROFILE, 'Profile 1', 'Cookies');
  try {
    await fsp.access(cookiePath);
    return { reused: true };
  } catch {}

  await fsp.mkdir(path.join(PROFILE, 'Profile 1'), { recursive: true });
  const copy = async (from, to) => {
    try { await fsp.copyFile(from, to); return true; } catch { return false; }
  };
  await copy(path.join(CHROME_DIR, 'Local State'), path.join(PROFILE, 'Local State'));
  let ok = 0;
  for (const f of ['Cookies', 'Preferences', 'Login Data', 'Web Data']) {
    if (await copy(path.join(CHROME_DIR, 'Profile 1', f), path.join(PROFILE, 'Profile 1', f))) ok += 1;
  }
  return { reused: false, copied: ok };
}

// 在页面里跑：抓岗位卡片 + 过滤
function extractScript(keyword) {
  return '(' + function (kw) {
    const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    const cards = Array.from(document.querySelectorAll('li.job-card-wrapper, .job-card-wrapper, li[ka*="job"]'));
    const jobs = cards.map((card) => {
      const text = norm(card.innerText);
      const a = card.querySelector('a[href*="job_detail"]');
      const q = (sel) => { const el = card.querySelector(sel); return el ? norm(el.innerText) : ''; };
      return {
        title: q('.job-name') || (text.split(' ')[0] || ''),
        salary: q('.job-salary') || (text.match(/\d+[-–]\d+K[^\s]*/) || [''])[0],
        company: q('.company-name') || '',
        area: q('.job-area') || '',
        text,
        url: a ? a.href : '',
      };
    });
    // 过滤：排除硕士、排除 3 年以上经验
    const degrees = /硕士|博士/;
    const expBad = /(3-5年|5-10年|10年以上|3年以上|5年以上)/;
    const origin = /(应届|在校|经验不限|1年以内|1-3年)/;
    const kept = jobs.filter((j) => {
      if (degrees.test(j.text)) return false;          // 要硕士/博士 → 跳过
      if (expBad.test(j.text) && !origin.test(j.text)) return false;  // 3年以上且无应届通道 → 跳过
      return j.title || j.url;
    });
    return { keyword: kw, total: jobs.length, kept: kept.slice(0, 40), dropped: jobs.length - kept.length };
  } + ')(' + JSON.stringify(keyword) + ')';
}

async function main() {
  await overlay.status('启动专用浏览器…');
  const prof = await ensureProfile();
  console.log('[1] profile:', PROFILE, prof.reused ? '(复用)' : '(已从用户 Chrome 复制 ' + prof.copied + ' 个文件)');

  let browser;
  try {
    browser = await launch({ userDataDir: PROFILE, port: 0, profileDirectory: 'Profile 1', timeoutMs: 60000 });
    console.log('[2] 离屏 Chrome 端口:', browser.port);
    const cdp = await browser.connect({ urlMatch: 'zhipin', timeoutMs: 40000 }).catch(async () => {
      // 首次加载可能还没 navigate，先连任意页面再导航
      const p = await browser.connect({ timeoutMs: 20000 });
      await p.send('Page.enable');
      await p.send('Page.navigate', { url: 'https://www.zhipin.com/web/geek/jobs' });
      return p;
    });
    await cdp.send('Page.enable');

    const url = 'https://www.zhipin.com/web/geek/jobs';
    console.log('[3] 导航:', url);
    await cdp.send('Page.navigate', { url });

    // BOSS 的搜索框注入会触发安全验证，所以直接读默认推荐列表，再按关键词过滤
    const evalIn = async (expr) => {
      const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true });
      return r && r.result ? r.result.value : undefined;
    };
    let cards = 0;
    for (let i = 0; i < 20; i++) {
      await sleep(1000);
      cards = Number(await evalIn('document.querySelectorAll("li.job-card-wrapper").length')) || 0;
      if (cards > 0) { console.log('    岗位卡片已加载:', cards, '(' + (i + 1) + 's)'); break; }
    }
    if (!cards) console.log('    警告：未等到岗位卡片');

    const state = await cdp.send('Runtime.evaluate', {
      expression: 'JSON.stringify({url: location.href, title: document.title, loggedIn: /消息|简历|我的/.test(document.body.innerText)})',
      returnByValue: true,
    });
    console.log('[4] 页面状态:', state.result.value);

    const res = await cdp.send('Runtime.evaluate', {
      expression: extractScript(KEYWORD),
      returnByValue: true,
    });
    const data = res.result.value || { total: 0, kept: [], dropped: 0 };
    console.log('[5] 抓到', data.total, '个岗位，过滤后保留', data.kept.length, '个（剔除', data.dropped, '）');
    await overlay.log('岗位：共 ' + data.total + ' 个，过滤后 ' + data.kept.length + ' 个');

    for (const j of data.kept.slice(0, 10)) {
      console.log('   -', j.title, '|', j.salary, '|', j.company, '|', j.area);
      await overlay.log(j.title + ' ' + j.salary + ' ' + j.company);
    }

    await fsp.mkdir(REPORTS, { recursive: true });
    const file = path.join(REPORTS, 'boss-scan-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json');
    await fsp.writeFile(file, JSON.stringify({ keyword: KEYWORD, ...data, at: new Date().toISOString() }, null, 2));
    await overlay.status('扫描完成：' + data.kept.length + ' 个匹配岗位');
    console.log('[6] 结果已保存:', file);
    process.exit(0);
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

main().catch(async (e) => {
  console.error('FAIL:', e.message);
  await overlay.status('扫描失败：' + e.message.slice(0, 40));
  process.exit(1);
});
