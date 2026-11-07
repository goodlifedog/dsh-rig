'use strict';
/**
 * 扫描本机安装的应用（供清点与探测共用），以及"按名字找应用"。
 *
 * 抽出来是为了两件事别各写一份：清点脚本要扫描，探测脚本按名字找 bundle/进程名也要扫描。
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { normalizeName } from './app-inventory.mjs';

const exec = promisify(execFile);

/** 读一个 .app 的 bundle id / 可执行名 / 显示名 */
export async function readBundleInfo(appPath, deps = {}) {
  const run = deps.exec || exec;
  const plist = path.join(appPath, 'Contents', 'Info.plist');
  const read = async (key) => {
    try {
      const { stdout } = await run('/usr/libexec/PlistBuddy', ['-c', 'Print :' + key, plist], { timeout: 4000 });
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

/**
 * 扫描若干目录里的 .app。
 * @param {string[]} dirs
 * @param {{readdir?:Function, readInfo?:Function}} [deps]
 * @returns {Promise<Array<{name:string, bundle:string, process:string, appPath:string}>>}
 */
export async function scanDirs(dirs, deps = {}) {
  const readdir = deps.readdir || ((dir) => fs.promises.readdir(dir, { withFileTypes: true }));
  const readInfo = deps.readInfo || readBundleInfo;
  const out = [];
  for (const dir of dirs || []) {
    let entries = [];
    try {
      entries = await readdir(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const isDir = entry && typeof entry.isDirectory === 'function' ? entry.isDirectory() : false;
      const name = entry && entry.name ? entry.name : '';
      if (!isDir || !name.endsWith('.app')) continue;
      const appPath = path.join(dir, name);
      const info = await readInfo(appPath);
      if (!info || !info.bundle) continue;
      out.push({
        name: info.display || name.replace(/\.app$/, ''),
        bundle: info.bundle,
        process: info.exe || '',
        appPath,
      });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * 按名字/bundle/可执行名从已安装清单里挑应用（纯函数）。
 * 名字匹配用归一化后的包含关系，方便「QQ」「抖音」这类带后缀的显示名。
 *
 * @param {Array<{name:string, bundle:string, process:string}>} installed
 * @param {string[]} names
 * @returns {{matched:Array<object>, missing:string[]}}
 */
export function matchAppByNames(installed, names) {
  const list = installed || [];
  const matched = [];
  const missing = [];
  const used = new Set();
  for (const raw of names || []) {
    const want = normalizeName(raw);
    if (!want) continue;
    const hit = list.find((app) => {
      if (!app || used.has(app.bundle)) return false;
      const candidates = [normalizeName(app.name), String(app.bundle || '').toLowerCase(), normalizeName(app.process)];
      return candidates.some((c) => c && (c === want || c.includes(want)));
    });
    if (hit) {
      matched.push(hit);
      used.add(hit.bundle);
    } else {
      missing.push(raw);
    }
  }
  return { matched, missing };
}
