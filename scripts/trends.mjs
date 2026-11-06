#!/usr/bin/env node
// 趋势：把最近若干次巡检报告拉成一张表，看帧率/耗时/内存有没有漂移。
//   npm run trends
//   TREND_LIMIT=20 npm run trends
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const DIR = path.join(ROOT, 'reports');
const LIMIT = Math.max(1, Number(process.env.TREND_LIMIT) || 10);

function parseReport(file) {
  const text = fs.readFileSync(path.join(DIR, file), 'utf8');
  const pick = (re) => (text.match(re) || [])[1];
  const fps = Number(pick(/([\d.]+) fps/));
  const bytes = Number(pick(/单帧体积\s+(\d+)B/));
  const taskOk = pick(/任务结果\s+(\d+)\/(\d+) 成功/);
  const memDelta = pick(/变化\s+([+-]?\d+)MB/);
  const hideMs = Number(pick(/切走后消失.*?用时=(\d+)ms/));
  const showMs = Number(pick(/切回后重新出现.*?用时=(\d+)ms/));
  // 锁屏/宿主不在前台时小窗按设计隐藏，没有"用时"；标出来比留空更好懂
  const showSuppressed = /切回后重新出现.*按设计隐藏/.test(text);
  const result = /全部正常/.test(text) ? '全部正常' : (pick(/(\d+) 项未通过/) ? pick(/(\d+) 项未通过/) + ' 项未通过' : '有异常');
  const at = pick(/时间：(\S+)/) || file;
  return {
    file,
    at,
    result,
    fps: Number.isFinite(fps) ? fps : null,
    bytes: Number.isFinite(bytes) ? bytes : null,
    taskOk: taskOk ? taskOk + '/' + (text.match(/任务结果\s+\d+\/(\d+) 成功/) || [])[1] : null,
    memDelta: memDelta === undefined ? null : Number(memDelta),
    hideMs: Number.isFinite(hideMs) ? hideMs : null,
    showMs: Number.isFinite(showMs) ? showMs : null,
    showSuppressed,
  };
}

function fmtDelta(cur, prev, unit) {
  if (cur == null || prev == null) return '';
  const d = cur - prev;
  if (Math.abs(d) < 0.05) return ' =';
  return (d > 0 ? ' +' : ' ') + (Math.round(d * 10) / 10) + unit;
}

function main() {
  if (!fs.existsSync(DIR)) {
    console.log('还没有 reports/ 目录，先跑一次 npm run monitor');
    return;
  }
  const files = fs.readdirSync(DIR)
    .filter((f) => /^monitor-.*\.md$/.test(f))
    .sort()
    .slice(-LIMIT);
  if (!files.length) {
    console.log('还没有巡检报告，先跑一次 npm run monitor');
    return;
  }

  const rows = files.map(parseReport);
  const header = ['时间', '结果', '帧率', '单帧', '任务', '内存变化', '切走/切回'];
  const table = rows.map((r, i) => {
    const prev = rows[i - 1];
    return [
      r.at.slice(11, 19) || r.at.slice(5, 16).replace('T', ' '),
      r.result,
      r.fps == null ? '-' : r.fps + 'fps' + fmtDelta(r.fps, prev && prev.fps, ''),
      r.bytes == null ? '-' : Math.round(r.bytes / 1024) + 'KB',
      r.taskOk || '-',
      r.memDelta == null ? '-' : (r.memDelta >= 0 ? '+' : '') + r.memDelta + 'MB',
      (r.hideMs == null ? '-' : r.hideMs + 'ms') + ' / ' + (r.showMs != null ? r.showMs + 'ms' : (r.showSuppressed ? '按设计隐藏' : '-')),
    ];
  });

  const widths = header.map((h, i) => Math.max(h.length, ...table.map((t) => String(t[i]).length)));
  const line = (cells) => '  ' + cells.map((c, i) => String(c).padEnd(widths[i])).join('  ');
  console.log('\n巡检趋势（最近 ' + rows.length + ' 次）\n');
  console.log(line(header));
  console.log('  ' + widths.map((w) => '-'.repeat(w)).join('  '));
  for (const t of table) console.log(line(t));

  // 结论：最近一次 vs 更早的均值
  if (rows.length >= 2) {
    const last = rows[rows.length - 1];
    const older = rows.slice(0, -1);
    const avg = (key) => {
      const vals = older.map((r) => r[key]).filter((v) => typeof v === 'number' && Number.isFinite(v));
      return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
    };
    const fpsAvg = avg('fps');
    const memMax = Math.max(...older.map((r) => Math.abs(r.memDelta || 0)), 0);
    console.log('');
    if (fpsAvg && last.fps != null) {
      const diff = last.fps - fpsAvg;
      console.log('  帧率：最近 ' + last.fps + 'fps，历史均值 ' + (Math.round(fpsAvg * 10) / 10) + 'fps（' + (diff >= 0 ? '+' : '') + (Math.round(diff * 10) / 10) + '）');
    }
    console.log('  内存：历史单次变化最大 ' + memMax + 'MB' + (last.memDelta == null ? '' : '，最近 ' + (last.memDelta >= 0 ? '+' : '') + last.memDelta + 'MB'));
  }
  console.log('');
}

main();
