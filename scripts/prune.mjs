#!/usr/bin/env node
'use strict';
/**
 * 清理运行时产物：logs/runs 与 reports 会随着每天的任务无限增长。
 *
 *   node scripts/prune.mjs            # 只报告，不删（默认 dry-run）
 *   node scripts/prune.mjs --apply    # 真的删
 *   KEEP_DAYS=14 KEEP_REPORTS=400 node scripts/prune.mjs --apply
 *
 * 只删本目录下 logs/runs、logs/daemon、reports 里的文件；不动 git 跟踪的文件。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KEEP_DAYS = Math.max(1, Number(process.env.KEEP_DAYS || 7));
const KEEP_REPORTS = Math.max(10, Number(process.env.KEEP_REPORTS || 200));
const APPLY = process.argv.includes('--apply');

const DAY = 24 * 60 * 60 * 1000;

function listFiles(dir) {
  try {
    return fs.readdirSync(dir)
      .map((name) => path.join(dir, name))
      .filter((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } })
      .map((p) => { const st = fs.statSync(p); return { path: p, name: path.basename(p), mtimeMs: st.mtimeMs, size: st.size }; });
  } catch { return []; }
}

export function planPrune({ files, now = Date.now(), keepDays = KEEP_DAYS, keepReports = KEEP_REPORTS } = {}) {
  const list = Array.isArray(files) ? files.slice() : [];
  const cutoff = now - keepDays * DAY;
  const sorted = list.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const keepSet = new Set();
  sorted.slice(0, keepReports).forEach((f) => keepSet.add(f.path));
  const remove = sorted.filter((f) => !keepSet.has(f.path) || f.mtimeMs < cutoff);
  const keep = sorted.filter((f) => !remove.includes(f));
  return { remove, keep, bytes: remove.reduce((n, f) => n + (f.size || 0), 0) };
}

function section(name, dir, keepCount) {
  const files = listFiles(dir);
  if (!files.length) { console.log(name + '：空'); return { removed: 0, bytes: 0 }; }
  const plan = planPrune({ files, keepReports: keepCount });
  console.log(
    name + '：共 ' + files.length + ' 个，保留 ' + plan.keep.length + ' 个，' +
    (APPLY ? '删除 ' : '可删 ') + plan.remove.length + ' 个（' + (plan.bytes / 1024).toFixed(1) + ' KB）'
  );
  if (APPLY) {
    for (const f of plan.remove) { try { fs.unlinkSync(f.path); } catch {} }
  }
  return { removed: plan.remove.length, bytes: plan.bytes };
}

const runs = section('logs/runs', path.join(ROOT, 'logs', 'runs'), 500);
const daemon = section('logs/daemon', path.join(ROOT, 'logs', 'daemon'), 200);
const reports = section('reports', path.join(ROOT, 'reports'), KEEP_REPORTS);

const total = runs.bytes + daemon.bytes + reports.bytes;
console.log((APPLY ? '已释放 ' : '可释放 ') + (total / 1024 / 1024).toFixed(2) + ' MB' + (APPLY ? '' : '（加 --apply 才会真删）'));

const isMain = process.argv[1] && process.argv[1].endsWith('prune.mjs');
if (isMain && process.argv.includes('--self-test')) {
  const now = Date.now();
  const files = [
    { path: 'a', mtimeMs: now, size: 10 },
    { path: 'b', mtimeMs: now - 30 * DAY, size: 10 },
  ];
  const p = planPrune({ files, now, keepDays: 7, keepReports: 10 });
  console.log('self-test 删除项:', p.remove.map((f) => f.path).join(',') || '(无)');
}
