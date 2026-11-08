#!/usr/bin/env node
// 外部评审用的巡检脚本：一条命令看清「现在项目健康不健康」。
// 只读：不跑验收、不启动应用、不改任何文件。
//   node scripts/review-watch.mjs
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const ENV = { ...process.env, PATH: ['/usr/bin', '/bin', '/usr/sbin', '/sbin', '/opt/homebrew/bin', path.join(os.homedir(), '.local/bin')].join(':') };
const rows = [];
function add(name, value) { rows.push([name, String(value)]); }
function sh(cmd, args) {
  return execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8', timeout: 180000, maxBuffer: 32 * 1024 * 1024, env: ENV });
}

function safe(name, fn) {
  try { add(name, fn()); } catch (e) { add(name, 'ERR ' + String(e.message || e).split('\n')[0].slice(0, 70)); }
}

safe('脏文件数', () => sh('git', ['status', '--porcelain']).trim().split('\n').filter(Boolean).length);
safe('最近提交', () => sh('git', ['log', '-1', '--format=%h %s']).trim());
safe('测试', () => {
  const t = sh('npm', ['test']);
  const pass = (t.match(/^# pass (\d+)/m) || [])[1];
  const fail = (t.match(/^# fail (\d+)/m) || [])[1];
  return 'pass ' + pass + ' / fail ' + fail;
});
safe('验收任务数', () => (fs.readFileSync(path.join(ROOT, 'core/acceptance.mjs'), 'utf8').match(/runTask\('/g) || []).length);
safe('daemon uptime(s)', () => JSON.parse(sh('curl', ['-sS', '-m', '3', 'http://127.0.0.1:7789/'])).uptimeSec);
safe('token 闸门', () => {
  const r = sh('curl', ['-sS', '-m', '3', '-o', '/dev/null', '-w', '%{http_code}', '-X', 'POST',
    '-H', 'Content-Type: application/json', '-d', '{}', 'http://127.0.0.1:7789/run']);
  return r === '401' ? '401 已生效' : r + ' 未生效（跑的是旧代码）';
});
safe('Origin 闸门', () => {
  const r = sh('curl', ['-sS', '-m', '3', '-o', '/dev/null', '-w', '%{http_code}',
    '-H', 'Origin: http://evil.com', 'http://127.0.0.1:7789/']);
  return r === '403' ? '403 已生效' : r + ' 未生效';
});
safe('孤儿任务', () => {
  const tasks = fs.readdirSync(path.join(ROOT, 'core/tasks')).filter((f) => f.endsWith('.mjs')).map((f) => f.slice(0, -4));
  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', '.git', 'logs', 'reports', 'dist', 'dist-app'].includes(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(mjs|js|md|json)$/.test(e.name)) files.push(p);
    }
  };
  walk(ROOT);
  // 只统计“真正引用任务名”的文档/脚本：任务注册目录本身不算引用
  const texts = files.filter((p) => !p.includes('core/tasks/')).map((p) => fs.readFileSync(p, 'utf8'));
  const orphans = tasks.filter((t) => !texts.some((x) => x.includes(t)));
  return orphans.length ? orphans.length + ' 个：' + orphans.slice(0, 6).join(', ') : '0';
});

const safety = await import(path.join(ROOT, 'core/safety.mjs'));
add('pid 复核边界', safety.pidMatchesProcess('Google Chrome Helper', 'Google Chrome') === false ? '正常' : '仍有误判');

const width = Math.max(...rows.map((r) => r[0].length)) + 2;
for (const [k, v] of rows) console.log(k.padEnd(width, ' '), v);
