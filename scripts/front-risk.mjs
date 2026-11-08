#!/usr/bin/env node
/**
 * 前台风险名单：看哪些应用「一读就把自己顶到前台」，以及清除记录。
 *
 *   npm run front:risk                          # 看名单（生效中 / 已过期）
 *   npm run front:risk -- --clear "Ghostty"     # 清掉某个应用，下轮重新测
 *   npm run front:risk -- --clear-all           # 全清，所有应用都重新测
 *   npm run front:risk -- --seed                # 从历史矩阵报告里补种（只加不改，避免下次又闪）
 *   npm run front:risk -- --json
 *
 * 名单存 ~/.desktop-agent/front-risk.json（600），默认 30 天自动过期。
 * 矩阵/通道协商会跳过名单里的应用（AGENT_FRONT_RISK=off 可临时强制全测）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadRisk,
  saveRisk,
  clearRisk,
  riskSummary,
  seedFromMatrixRows,
  riskFile,
  emptyRiskState,
} from '../core/front-risk.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const asJson = args.includes('--json');
const seed = args.includes('--seed');
const clearAll = args.includes('--clear-all');
const clearIdx = args.findIndex((a) => a === '--clear' || a === '--forget');
const clearName = clearIdx >= 0 ? (args[clearIdx + 1] || '').trim() : '';

function fmt(ts) {
  if (!ts) return '-';
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

/** 从全部历史矩阵报告里收集"抢过前台"的行 */
function historicalRows() {
  const dir = path.join(ROOT, 'reports');
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => /^app-matrix-.*\.json$/.test(f)).sort();
  } catch {
    return { files: [], rows: [] };
  }
  const rows = [];
  for (const file of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
      for (const row of data.rows || []) rows.push(row);
    } catch {}
  }
  return { files, rows };
}

let state = loadRisk();
if (clearAll) {
  state = emptyRiskState();
  saveRisk(state);
  console.log('已清空前台风险名单，下轮矩阵/协商会重新测所有应用。');
} else if (clearName) {
  state = clearRisk(state, clearName);
  saveRisk(state);
  console.log('已从名单移除：' + clearName + '（下轮会重新测它）');
} else if (seed) {
  const { files, rows } = historicalRows();
  state = seedFromMatrixRows(rows, { state });
  saveRisk(state);
  console.log('已从 ' + files.length + ' 份历史矩阵报告补种名单：' + riskSummary(state).filter((x) => x.active).map((x) => x.app).join('、') || '（无）');
}

state = loadRisk();
const summary = riskSummary(state);
if (asJson) {
  console.log(JSON.stringify({ file: riskFile(), apps: summary }, null, 2));
} else {
  console.log('前台风险名单：' + riskFile());
  if (!summary.length) {
    console.log('（空）矩阵/协商目前不会跳过任何应用。');
  } else {
    console.log('| 应用 | 抢前台次数 | 最近一次 | 过期时间 | 剩余 | 原因 |');
    console.log('| --- | --- | --- | --- | --- | --- |');
    for (const row of summary) {
      console.log('| ' + row.app + ' | ' + row.count + ' | ' + fmt(row.lastStolenAt) + ' | ' + fmt(row.expiresAt)
        + ' | ' + (row.active ? row.daysLeft + ' 天' : '已过期') + ' | ' + (row.reason || '-') + ' |');
    }
    console.log('');
    console.log('生效中的应用读取会被矩阵/协商跳过（避免反复闪屏）。确认应用修好后：npm run front:risk -- --clear "应用名"');
  }
}
