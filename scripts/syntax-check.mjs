#!/usr/bin/env node
// 语法检查：把仓库里所有运行时代码过一遍 node --check。
// 之前是手写 6 个文件的链式命令，新文件（run-classify、tasks/*、scripts/*）根本不在覆盖里。
//   node scripts/syntax-check.mjs
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'third_party', 'logs', 'reports', 'docs']);
const EXT = new Set(['.mjs', '.js', '.cjs']);

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(full, out);
    } else if (EXT.has(path.extname(entry.name))) {
      out.push(full);
    }
  }
  return out;
}

const targets = ['core', 'overlay', 'scripts', 'test']
  .map((d) => path.join(ROOT, d))
  .filter((d) => fs.existsSync(d))
  .flatMap((d) => (d.endsWith('test') ? walk(d) : walk(d)))
  .filter((f) => !f.includes('node_modules'));

const failed = [];
for (const file of targets) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (error) {
    failed.push({ file: path.relative(ROOT, file), message: String(error.stderr || error.message).split('\n').slice(0, 3).join(' ') });
  }
}

console.log('\n语法检查\n');
console.log('  检查文件：' + targets.length + ' 个');
if (failed.length) {
  for (const f of failed) console.log('  ❌ ' + f.file + '  ' + f.message);
  console.log('\n' + failed.length + ' 个文件有语法错误\n');
  process.exit(1);
}
console.log('  全部通过\n');
