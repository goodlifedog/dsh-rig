'use strict';
// 仓库体检：保证可以安全地传到公开仓库，且各处版本一致。
//   node scripts/repo-check.mjs
import { execFileSync } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const rows = [];
function add(name, ok, detail, skipped) { rows.push({ name, ok, detail: detail || '', skipped: Boolean(skipped) }); }

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
let hasGit = false;
try {
  tracked = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  hasGit = true;
} catch {}
// 下载 ZIP 的用户没有 .git：依赖 git 的检查只能跳过，不能判红（那条红跟代码质量无关）
add('git 仓库可用', hasGit, hasGit ? '' : '非 git 目录（下载 ZIP 的场景），相关检查改为跳过', !hasGit);
const junk = tracked.filter((f) => /node_modules\/|^logs\/|^reports\/|^dist\/|\.DS_Store$|^overlay\/node_modules/.test(f));
add('没有提交依赖与运行时产物', hasGit ? junk.length === 0 : true, hasGit ? junk.slice(0, 3).join(', ') : '跳过（非 git 目录）', !hasGit);

// 3b. 文档截图不能是孤儿：提交了却没有任何 md/html 引用，就是白占体积的死重量
// （评审实测 overlay/docs 里有一批早期截图，20 张没被引用、占 2.8MB）
const imageFiles = tracked.filter((f) => /^(docs|overlay\/docs)\/.*\.(png|jpe?g|gif|webp)$/i.test(f));
const imageDocFiles = tracked.filter((f) => /\.(md|html)$/i.test(f) && !f.startsWith('reports/'));
let docCorpus = '';
for (const f of imageDocFiles) {
  try { docCorpus += await fsp.readFile(path.join(ROOT, f), 'utf8'); } catch {}
}
const orphanImages = imageFiles.filter((img) => !docCorpus.includes(path.basename(img)));
add('文档截图都有引用（没有孤儿图）', hasGit ? orphanImages.length === 0 : true, hasGit ? orphanImages.slice(0, 3).join(', ') : '跳过（非 git 目录）', !hasGit);

// 4. 大文件
const big = [];
for (const f of tracked) {
  try {
    const st = await fsp.stat(path.join(ROOT, f));
    if (st.size > 2 * 1024 * 1024) big.push(f + ' (' + Math.round(st.size / 1024) + 'KB)');
  } catch {}
}
add('没有超过 2MB 的文件', hasGit ? big.length === 0 : true, hasGit ? big.slice(0, 3).join(', ') : '跳过（非 git 目录）', !hasGit);

// 5. 隐私扫描（邮箱/手机号/绝对用户路径/本机用户名与机器名）
const leaks = [];
// 动态拿当前机器的用户名/主机名，不把任何真实姓名写进代码：
// 仓库里一旦出现本机用户名或机器名（例如测试 fixture 里写死 /Users/<name>），公开出去就等于泄露本机信息。
const GENERIC_USERS = new Set(['user', 'users', 'tester', 'test', 'runner', 'root', 'admin', 'ci', 'dev', 'guest', 'node', 'ubuntu', 'mac', 'macbook', 'localhost', 'example']);
function personalTokens() {
  const tokens = [];
  try {
    const user = String(os.userInfo().username || '').trim();
    if (user.length >= 3 && !GENERIC_USERS.has(user.toLowerCase())) tokens.push(user);
  } catch {}
  try {
    const host = String(os.hostname() || '').trim().replace(/\.local$/i, '');
    if (host.length >= 3 && !GENERIC_USERS.has(host.toLowerCase())) tokens.push(host);
  } catch {}
  return [...new Set(tokens)];
}
const tokens = personalTokens();
for (const f of tracked) {
  if (!/\.(mjs|js|md|json|ps1|sh|ya?ml|diff|plist|txt)$/i.test(f)) continue;
  const text = await fsp.readFile(path.join(ROOT, f), 'utf8').catch(() => '');
  if (/\/Users\/[a-zA-Z0-9_.-]+\/(Desktop|Documents|Downloads)/.test(text)) leaks.push(f + ' 含绝对用户路径');
  // 手机号要独立成数，避免把 13 位时间戳误判
  if (/(?<!\d)1[3-9]\d{9}(?!\d)/.test(text.replace(/https?:\/\/\S+/g, ''))) leaks.push(f + ' 疑似手机号');
  if (tokens.some((t) => text.toLowerCase().includes(t.toLowerCase()))) leaks.push(f + ' 含本机用户名/机器名');
}
add('没有绝对路径/手机号/本机用户名泄漏', hasGit ? leaks.length === 0 : true,
  hasGit ? leaks.slice(0, 3).join(', ') : '跳过（非 git 目录，没有文件列表）', !hasGit);

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



// 8b. 文档里引用的源文件必须真的存在（写死文件名是最容易腐烂的引用）
try {
  const docFiles = ['README.md', 'ARCHITECTURE.md', 'THIRD-PARTY.md'].concat(
    (await fsp.readdir(ROOT)).filter((f) => f.endsWith('.md')).map((f) => f),
    await fsp.readdir(path.join(ROOT, 'docs')).then((l) => l.filter((f) => f.endsWith('.md')).map((f) => 'docs/' + f)).catch(() => []),
    await fsp.readdir(path.join(ROOT, 'flow')).then((l) => l.filter((f) => f.endsWith('.md')).map((f) => 'flow/' + f)).catch(() => []),
  );
  const known = new Set();
  for (const dir of ['core', 'overlay', 'scripts', 'tools', 'test']) {
    try {
      for (const f of await fsp.readdir(path.join(ROOT, dir), { recursive: true })) {
        const name = String(f).split('/').pop();
        if (/\.(mjs|js|cjs|ps1|html|yml|json)$/.test(name)) known.add(name);
      }
    } catch {}
  }
  for (const f of ['package.json', 'CHANGELOG.md', 'LICENSE']) known.add(f);
  const bad = [];
  for (const doc of docFiles) {
    // 评审与交接文档是历史记录：里面引用的文件可能已经删了，不该按现状判
    if (/(^|\/)(REVIEW|HANDOFF)/.test(doc)) continue;
    if (/PATCHES\.md$/.test(doc)) continue;   // 补丁索引写的是「应用后会有的文件」
    let text = '';
    try { text = await fsp.readFile(path.join(ROOT, doc), 'utf8'); } catch { continue; }
    for (const m of text.matchAll(/`([A-Za-z0-9_./-]+\.(?:mjs|js|cjs|ps1|html|yml))`/g)) {
      let name = m[1];
      // 忽略 URL 片段与本机绝对路径；文档里常写 desktop-agent/ 前缀（相对父目录），去掉再判
      if (name.startsWith('/')) continue;
      if (/^https?:/.test(name)) continue;
      name = name.replace(/^desktop-agent\//, '');
      // 带路径的按仓库根判断；只写文件名的按已知文件名集合判断
      if (name.includes('/')) {
        const exists = await fsp.access(path.join(ROOT, name)).then(() => true).catch(() => false);
        if (!exists) bad.push(doc + ' → ' + name);
        continue;
      }
      if (!known.has(name)) bad.push(doc + ' → ' + name);
    }
  }
  add('文档引用的源文件都存在', bad.length === 0, bad.slice(0, 5).join('；'));
} catch (error) {
  add('文档引用的源文件都存在', false, '检查失败：' + String(error.message).slice(0, 60));
}

// 9. flow/ 下每份文档都要能从 INDEX 找到（新写文档忘了加索引是反复出现的问题）
try {
  const flowDir = path.join(ROOT, 'flow');
  const names = (await fsp.readdir(flowDir)).filter((f) => f.endsWith('.md'));
  const index = await fsp.readFile(path.join(flowDir, 'INDEX.md'), 'utf8');
  const EXEMPT = new Set(['INDEX.md']);   // 索引自己，以及公开发布前要移除的 BOSS-*
  const missingDocs = names.filter((f) => {
    if (EXEMPT.has(f)) return false;
    if (/^BOSS-/.test(f)) return false;    // 见 BOSS-EXTRACT：公开前移除
    return !index.includes(f);
  });
  add('flow 文档都能从 INDEX 找到', missingDocs.length === 0,
    missingDocs.length ? '未收录：' + missingDocs.slice(0, 5).join(', ') : names.length + ' 份文档都有入口');
} catch (error) {
  add('flow 文档都能从 INDEX 找到', false, '检查失败：' + String(error.message).slice(0, 60));
}

// 10b. flow/TASK-ENV.md 必须与代码里的 process.env 用法同步
try {
  execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'env-doc.mjs'), '--check'], { cwd: ROOT, stdio: 'pipe' });
  add('环境变量清单与代码同步', true);
} catch (error) {
  add('环境变量清单与代码同步', false, '跑 npm run env:doc 重新生成');
}
// 10. flow/TASKS.md 必须与 core/tasks 同步（改了任务忘了更新清单 → 文档失真）
try {
  execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'tasks-doc.mjs'), '--check'], { cwd: ROOT, stdio: 'pipe' });
  add('任务清单与 core/tasks 同步', true);
} catch {
  add('任务清单与 core/tasks 同步', false, '清单过期：跑 npm run tasks:doc 重新生成');
}

// 11. 带 shebang 的可执行脚本，shebang 必须在第一行（import 插到它前面 = node 直接语法错）
// 真实事故：批量把 import 加到文件顶部，8 个带 #!/usr/bin/env node 的脚本全被写坏。
try {
  const scriptFiles = tracked.filter((f) => /\.(mjs|js|cjs)$/.test(f));
  const shebangBad = [];
  for (const f of scriptFiles) {
    let text = '';
    try { text = await fsp.readFile(path.join(ROOT, f), 'utf8'); } catch { continue; }
    if (text.startsWith('#!')) continue;
    const firstLines = text.split('\n', 3);
    if (firstLines.some((line) => line.startsWith('#!'))) shebangBad.push(f);
  }
  add('shebang 都在第一行', hasGit ? shebangBad.length === 0 : true,
    hasGit ? shebangBad.slice(0, 3).join(', ') : '跳过（非 git 目录，没有文件列表）', !hasGit);
} catch (error) {
  add('shebang 都在第一行', false, '检查失败：' + String(error.message).slice(0, 60));
}

// 12. 文档里不能留「待补」这类占位标记：公开仓库里看着像没写完
// 评审/交接/补丁索引是历史记录，允许保留这类字样
try {
  const docCandidates = tracked.filter((f) => /\.md$/i.test(f) && !/(^|\/)(REVIEW|HANDOFF)/.test(f)
    && !/PATCHES\.md$/.test(f) && !/^CHANGELOG\.md$/.test(f));
  const placeholders = [];
  for (const f of docCandidates) {
    let text = '';
    try { text = await fsp.readFile(path.join(ROOT, f), 'utf8'); } catch { continue; }
    if (/待补/.test(text)) placeholders.push(f);
  }
  add('文档里没有待补占位', !hasGit || placeholders.length === 0,
    hasGit ? placeholders.slice(0, 3).join(', ') : '跳过（非 git 目录，没有文件列表）', !hasGit);
} catch (error) {
  add('文档里没有待补占位', false, '检查失败：' + String(error.message).slice(0, 60));
}

const width = Math.max(...rows.map((r) => r.name.length)) + 2;
console.log('\n仓库体检\n');
for (const r of rows) console.log((r.skipped ? '  ⏭️  ' : (r.ok ? '  ✅ ' : '  ❌ ')) + r.name.padEnd(width) + r.detail);
const bad = rows.filter((r) => !r.ok && !r.skipped);
console.log('\n' + (bad.length ? bad.length + ' 项未通过' : '全部通过') + '\n');
process.exit(bad.length ? 1 : 0);
