#!/usr/bin/env node
/**
 * 安全边界自查（静态）：扫 core/tasks 与 scripts 里的危险写法。
 *
 *   npm run safety:audit
 *
 * 退出码 0 = 干净；1 = 发现问题（会被 npm test 里的同名测试一起兜住）。
 * 只做结构检查，不能替代实机验收。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditTree, summarizeViolations } from '../core/safety-audit.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const DIRS = ['core/tasks', 'scripts'];

function collect(dir) {
  const base = path.join(ROOT, dir);
  let names = [];
  try { names = fs.readdirSync(base).filter((f) => f.endsWith('.mjs')); } catch { return []; }
  return names.map((f) => ({
    file: path.join(dir, f),
    source: fs.readFileSync(path.join(base, f), 'utf8'),
    uiGuard: dir === 'core/tasks',
  }));
}

const entries = DIRS.flatMap(collect);
const violations = entries.flatMap((entry) => {
  const { uiGuard, ...input } = entry;
  return auditTree([input], { base: '', uiGuard });
});
console.log('已检查 ' + entries.length + ' 个文件');
console.log(summarizeViolations(violations));
if (violations.length) process.exitCode = 1;
