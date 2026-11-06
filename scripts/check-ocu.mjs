'use strict';
// 检查随包/本地 ocu 与 npm 上最新版是否一致，避免长期落后上游。
//   node scripts/check-ocu.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveOcu, bundledOcu } from '../core/platform.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

function readLocalVersion() {
  const packaged = path.join(ROOT, 'third_party', 'open-computer-use', 'package.json');
  if (fs.existsSync(packaged)) {
    const p = JSON.parse(fs.readFileSync(packaged, 'utf8'));
    return { version: p.version, from: 'third_party（随包）' };
  }
  const bin = resolveOcu();
  if (bin) {
    // 全局安装在 <prefix>/lib/node_modules/open-computer-use
    let dir = path.dirname(bin);
    for (let i = 0; i < 4; i++) {
      const cand = path.join(dir, 'package.json');
      if (fs.existsSync(cand)) {
        const p = JSON.parse(fs.readFileSync(cand, 'utf8'));
        if (p.name === 'open-computer-use') return { version: p.version, from: '全局安装' };
      }
      dir = path.dirname(dir);
    }
  }
  return null;
}

async function main() {
  const local = readLocalVersion();
  if (!local) { console.error('找不到本地 ocu'); process.exit(1); }
  let latest = null;
  try {
    const r = await fetch('https://registry.npmjs.org/open-computer-use/latest', { signal: AbortSignal.timeout(10000) });
    const d = await r.json();
    latest = d.version;
  } catch (e) {
    console.log('查询 npm 失败（离线？）：' + e.message);
  }

  console.log('本地 ocu:', local.version, '（' + local.from + '）');
  console.log('npm 最新:', latest || '未取到');
  if (!latest) process.exit(0);
  if (latest === local.version) {
    console.log('✅ 与上游一致');
    return;
  }
  console.log('⚠️  与上游不一致。同步步骤：');
  console.log('   1. npm i -g open-computer-use@' + latest);
  console.log('   2. node scripts/bundle-ocu.mjs --with-binary');
  console.log('   3. node scripts/bench-ocu.mjs 4      # 对比效率基线');
  console.log('   4. npm run accept                    # 回归验证');
  process.exit(2);
}

main().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
