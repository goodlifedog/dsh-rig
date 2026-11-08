'use strict';
// BOSS 投递：发一条 -> 立刻读消息列表核对 -> 确认送达才发下一条。
//
// 判定标准（唯一）：消息列表前后差集。绝不认「已向BOSS发送消息」弹窗 ——
// 平台即使弹出这个提示，也可能根本没建会话（旧版就是被这个弹窗骗成「已发送」的）。
//
// 状态文件 reports/greet-state.json：
//   delivered  已确认送达（永久跳过）
//   skipped    详情页按钮已是「继续沟通」= 已经联系过（永久跳过，绝不重复打扰）
//   failed     尝试过但没送达（连续 2 次就不再碰这个岗位）
import { execFile } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { overlay } from '../agentd.mjs';
import { readChatItems, diffChat } from './greet-verify.mjs';
import { hidIdleMs } from '../front-watch.mjs';
import { shouldDeferForActiveUser } from '../user-activity.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');
import { resolveOcu, isScreenLocked, lockedSkipNotice } from '../platform.mjs';
const OCU = resolveOcu() || path.join(os.homedir(), '.local/bin/ocu');
const APP = process.env.TARGET_APP || 'Google Chrome';
const TARGET = Math.max(1, Number(process.env.GREET_LIMIT || 2));
const MAX_FAILED = 2;            // 同一岗位失败几次后放弃
const innerPath = path.join(__dirname, 'greet-inner.mjs');
const STATE_FILE = path.join(ROOT, 'reports', 'greet-state.json');
const REPORT_DIR = path.join(ROOT, 'reports');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (a, b) => a + Math.random() * (b - a);

// ---------- 状态 ----------
// 岗位 id 统一成不带 .html 的形式（旧版状态文件里带后缀，会导致跳过列表对不上）
const normId = (id) => String(id).replace(/\.html$/, '');

async function readState() {
  let raw = null;
  try { raw = JSON.parse(await fsp.readFile(STATE_FILE, 'utf8')); } catch { /* 首次运行 */ }
  const st = { version: 2, delivered: {}, skipped: {}, failed: {} };
  for (const bucket of ['delivered', 'skipped', 'failed']) {
    for (const [k, v] of Object.entries((raw && raw[bucket]) || {})) st[bucket][normId(k)] = v;
  }
  // 迁移旧格式 { done: [...] }：旧版把「报过已发送」的都记成 done，
  // 但其中一部分其实没送达。为了「绝不重复打扰」，一律当已联系过跳过。
  if (raw && Array.isArray(raw.done)) {
    for (const id0 of raw.done) {
      const id = normId(id0);
      if (!st.delivered[id] && !st.skipped[id]) {
        st.skipped[id] = { reason: '旧版 done 迁移', at: new Date().toISOString() };
      }
    }
  }
  return st;
}

async function writeState(st) {
  await fsp.mkdir(path.dirname(STATE_FILE), { recursive: true });
  await fsp.writeFile(STATE_FILE, JSON.stringify(st, null, 2));
}

function skipIds(st) {
  const ids = new Set([...Object.keys(st.delivered), ...Object.keys(st.skipped)]);
  for (const [id, f] of Object.entries(st.failed)) {
    if ((f.count || 0) >= MAX_FAILED) ids.add(id);
  }
  return [...ids];
}

// ---------- 内层调用 ----------
function runOne(skipIdsList) {
  const timeout = 180000;
  return new Promise((resolve) => {
    execFile(
      OCU,
      ['js', '--timeout', String(timeout), '--file', innerPath],
      {
        timeout: timeout + 30000,
        maxBuffer: 64 * 1024 * 1024,
        env: {
          ...process.env,
          TARGET_APP: APP,
          GREET_LIMIT: '1',
          GREET_CARDS: '1',
          GREET_SKIP: (skipIdsList || []).join(','),
          OPEN_COMPUTER_USE_VISUAL_CURSOR: '0',
        },
      },
      (err, stdout, stderr) => resolve({ code: err ? 1 : 0, stdout: stdout || '', stderr: stderr || '' }),
    );
  });
}

function parseResult(stdout) {
  const lines = stdout.trim().split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].trim().startsWith('{')) continue;
    try { return JSON.parse(lines.slice(i).join('\n')); } catch { /* 继续往上找 */ }
  }
  return null;
}

// ---------- 主流程 ----------
async function main() {
  // 锁屏下 AX/抓图不可用：这是环境限制，不是任务失败（手动跑也不该红）
  if (await isScreenLocked()) {
    console.log(lockedSkipNotice('boss-greet.mjs'));
    return;
  }
  // 这个任务会真的发消息：你正在用电脑时不做，避免发出的瞬间切走你的输入焦点
  const activity = shouldDeferForActiveUser(await hidIdleMs());
  if (activity.defer) {
    console.log('环境跳过：' + activity.reason);
    return;
  }
  await overlay.status('BOSS 投递：开始（逐条核对）');

  // 先建立基线。读不到消息列表就绝不下发 —— 没有验收手段的投递一律不做。
  let before;
  try {
    before = await readChatItems(12);
  } catch (e) {
    console.error('FAIL: 无法读取消息列表，拒绝投递（无法核对送达）: ' + e.message);
    await overlay.status('BOSS 投递中止：消息列表读不到');
    process.exit(2);
  }
  console.log('[0] 基线会话 ' + before.length + ' 条，本次目标送达 ' + TARGET + ' 条');

  const st = await readState();
  const attempts = [];
  let delivered = 0;
  let misses = 0;
  let rounds = 0;
  const maxRounds = TARGET * 5 + 5;

  while (delivered < TARGET && rounds < maxRounds) {
    // 每投一条之前都复查：投递可能持续几分钟，你中途回来就停，不再发下一条
    const activity = shouldDeferForActiveUser(await hidIdleMs());
    if (activity.defer) {
      console.log('[!] ' + activity.reason + '，停止后续投递');
      await overlay.status('BOSS 投递暂停：你回到电脑前').catch(() => {});
      break;
    }
    rounds += 1;
    const skip = skipIds(st);
    const r = await runOne(skip);
    const data = parseResult(r.stdout);

    if (!data || !data.ok) {
      const err = (data && data.error) || (r.stderr || '').trim().split('\n').slice(-2).join(' ') || '内层返回无法解析';
      console.log('[' + rounds + '] 内层失败：' + err);
      await overlay.log('内层失败：' + String(err).slice(0, 60));
      misses += 1;
      if (misses >= 2) { console.log('[!] 连续两次失败，停止'); break; }
      await sleep(jitter(2000, 3500));
      continue;
    }

    const list = data.results || [];
    if (!list.length) {
      console.log('[' + rounds + '] 没有可投的岗位了（候选都跳过/筛掉了）');
      break;
    }
    const job = list[list.length - 1];
    const rec = { round: rounds, ...job };
    attempts.push(rec);

    // 1) 已经联系过：详情页按钮是「继续沟通」——这不是失败，记下来跳过
    if (job.r === '已联系过') {
      st.skipped[job.id] = { title: job.title, reason: '详情按钮=继续沟通', at: new Date().toISOString() };
      await writeState(st);
      console.log('[' + rounds + '] - 跳过（已联系过）：' + job.title);
      await overlay.log('跳过已联系：' + job.title.slice(0, 20));
      misses = 0;
      await sleep(jitter(1200, 2400));
      continue;
    }

    // 2) 没点下去（详情没切换 / 没有按钮 / 点击未生效）：不算送达，重试下一个
    if (!job.sent) {
      misses += 1;
      const prev = st.failed[job.id] || { count: 0 };
      st.failed[job.id] = { title: job.title, count: prev.count + 1, reason: job.r, at: new Date().toISOString() };
      await writeState(st);
      console.log('[' + rounds + '] ✗ 未投出（' + job.r + '）：' + job.title);
      await overlay.log('未投出：' + job.title.slice(0, 20));
      if (misses >= 2) { console.log('[!] 连续两次没投出去，停止'); break; }
      await sleep(jitter(2000, 3500));
      continue;
    }

    // 3) 点下去了：唯一验收 —— 读消息列表做差集
    let after;
    try {
      after = await readChatItems(12);
    } catch (e) {
      console.log('[' + rounds + '] ! 送达核对失败（不计入送达，也不再继续发）：' + e.message);
      await overlay.log('核对失败，停止');
      break;
    }
    const { fresh, changed } = diffChat(before, after);
    const candidates = [...fresh, ...changed];
    // 新会话 / 有新消息的会话里，找能对上这个岗位招聘方的那条
    const hit = (job.boss && candidates.find((c) => c.who.includes(job.boss)))
      || (job.company && candidates.find((c) => c.who.includes(String(job.company).replace(/\.\.\.$/, ''))))
      || null;

    if (hit) {
      delivered += 1;
      misses = 0;
      st.delivered[job.id] = {
        title: job.title, boss: job.boss, company: job.company,
        evidence: hit.raw.slice(0, 60), at: new Date().toISOString(),
      };
      delete st.skipped[job.id];   // 旧版迁移留下的占位没有意义了
      delete st.failed[job.id];
      console.log('[' + rounds + '] ✓ 送达：' + job.title + ' → ' + hit.who.slice(0, 24));
      await overlay.log('✓ 送达：' + job.title.slice(0, 20));
    } else {
      misses += 1;
      const prev = st.failed[job.id] || { count: 0 };
      st.failed[job.id] = { title: job.title, count: prev.count + 1, reason: '消息列表无新增', at: new Date().toISOString() };
      console.log('[' + rounds + '] ✗ 弹了提示但消息列表没新增，判未送达：' + job.title
        + '（新增会话 ' + fresh.length + '，变化 ' + changed.length + '）');
      await overlay.log('✗ 未送达：' + job.title.slice(0, 20));
      if (misses >= 2) { console.log('[!] 连续两次未送达，停止（不盲目刷）'); break; }
    }
    await writeState(st);
    before = after;
    await sleep(jitter(2500, 4500));
  }

  await fsp.mkdir(REPORT_DIR, { recursive: true });
  const out = path.join(REPORT_DIR, 'greet-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json');
  await fsp.writeFile(out, JSON.stringify({
    target: TARGET, delivered, rounds, attempts, at: new Date().toISOString(),
  }, null, 2));
  await overlay.status('BOSS 投递完成：送达 ' + delivered + ' 条');
  console.log('[3] 真实送达 ' + delivered + ' 条 / 目标 ' + TARGET + ' 条；报告：' + out);
  process.exit(delivered >= TARGET ? 0 : 1);
}

main().catch(async (e) => {
  console.error('FAIL:', e && e.message ? e.message : e);
  await overlay.status('BOSS 投递失败');
  process.exit(1);
});
