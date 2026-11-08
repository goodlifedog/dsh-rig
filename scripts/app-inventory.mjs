#!/usr/bin/env node
/**
 * 本机应用适配清点：扫描 /Applications，对照预设和最近一次矩阵报告，输出报告。
 *
 *   node scripts/app-inventory.mjs
 *   npm run apps:inventory
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PRESETS, presetNames, SPECIAL_APP_HANDLING } from '../core/app-presets.mjs';
import { flattenPresets, mergeInventory, renderInventoryMarkdown, normalizeName, nextProbeCommands } from '../core/app-inventory.mjs';
import { scanDirs, scanShortcutStubs, readBundleInfo, userAppDirs, SYSTEM_APP_DIRS, FINDER_APP_PATH } from '../core/app-scan.mjs';
import { profileApp } from '../core/app-profile.mjs';

/**
 * 给每个已安装应用补运行时族（只看包结构，不启动应用）。
 * 有了它，「界面树读不到的 electron 应用」才能被正确归类成「专用方案（CDP）」而不是「限制」。
 * 想跳过这步（老机器上很慢时）：APP_INVENTORY_RUNTIME=0。
 */
async function withRuntime(apps) {
  if (process.env.APP_INVENTORY_RUNTIME === '0') return apps;
  const out = [];
  for (const app of apps) {
    let runtime = '';
    try {
      const profile = await profileApp(app.appPath);
      runtime = profile.type;
    } catch {}
    out.push(Object.assign({}, app, { runtime }));
  }
  return out;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
// /Applications、/Applications/Utilities 与 ~/Applications（Homebrew/Steam 快捷方式会装这儿）
const USER_DIRS = userAppDirs();
// 系统应用只取预设里提到的那几个（Finder 在 CoreServices 里，单独补），否则报告会被几十个系统小工具淹掉
const SYSTEM_DIRS = SYSTEM_APP_DIRS;
const FINDER_PATH = FINDER_APP_PATH;

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

/**
 * 合并全部 CDP 通道验证报告（reports/cdp-driver-*.json，从旧到新，同一 bundle 以最近一次为准）。
 * 作用：把「electron 族但调试端口根本起不来」的应用如实标成限制，而不是标成听起来能用的专用方案。
 */
function cdpHistory() {
  const dir = path.join(ROOT, 'reports');
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => /^cdp-driver-.*\.json$/.test(f)).sort();
  } catch {
    return {};
  }
  const map = {};
  for (const name of files) {
    let data = null;
    try {
      data = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
    } catch {
      continue;
    }
    for (const row of data.rows || []) {
      if (!row || !row.bundle) continue;
      map[row.bundle] = { status: String(row.status || ''), detail: String(row.detail || ''), report: 'reports/' + name };
    }
  }
  return map;
}

async function main() {
  const presetApps = flattenPresets(PRESETS);
  const presetBundles = new Set(presetApps.map((a) => a.bundle));
  const presetNameKeys = new Set(presetApps.map((a) => normalizeName(a.name)));
  const userApps = await scanDirs(USER_DIRS);
  const sysApps = (await scanDirs(SYSTEM_DIRS)).filter(
    (a) => presetBundles.has(a.bundle) || presetNameKeys.has(normalizeName(a.name)),
  );
  const finderInfo = await readBundleInfo(FINDER_PATH);
  const finder = finderInfo.bundle
    ? { name: finderInfo.display || 'Finder', bundle: finderInfo.bundle, process: finderInfo.exe || 'Finder' }
    : null;
  const installed = await withRuntime([...userApps, ...sysApps, ...(finder ? [finder] : [])]);
  const matrix = matrixHistory();
  const rows = mergeInventory({
    installed,
    presetApps,
    tested: matrix ? matrix.rows : [],
    special: SPECIAL_APP_HANDLING,
    cdpByBundle: cdpHistory(),
  });
  // 快捷方式壳（Steam 游戏启动器这类）：不进接管统计，但要在报告里点名，避免"合计"对不上
  const stubs = await scanShortcutStubs([path.join(os.homedir(), 'Applications')]);
  const now = new Date();
  const markdown = renderInventoryMarkdown(rows, {
    now,
    matrixReport: matrix ? 'reports/app-matrix-*.json（合并全部历史）' : '还没有矩阵报告',
    shortcutStubs: stubs.map((s) => s.name + '（' + s.exe + '）'),
  });
  const dir = path.join(ROOT, 'reports');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const outFile = path.join(dir, 'app-inventory-' + stamp + '.md');
  fs.writeFileSync(outFile, markdown);

  const counts = rows.reduce((acc, r) => { acc[r.status] = (acc[r.status] || 0) + 1; return acc; }, {});
  console.log('扫描到 ' + installed.length + ' 个应用' + (stubs.length ? '（另有 ' + stubs.length + ' 个快捷方式壳未计入：' + stubs.map((s) => s.name).join('、') + '）' : '') + '，预设门类：' + presetNames().join('/'));
  console.log('状态汇总: ' + JSON.stringify(counts));
  console.log('报告: reports/app-inventory-' + stamp + '.md');
  const next = nextProbeCommands(rows);
  if (next.length) console.log('下一步补测: ' + next[0]);
}

main().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });