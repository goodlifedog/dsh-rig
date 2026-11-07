#!/usr/bin/env node
// 状态看板：一眼看清代理在干什么
// 用法：node core/status.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { overlay } from './agentd.mjs';
import { latestReport } from './report-index.mjs';
import { localHeaders } from './local-token.mjs';
import { daemonUrl } from './ports.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const RUNS = path.join(ROOT, 'logs', 'runs');

function listLocks() {
  const dir = os.tmpdir();
  try {
    return fs.readdirSync(dir)
      .filter((f) => f.startsWith('agentd-') && f.endsWith('.lock'))
      .map((f) => {
        const st = fs.statSync(path.join(dir, f));
        return { app: f.replace(/^agentd-/, '').replace(/\.lock$/, ''), since: st.mtimeMs };
      });
  } catch { return []; }
}

function recentRuns(n = 5) {
  if (!fs.existsSync(RUNS)) return [];
  const files = fs.readdirSync(RUNS).filter((f) => f.endsWith('.jsonl')).sort().reverse().slice(0, n);
  return files.map((f) => {
    const full = path.join(RUNS, f);
    const lines = fs.readFileSync(full, 'utf8').trim().split('\n').filter(Boolean);
    let start = null; let end = null; let lastLine = '';
    for (const line of lines) {
      try {
        const d = JSON.parse(line);
        if (d.event === 'start') start = d;
        if (d.event === 'end') end = d;
        if (d.event === 'line' && !/^[\s{}\[\],"]/.test(d.text)) lastLine = d.text;
      } catch {}
    }
    const name = f.replace(/^[^Z]+Z-/, '').replace(/\.jsonl$/, '');
    return { file: f, name, start, end, lastLine };
  });
}

async function main() {
  const h = await overlay.health();
  console.log('=== 桌面代理状态 ===');
  console.log('小窗     : ' + (h.ok
    ? '在线 pid=' + h.pid + (h.label ? ' | 会话「' + h.label + '」' : '') + ' | 状态「' + h.status + '」| ' + (h.visible ? '可见' : '已隐藏')
    : '离线'));
  if (h.ok) {
    // 把内部状态翻译成人话，别让用户看 no-window / error 这种枚举
    const state = (h.thumbnail && h.thumbnail.state) || 'waiting';
    const text = {
      live: '画面正常' + (h.fps ? ' ' + h.fps + 'fps' : '') + (h.frameWidth ? ' ' + h.frameWidth + 'px' : ''),
      waiting: '正在连接被控窗口',
      'no-window': '未绑定被控窗口（空闲时正常）',
      error: '抓帧失败：' + ((h.thumbnail && h.thumbnail.error) || '未知原因'),
    }[state] || ('状态 ' + state);
    console.log('画面     : ' + text + (h.windowId ? '（窗口 ' + h.windowId + '）' : '') + ' | 日志 ' + h.logs + ' 条');
  }

  // 耗时趋势（daemon 侧聚合）：哪个任务慢、成功率多少
  try {
    const stats = await (await fetch(daemonUrl('/stats'), {
      headers: localHeaders(),
      signal: AbortSignal.timeout(2000),
    })).json();
    if (stats && stats.runs) {
      const secs = (ms) => (ms >= 1000 ? (ms / 1000).toFixed(1) + 's' : Math.round(ms) + 'ms');
      const slowest = (stats.tasks || []).slice().sort((a, b) => b.avgMs - a.avgMs)[0];
      console.log('耗时     : 近 ' + stats.runs + ' 次成功率 ' + stats.okRate + '%，平均 ' + secs(stats.avgMs) +
        (slowest ? '，最慢 ' + slowest.name + ' ' + secs(slowest.avgMs) : ''));
    }
  } catch {}

  const locks = listLocks();
  console.log('运行中   : ' + (locks.length ? locks.map((l) => l.app + '(' + Math.round((Date.now() - l.since) / 1000) + 's)').join(', ') : '无任务'));

  console.log('');
  console.log('=== 最近任务 ===');
  const runs = recentRuns(6);
  if (!runs.length) { console.log('（还没有运行记录）'); return; }
  for (const r of runs) {
    const ok = r.end && r.end.code === 0;
    const dur = r.end ? (r.end.durationMs / 1000).toFixed(1) + 's' : '未结束';
    const ts = r.start ? new Date(r.start.ts).toLocaleTimeString('zh-CN') : '?';
    const mark = r.end ? (ok ? '✅' : '❌') : '⏳';
    console.log(mark + ' ' + ts.padEnd(10) + r.name.padEnd(16) + dur.padEnd(8) + (r.lastLine || '').slice(0, 46));
  }

  const reports = path.join(ROOT, 'reports');
  if (fs.existsSync(reports)) {
    // 只认 acceptance-*.md，并按文件名里的时间戳取最新（字典序会把别的报告排进来）
    const last = latestReport(fs.readdirSync(reports));
    if (last) console.log('\n最近验收 : reports/' + last);
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
