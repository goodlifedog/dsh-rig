#!/usr/bin/env node
/**
 * 生成 flow/TASKS.md：扫描 core/tasks/*.mjs 的文件头注释，拼成任务清单。
 *   node scripts/tasks-doc.mjs          # 写到 flow/TASKS.md
 *   node scripts/tasks-doc.mjs --check  # 只检查是否过期（repo:check 用）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const TASKS_DIR = path.join(ROOT, 'core', 'tasks');
const OUT = path.join(ROOT, 'flow', 'TASKS.md');

// 会在真实应用里写东西的任务：清单里标出来，提醒别在用户编辑时跑
const WRITES = new Set([
  'background-control', 'form-fill', 'form-fill-local', 'terminal-control',
  'drive-agent', 'drive-agent-cli', 'user-chrome-demo',
  'boss-greet', 'greet-inner', 'greet-verify',
]);

export function taskDescription(source) {
  // 文件头可能是 shebang，也可能先有 import（迁移脚本会把 import 插到前面），
  // 所以在前 2000 字符里找第一段块注释，不要求从第 1 行开始。
  const head = String(source || '').slice(0, 2000);
  const m = /\/\*\*([\s\S]*?)\*\//.exec(head);
  if (!m) return '';
  for (const raw of m[1].split('\n')) {
    const line = raw.trim().replace(/^\*+\s?/, '').trim();
    if (line && !line.startsWith('@')) return line.replace(/[。;；]+$/, '');
  }
  return '';
}

export function buildTaskCatalog(files) {
  const rows = [];
  for (const [name, source] of files) {
    const desc = taskDescription(source) || '（文件头没写用途说明）';
    rows.push({ name, desc, writes: WRITES.has(name) });
  }
  const lines = [
    '# 任务清单',
    '',
    '> `npm run run <名字>` 就能跑；`desktop-agent tasks` 只列名字，用途看这里。',
    '> 本文件由 `npm run tasks:doc` 生成（扫描 `core/tasks/*.mjs` 的文件头注释），不要手改。',
    '> 标 ⚠️ 的会在真实应用里写东西（会尽量恢复原值，但别在用户正在编辑时跑）。',
    '',
    '| 任务 | 做什么 |',
    '| --- | --- |',
  ];
  for (const r of rows) lines.push('| `' + r.name + '` | ' + (r.writes ? '⚠️ ' : '') + r.desc + ' |');
  lines.push('');
  return lines.join('\n');
}

function readAll() {
  return fs.readdirSync(TASKS_DIR)
    .filter((f) => f.endsWith('.mjs'))
    .sort()
    .map((f) => [f.slice(0, -4), fs.readFileSync(path.join(TASKS_DIR, f), 'utf8')]);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const next = buildTaskCatalog(readAll());
  if (process.argv.includes('--check')) {
    const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
    if (current.trim() !== next.trim()) {
      console.error('flow/TASKS.md 与 core/tasks 不一致，跑 npm run tasks:doc 重新生成');
      process.exit(1);
    }
    console.log('任务清单是最新的');
  } else {
    fs.writeFileSync(OUT, next);
    console.log('已写入 flow/TASKS.md（' + readAll().length + ' 个任务）');
  }
}
