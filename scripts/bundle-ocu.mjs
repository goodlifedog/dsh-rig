'use strict';
// 随包分发 ocu 的合规附带：许可与声明放到 third_party/（随仓库提交、随导出包分发）。
// 默认只带许可与声明，加 --with-binary 才拷运行时。
//   node scripts/bundle-ocu.mjs            # 只带 LICENSE / 声明 / 元数据
//   node scripts/bundle-ocu.mjs --with-binary   # 连运行时一起拷（体积大）
import { execFileSync } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const DEST = path.join(ROOT, 'third_party', 'open-computer-use');
const withBinary = process.argv.includes('--with-binary');

function findOcuRoot() {
  const candidates = [];
  try {
    const globalRoot = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim();
    candidates.push(path.join(globalRoot, 'open-computer-use'));
  } catch {}
  const home = process.env.HOME || process.env.USERPROFILE || '';
  candidates.push(path.join(home, '.local/opt/node-v20.18.0-darwin-arm64/lib/node_modules/open-computer-use'));
  return candidates;
}

async function exists(p) { try { await fsp.access(p); return true; } catch { return false; } }

async function main() {
  let src = null;
  for (const c of findOcuRoot()) { if (await exists(c)) { src = c; break; } }
  if (!src) { console.error('没找到已安装的 open-computer-use，请先 npm i -g open-computer-use'); process.exit(1); }

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

  const notice = [
    '# 随包第三方组件',
    '',
    '## open-computer-use ' + pkg.version,
    '',
    '- 许可：' + (pkg.license || 'MIT'),
    '- 仓库：' + ((pkg.repository && pkg.repository.url) || 'https://github.com/iFurySt/open-computer-use'),
    '- 作用：macOS 控制层（Accessibility 读写、语义点击、后台键入）',
    '- 本仓库未修改其源码，仅作为运行时依赖使用',
    '',
    '原始许可全文见同目录 LICENSE，第三方声明见 THIRD_PARTY_NOTICES.md。',
    withBinary ? '' : '本包只附带许可与声明，未包含运行时（需用户自行安装）。',
    ''
  ].join('\n');
  await fsp.writeFile(path.join(DEST, 'NOTICE.md'), notice);

  console.log('已生成 ' + path.relative(ROOT, DEST) + (withBinary ? '（含运行时）' : '（仅许可与声明）'));
}

main().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
