'use strict';
/**
 * 扫描本机安装的应用（供清点与探测共用），以及"按名字找应用"。
 *
 * 抽出来是为了两件事别各写一份：清点脚本要扫描，探测脚本按名字找 bundle/进程名也要扫描。
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeName } from './app-inventory.mjs';

const exec = promisify(execFile);

/**
 * 用户自己装的应用目录。除了 /Applications，还要看每个用户的 ~/Applications：
 * Homebrew cask、部分国产安装器、Steam 快捷方式会装在这里，只扫 /Applications 会漏掉，
 * 清点报告就会给出「没装/没测」的错误结论。
 * @param {string} [homeDir] 便于测试注入，默认取当前用户 home
 * @returns {string[]}
 */
export function userAppDirs(homeDir) {
  const home = String(homeDir || os.homedir());
  return ['/Applications', '/Applications/Utilities', path.join(home, 'Applications')];
}

/** 系统自带应用目录；默认只取预设里提到的，避免几十个系统小工具淹掉报告 */
export const SYSTEM_APP_DIRS = ['/System/Applications', '/System/Applications/Utilities'];

/** Finder 不在 /Applications 里，单独给路径 */
export const FINDER_APP_PATH = '/System/Library/CoreServices/Finder.app';

/**
 * 全量扫描目录（用户 + 系统 + CoreServices），去重后返回。
 * @param {string} [homeDir]
 * @returns {string[]}
 */
export function allAppDirs(homeDir) {
  return [...new Set([...userAppDirs(homeDir), ...SYSTEM_APP_DIRS, '/System/Library/CoreServices'])];
}

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
      // /Applications/Safari.app 这类是符号链接（指向 Cryptex 里的真包），
      // 只看 isDirectory() 会把它们漏掉，所以符号链接也当候选，靠能不能读出 bundle 兜底。
      const isDir = entry && typeof entry.isDirectory === 'function'
        ? (entry.isDirectory() || (typeof entry.isSymbolicLink === 'function' && entry.isSymbolicLink()))
        : false;
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
 * 扫「快捷方式壳」：~/Applications 里有种 .app 只有 run.sh 启动器、没有 CFBundleIdentifier
 * （Steam 游戏快捷方式、部分国产安装器做的启动器）。它们不是能接管的独立应用，
 * 但清点时得知道它们存在，否则报告里的「合计」会少算，看着像漏扫。
 *
 * @param {string[]} dirs
 * @param {{readdir?:Function, readInfo?:Function}} [deps]
 * @returns {Promise<Array<{name:string, exe:string, appPath:string}>>}
 */
export async function scanShortcutStubs(dirs, deps = {}) {
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
      const name = entry && entry.name ? entry.name : '';
      const looksDir = entry && typeof entry.isDirectory === 'function'
        ? (entry.isDirectory() || (typeof entry.isSymbolicLink === 'function' && entry.isSymbolicLink()))
        : false;
      if (!looksDir || !name.endsWith('.app')) continue;
      const appPath = path.join(dir, name);
      let info = null;
      try {
        info = await readInfo(appPath);
      } catch {
        continue;
      }
      if (info && !info.bundle && info.exe) out.push({ name: name.replace(/\.app$/i, ''), exe: info.exe, appPath });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * 按 bundle id 找已安装应用（纯函数）。
 * @param {Array<{name:string, bundle:string, process:string}>} installed
 * @param {string} bundle
 * @returns {object|null}
 */
export function findByBundle(installed, bundle) {
  const want = String(bundle || '').toLowerCase();
  if (!want) return null;
  return (installed || []).find((app) => app && String(app.bundle || '').toLowerCase() === want) || null;
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
