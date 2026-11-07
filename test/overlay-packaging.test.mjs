'use strict';
// 打包配置必须覆盖 main.js 真正 require 的模块：漏一个，打包出来的 App 一启动就 MODULE_NOT_FOUND。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const yml = fs.readFileSync(path.join(ROOT, 'overlay', 'electron-builder.yml'), 'utf8');
const main = fs.readFileSync(path.join(ROOT, 'overlay', 'main.js'), 'utf8');

function filesPatterns() {
  const lines = yml.split('\n');
  const start = lines.findIndex((l) => /^files:\s*$/.test(l));
  if (start < 0) return [];
  const out = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^[a-zA-Z]/.test(line)) break;   // 下一个顶层键
    const m = /^\s*-\s*"?([^"#]+)"?/.exec(line);
    if (m) out.push(m[1].trim());
  }
  return out;
}

function coveredBy(file, patterns) {
  const negs = patterns.filter((p) => p.startsWith('!')).map((p) => p.slice(1));
  if (negs.some((p) => new RegExp('^' + p.replace(/[*.]/g, (c) => (c === '*' ? '.*' : '\\.')) + '$').test(file))) return false;
  return patterns.some((p) => {
    if (p.startsWith('!')) return false;
    if (p.includes('*')) return new RegExp('^' + p.replace(/[*.]/g, (c) => (c === '*' ? '.*' : '\\.')) + '$').test(file);
    return p === file;
  });
}

test('main.js require 的每个本地模块都在打包白名单里', () => {
  const patterns = filesPatterns();
  assert.ok(patterns.length > 0, '解析不到 files 段');
  const required = Array.from(main.matchAll(/require\('\.\/([a-z0-9-]+\.js)'\)/g)).map((m) => m[1]);
  assert.ok(required.length > 5, 'main.js 应 require 多个本地模块，实际 ' + required.length);
  const missing = required.filter((f) => !coveredBy(f, patterns));
  assert.deepEqual(missing, [], '打包会漏掉这些模块，App 启动会 MODULE_NOT_FOUND：' + missing.join(', '));
});

test('index.html 与 package.json 必须被打包（Electron 启动需要）', () => {
  const patterns = filesPatterns();
  assert.ok(coveredBy('index.html', patterns), 'index.html 不在白名单');
  assert.ok(coveredBy('package.json', patterns), 'package.json 不在白名单');
});
