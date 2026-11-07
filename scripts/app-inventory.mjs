#!/usr/bin/env node
/**
 * 本机应用适配清点：扫描 /Applications，对照预设和最近一次矩阵报告，输出报告。
 *
 *   node scripts/app-inventory.mjs
 *   npm run apps:inventory
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PRESETS, presetNames, SPECIAL_APP_HANDLING } from '../core/app-presets.mjs';
import { flattenPresets, mergeInventory, renderInventoryMarkdown, normalizeName, nextProbeCommands } from '../core/app-inventory.mjs';

const exec = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const USER_DIRS = ['/Applications', '/Applications/Utilities'];
// 系统应用只取预设里提到的那几个（Finder 在 CoreServices 里，单独补），否则报告会被几十个系统小工具淹掉
const SYSTEM_DIRS = ['/System/Applications', '/System/Applications/Utilities'];
const FINDER_PATH = '/System/Library/CoreServices/Finder.app';

async function bundleInfo(appPath) {
  const plist = path.join(appPath, 'Contents', 'Info.plist');
  const read = async (key) => {
    try {
      const { stdout } = await exec('/usr/libexec/PlistBuddy', ['-c', 'Print :' + key, plist], { timeout: 4000 });
      return String(stdout).trim();
    } catch {
      return '';
    }
  };
  const [bundle, exe, display] = await Promise.all([
    read('CFBundleIdentifier'),
    read('CFBundleExecutable'),
    read('CFBundleDisplayName'),
  ]);
  return { bundle, exe, display };
}

async function scanOne(appPath) {
  const info = await bundleInfo(appPath);
  if (!info.bundle) return null;
  return {
    name: info.display || path.basename(appPath).replace(/\.app$/, ''),
    bundle: info.bundle,
    process: info.exe,
    appPath,
  };
}

async function scanDirs(dirs) {
  const out = [];
  for (const dir of dirs) {
    let entries = [];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.endsWith('.app')) continue;
      const app = await scanOne(path.join(dir, entry.name));
      if (app) out.push(app);
    }
  }
  return out;
}

/**
 * 合并全部历史矩阵报告（按文件时间从旧到新），同一个 bundle 以最近一次为准。
 * 只看最新一份会把前几批测过的应用全标成「未测」。
 */
function matrixHistory() {
  const dir = path.join(ROOT, 'reports');
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => /^app-matrix-.*\.json$/.test(f)).sort();
  } catch {
    return null;
  }
  if (!files.length) return null;
  const byKey = new Map();
  let lastFile = '';
  for (const name of files) {
    let data = null;
    try {
      data = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
    } catch {
      continue;
    }
    const rows = Array.isArray(data.rows) ? data.rows : [];
    for (const row of rows) {
      const key = row.bundle || row.app;
      if (!key) continue;
      byKey.set(key, { ...row, report: 'reports/' + name });
    }
    lastFile = 'reports/' + name;
  }
  return { file: lastFile, rows: Array.from(byKey.values()) };
}

async function main() {
  const presetApps = flattenPresets(PRESETS);
  const presetBundles = new Set(presetApps.map((a) => a.bundle));
  const presetNameKeys = new Set(presetApps.map((a) => normalizeName(a.name)));
  const userApps = await scanDirs(USER_DIRS);
  const sysApps = (await scanDirs(SYSTEM_DIRS)).filter(
    (a) => presetBundles.has(a.bundle) || presetNameKeys.has(normalizeName(a.name)),
  );
  const finder = await scanOne(FINDER_PATH);
  const installed = [...userApps, ...sysApps, ...(finder ? [finder] : [])];
  const matrix = matrixHistory();
  const rows = mergeInventory({
    installed,
    presetApps,
    tested: matrix ? matrix.rows : [],
    special: SPECIAL_APP_HANDLING,
  });
  const now = new Date();
  const markdown = renderInventoryMarkdown(rows, { now, matrixReport: matrix ? 'reports/app-matrix-*.json（合并全部历史）' : '还没有矩阵报告' });
  const dir = path.join(ROOT, 'reports');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const outFile = path.join(dir, 'app-inventory-' + stamp + '.md');
  fs.writeFileSync(outFile, markdown);

  const counts = rows.reduce((acc, r) => { acc[r.status] = (acc[r.status] || 0) + 1; return acc; }, {});
  console.log('扫描到 ' + installed.length + ' 个应用，预设门类：' + presetNames().join('/'));
  console.log('状态汇总: ' + JSON.stringify(counts));
  console.log('报告: reports/app-inventory-' + stamp + '.md');
  const next = nextProbeCommands(rows);
  if (next.length) console.log('下一步补测: ' + next[0]);
}

main().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
