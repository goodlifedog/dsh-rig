'use strict';
// 仓库体检：保证可以安全地传到公开仓库，且各处版本一致。
//   node scripts/repo-check.mjs
import { execFileSync } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const rows = [];
function add(name, ok, detail) { rows.push({ name, ok, detail: detail || '' }); }

async function exists(p) { try { await fsp.access(p); return true; } catch { return false; } }

// 1. 必需文件
for (const f of ['README.md', 'LICENSE', 'CHANGELOG.md', 'package.json', '.gitignore']) {
  add('存在 ' + f, await exists(path.join(ROOT, f)));
}

// 2. 版本一致性
const pkg = JSON.parse(await fsp.readFile(path.join(ROOT, 'package.json'), 'utf8'));
const changelog = await fsp.readFile(path.join(ROOT, 'CHANGELOG.md'), 'utf8');
const topVersion = (changelog.match(/^## (\d+\.\d+\.\d+)/m) || [])[1];
add('package.json 版本与 CHANGELOG 一致', pkg.version === topVersion, pkg.version + ' vs ' + topVersion);

// 2b. overlay 版本要和主包一致（否则打包产物版本号会是错的）
try {
  const ovPkg = JSON.parse(await fsp.readFile(path.join(ROOT, 'overlay', 'package.json'), 'utf8'));
  add('overlay 版本与主包一致', ovPkg.version === pkg.version, ovPkg.version + ' vs ' + pkg.version);
} catch { add('overlay 版本与主包一致', false, '读不到 overlay/package.json'); }

// 3. 没有把依赖/产物提交进去
let tracked = [];
try {
  tracked = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).trim().split('\n').filter(Boolean);
} catch { add('git 仓库可用', false, 'git ls-files 失败'); }
const junk = tracked.filter((f) => /node_modules\/|^logs\/|^reports\/|^dist\/|\.DS_Store$|^overlay\/node_modules/.test(f));
add('没有提交依赖与运行时产物', junk.length === 0, junk.slice(0, 3).join(', '));

// 3b. 文档截图不能是孤儿：提交了却没有任何 md/html 引用，就是白占体积的死重量
// （评审实测 overlay/docs 里有一批早期截图，20 张没被引用、占 2.8MB）
const imageFiles = tracked.filter((f) => /^(docs|overlay\/docs)\/.*\.(png|jpe?g|gif|webp)$/i.test(f));
const imageDocFiles = tracked.filter((f) => /\.(md|html)$/i.test(f) && !f.startsWith('reports/'));
let docCorpus = '';
for (const f of imageDocFiles) {
  try { docCorpus += await fsp.readFile(path.join(ROOT, f), 'utf8'); } catch {}
}
const orphanImages = imageFiles.filter((img) => !docCorpus.includes(path.basename(img)));
add('文档截图都有引用（没有孤儿图）', orphanImages.length === 0, orphanImages.slice(0, 3).join(', '));

// 4. 大文件
const big = [];
for (const f of tracked) {
  try {
    const st = await fsp.stat(path.join(ROOT, f));
    if (st.size > 2 * 1024 * 1024) big.push(f + ' (' + Math.round(st.size / 1024) + 'KB)');
  } catch {}
}
add('没有超过 2MB 的文件', big.length === 0, big.slice(0, 3).join(', '));

// 5. 隐私扫描（邮箱/手机号/绝对用户路径）
const leaks = [];
for (const f of tracked) {
  if (!/\.(mjs|js|md|json|ps1|sh)$/.test(f)) continue;
  const text = await fsp.readFile(path.join(ROOT, f), 'utf8').catch(() => '');
  if (/\/Users\/[a-zA-Z0-9_.-]+\/(Desktop|Documents|Downloads)/.test(text)) leaks.push(f + ' 含绝对用户路径');
  // 手机号要独立成数，避免把 13 位时间戳误判
  if (/(?<!\d)1[3-9]\d{9}(?!\d)/.test(text.replace(/https?:\/\/\S+/g, ''))) leaks.push(f + ' 疑似手机号');
}
add('没有绝对路径/手机号泄漏', leaks.length === 0, leaks.slice(0, 3).join(', '));

// 6. 文档里提到的 npm run 命令必须真实存在（文档漂移最容易发生在这里）
// overlay 有自己的 package.json（打包用），它文档里的命令要在 overlay 的 scripts 里找
const scripts = Object.assign({}, pkg.scripts || {});
try {
  const ovPkg = JSON.parse(await fsp.readFile(path.join(ROOT, 'overlay', 'package.json'), 'utf8'));
  Object.assign(scripts, ovPkg.scripts || {});
} catch {}
const docFiles = ['README.md', 'docs/USAGE.md', 'ARCHITECTURE.md', 'overlay/README.md'];
const missing = new Set();
let mentioned = 0;
for (const f of docFiles) {
  if (!(await exists(path.join(ROOT, f)))) continue;
  const text = await fsp.readFile(path.join(ROOT, f), 'utf8');
  for (const m of text.matchAll(/npm run ([a-z0-9:_-]+)/g)) {
    const name = m[1];
    mentioned += 1;
    if (!scripts[name]) missing.add(name);
  }
}
add('文档里的 npm 命令都存在', missing.size === 0,
  missing.size ? '缺：' + Array.from(missing).join(', ') : mentioned + ' 处引用全部命中');

// 7. 文档里引用的图片文件必须存在（README 常见断链）
const brokenImages = [];
for (const f of docFiles) {
  if (!(await exists(path.join(ROOT, f)))) continue;
  const text = await fsp.readFile(path.join(ROOT, f), 'utf8');
  const dir = path.dirname(path.join(ROOT, f));
  for (const m of text.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)) {
    const target = m[1].split(/[?#]/)[0];
    if (/^https?:/i.test(target)) continue;
    if (!(await exists(path.resolve(dir, target)))) brokenImages.push(f + ' → ' + target);
  }
}
add('文档引用的图片都存在', brokenImages.length === 0, brokenImages.slice(0, 3).join('；'));

// 8. 后台控制 API 必须都在文档里有说明（防止加了能力没写文档）
try {
  const bg = await fsp.readFile(path.join(ROOT, 'core', 'background.mjs'), 'utf8');
  const doc = await fsp.readFile(path.join(ROOT, 'flow', 'BACKGROUND-CONTROL.md'), 'utf8');
  const names = Array.from(bg.matchAll(/export (?:async )?function ([a-zA-Z0-9_]+)/g)).map((m) => m[1]);
  const missing = names.filter((n) => !doc.includes(n));
  add('后台能力都有文档', missing.length === 0, missing.length ? '缺：' + missing.join(', ') : names.length + ' 个 API 全部有说明');
} catch (error) {
  add('后台能力都有文档', false, '检查失败：' + String(error.message).slice(0, 60));
}

const width = Math.max(...rows.map((r) => r.name.length)) + 2;
console.log('\n仓库体检\n');
for (const r of rows) console.log((r.ok ? '  ✅ ' : '  ❌ ') + r.name.padEnd(width) + r.detail);
const bad = rows.filter((r) => !r.ok);
console.log('\n' + (bad.length ? bad.length + ' 项未通过' : '全部通过') + '\n');
process.exit(bad.length ? 1 : 0);
