#!/usr/bin/env node
/**
 * 生成 flow/TASK-ENV.md：把代码里读到的环境变量列全（含默认值），避免「只有代码知道」。
 *   node scripts/env-doc.mjs          # 写入 flow/TASK-ENV.md
 *   node scripts/env-doc.mjs --check  # 只检查是否过期（repo:check 用）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDirectRun } from '../core/direct-run.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'flow', 'TASK-ENV.md');

// 系统自带变量：不是本项目定义的，列表里不列
const OS_VARS = new Set(['PATH', 'HOME', 'TMPDIR', 'APPDATA', 'USERPROFILE', 'SHELL', 'LANG', 'LC_ALL', 'TZ', 'PWD', 'USER', 'LOGNAME', 'TERM']);

const SOURCE_GLOBS = ['core', 'scripts', 'overlay'];

/** 从源代码里抽出 `process.env.X` 的用法；返回 Map<varName, {files:Set, defaults:Set}> */
export function collectEnvVars(sources) {
  const found = new Map();
  for (const { file, source } of sources) {
    const text = String(source || '');
    const re = /process\.env\.([A-Z][A-Z0-9_]{2,})/g;
    let m;
    while ((m = re.exec(text))) {
      const name = m[1];
      if (OS_VARS.has(name)) continue;
      const entry = found.get(name) || { files: new Set(), defaults: new Set() };
      entry.files.add(file);
      found.set(name, entry);
    }
    // 补充默认值：process.env.X || 'literal' / ?? 123 / === '1'
    const defRe = /process\.env\.([A-Z][A-Z0-9_]{2,})\s*(?:\|\||\?\?|===)\s*('([^']*)'|"([^"]*)"|(\d+))/g;
    let d;
    while ((d = defRe.exec(text))) {
      const name = d[1];
      if (OS_VARS.has(name)) continue;
      const value = d[3] !== undefined ? d[3] : (d[4] !== undefined ? d[4] : d[5]);
      if (!value) continue;
      const entry = found.get(name) || { files: new Set(), defaults: new Set() };
      entry.defaults.add(value === '1' ? '（开关，设 1 开启）' : value);
      found.set(name, entry);
    }
  }
  return found;
}

export function buildEnvDoc(found) {
  const names = Array.from(found.keys()).sort();
  const lines = [
    '# 环境变量清单',
    '',
    '> 由 `npm run env:doc` 扫代码生成（`process.env.*` 的全部用法），不要手改。',
    '> 只列本项目自己的变量；系统变量（PATH/HOME/TMPDIR 等）不列。默认值来自代码里的字面量，取不到就留空。',
    '',
    '| 变量 | 代码里的默认值 | 出现位置 |',
    '| --- | --- | --- |',
  ];
  for (const name of names) {
    const entry = found.get(name);
    const def = Array.from(entry.defaults).join(' / ');
    const files = Array.from(entry.files).sort().map((f) => '`' + f + '`').join('<br>');
    lines.push('| `' + name + '` | ' + (def || '—') + ' | ' + files + ' |');
  }
  lines.push('');
  return lines.join('\n');
}

function readSources() {
  const out = [];
  for (const dir of SOURCE_GLOBS) {
    const base = path.join(ROOT, dir);
    const walk = (d) => {
      for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
        if (ent.name === 'node_modules' || ent.name.startsWith('.')) continue;
        const full = path.join(d, ent.name);
        if (ent.isDirectory()) { walk(full); continue; }
        if (!/\.(mjs|js|cjs)$/.test(ent.name)) continue;
        out.push({ file: path.relative(ROOT, full), source: fs.readFileSync(full, 'utf8') });
      }
    };
    if (fs.existsSync(base)) walk(base);
  }
  return out;
}

const isMain = isDirectRun(import.meta.url);
if (isMain) {
  const next = buildEnvDoc(collectEnvVars(readSources()));
  if (process.argv.includes('--check')) {
    const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
    if (current.trim() !== next.trim()) {
      console.error('flow/TASK-ENV.md 与代码不一致，跑 npm run env:doc 重新生成');
      process.exit(1);
    }
    console.log('环境变量清单是最新的');
  } else {
    fs.writeFileSync(OUT, next);
    console.log('已写入 flow/TASK-ENV.md');
  }
}
