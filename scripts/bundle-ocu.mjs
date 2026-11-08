'use strict';
// 随包分发 ocu 的合规附带：许可与声明放到 third_party/（随仓库提交、随导出包分发）。
// 默认只带许可与声明，加 --with-binary 才拷运行时。
//   node scripts/bundle-ocu.mjs            # 只带 LICENSE / 声明 / 元数据
//   node scripts/bundle-ocu.mjs --with-binary   # 连运行时一起拷（体积大）
import { execFileSync } from 'node:child_process';
import fsp from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const DEST = path.join(ROOT, 'third_party', 'open-computer-use');
const withBinary = process.argv.includes('--with-binary');

/**
 * 找 open-computer-use 的安装位置（按优先级）：
 *   1. 本项目的 node_modules —— 0.8.0 起它是普通依赖，npm install 就在，不需要用户全局装；
 *   2. npm 全局 root；
 *   3. 当前 node 自带的前缀（~/.local/opt/node-* 这类自装 node 的全局目录）。
 */
function findOcuRoot() {
  const candidates = [];
  // 1) 项目依赖（首选：克隆 → npm install 即可，来源和运行时一致）
  candidates.push(path.join(ROOT, 'node_modules', 'open-computer-use'));
  // 2) npm 全局
  try {
    const globalRoot = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim();
    candidates.push(path.join(globalRoot, 'open-computer-use'));
  } catch {}
  // 3) 当前 node 的全局前缀（不写死版本号，换 node 版本也不会失效）
  candidates.push(path.join(path.dirname(path.dirname(process.execPath)), 'lib', 'node_modules', 'open-computer-use'));
  return candidates;
}

async function exists(p) { try { await fsp.access(p); return true; } catch { return false; } }


/** 计算文件 sha256（十六进制）；读不到返回空串 */
async function sha256OfFile(file) {
  try {
    const buf = await fsp.readFile(file);
    return crypto.createHash('sha256').update(buf).digest('hex');
  } catch { return ''; }
}

export function buildNotice(pkg, options = {}) {
  const withBinary = Boolean(options.withBinary);
  const sha256 = String(options.sha256 || '');
  const lines = [
    '# 随包第三方组件',
    '',
    '## open-computer-use ' + (pkg && pkg.version ? pkg.version : '未知版本'),
    '',
    '- 许可：' + ((pkg && pkg.license) || 'MIT'),
    '- 仓库：' + ((pkg && pkg.repository && pkg.repository.url) || 'https://github.com/iFurySt/open-computer-use'),
    '- 作用：macOS 控制层（Accessibility 读写、语义点击、后台键入）',
    '- 本仓库未修改其源码，仅作为运行时依赖使用',
  ];
  if (withBinary) {
    // 记下随包二进制的指纹：构建产物可复核，也方便日后确认「发出去的到底是哪一份」
    lines.push('- 随包运行时：bin/ 与 dist/（`node scripts/bundle-ocu.mjs --with-binary` 生成）');
    lines.push('- 主二进制 sha256：' + (sha256 || '（未取到）'));
  } else {
    lines.push('- 本包只附带许可与声明，未包含运行时（需用户自行安装）');
  }
  lines.push('', '原始许可全文见同目录 LICENSE，第三方声明见 THIRD_PARTY_NOTICES.md。', '');
  return lines.join('\n');
}

async function main() {
  let src = null;
  for (const c of findOcuRoot()) { if (await exists(c)) { src = c; break; } }
  if (!src) {
    console.error('没找到 open-computer-use：先在项目里 npm install（它已是 dependencies），或 npm i -g open-computer-use');
    process.exit(1);
  }

  const pkg = JSON.parse(await fsp.readFile(path.join(src, 'package.json'), 'utf8'));
  await fsp.mkdir(DEST, { recursive: true });

  for (const f of ['LICENSE', 'THIRD_PARTY_NOTICES.md', 'README.md', 'package.json']) {
    const from = path.join(src, f);
    if (await exists(from)) await fsp.copyFile(from, path.join(DEST, f));
  }

  if (withBinary) {
    console.log('拷贝运行时（可能较慢）…');
    for (const dir of ['bin', 'dist', 'scripts']) {
      const from = path.join(src, dir);
      if (await exists(from)) await fsp.cp(from, path.join(DEST, dir), { recursive: true, force: true });
    }
  }

  const sha256 = withBinary ? await sha256OfFile(path.join(DEST, 'bin', 'ocu')) : '';
  const notice = buildNotice(pkg, { withBinary, sha256 });
  await fsp.writeFile(path.join(DEST, 'NOTICE.md'), notice);

  console.log('已生成 ' + path.relative(ROOT, DEST) + (withBinary ? '（含运行时）' : '（仅许可与声明）'));
}

main().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
