'use strict';
/**
 * 应用包画像采集：只看包结构（不启动应用），收集判断运行时要用的证据。
 *
 * 供给两处使用：`npm run app:runtime`（看单个/全部应用归到哪族）和
 * `npm run app:resolve`（协商现在能用哪条通道）。抽出来避免两边各写一份。
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { classifyRuntime, countSdefCommands } from './app-runtime.mjs';

const exec = promisify(execFile);

/** Contents/Frameworks 下的框架/库名 */
export async function listFrameworks(appPath, deps = {}) {
  const readdir = deps.readdir || ((dir) => fs.promises.readdir(dir, { withFileTypes: true }));
  try {
    const entries = await readdir(path.join(appPath, 'Contents', 'Frameworks'));
    return entries.map((e) => (typeof e === 'string' ? e : e.name)).filter(Boolean);
  } catch {
    return [];
  }
}

/** 主二进制链接的系统框架（otool -L），拿不到就返回空 */
export async function linkedFrameworks(appPath, deps = {}) {
  const run = deps.exec || exec;
  const readInfo = deps.readInfo || (async (p) => {
    try {
      const { stdout } = await run('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleExecutable', path.join(p, 'Contents', 'Info.plist')], { timeout: 4000 });
      return { exe: String(stdout).trim() };
    } catch {
      return { exe: '' };
    }
  });
  const info = await readInfo(appPath);
  if (!info || !info.exe) return [];
  try {
    const { stdout } = await run('/usr/bin/otool', ['-L', path.join(appPath, 'Contents', 'MacOS', info.exe)], { timeout: 8000 });
    return String(stdout).split('\n').map((l) => l.trim().split(' (')[0]).filter(Boolean).slice(1);
  } catch {
    return [];
  }
}

/**
 * 找 Chromium 系自带的渲染进程 Helper（Renderer）。
 *
 * 为什么要单独找：Chrome / Edge 这类把 Helper 放在
 *   Contents/Frameworks/<厂商> Framework.framework/Versions/<版本>/Helpers/
 * 里，顶层 Frameworks 只有框架名——只扫一层就会把 Chrome 误判成原生应用（实测踩过：
 * npm run app:runtime --all 里 Google Chrome 显示 native）。
 * Helper (Renderer) 是 Chromium 多进程架构独有的产物，出现它就说明这一族能走 CDP。
 *
 * @param {string} appPath /Applications/X.app
 * @param {{exec?:Function}} [deps]
 * @returns {Promise<string[]>} 命中的相对/绝对路径（最多 8 条，够判定了）
 */
export async function listRendererHelpers(appPath, deps = {}) {
  const run = deps.exec || exec;
  try {
    const { stdout } = await run('/usr/bin/find', [
      path.join(appPath, 'Contents', 'Frameworks'),
      '-maxdepth', '6',
      '-name', '*Helper (Renderer).app',
    ], { timeout: 8000 });
    return String(stdout).split('\n').map((line) => line.trim()).filter(Boolean).slice(0, 8);
  } catch {
    return [];
  }
}

export async function hasAsar(appPath, deps = {}) {
  const access = deps.access || ((p) => fs.promises.access(p));
  try {
    await access(path.join(appPath, 'Contents', 'Resources', 'app.asar'));
    return true;
  } catch {
    return false;
  }
}

export async function hasJvm(appPath, deps = {}) {
  const readdir = deps.readdirRecursive || ((dir) => fs.promises.readdir(dir, { recursive: true, maxDepth: 3 }));
  for (const rel of ['Contents/PlugIns', 'Contents/Java', 'Contents/Resources']) {
    try {
      const entries = await readdir(path.join(appPath, rel));
      if (entries.some((e) => /libjvm|jdk|jre/i.test(String(e)))) return true;
    } catch {}
  }
  return false;
}

/** 读包内 .sdef 字典，统计命令数 */
export async function sdefInfo(appPath, deps = {}) {
  const readdir = deps.readdirNames || ((dir) => fs.promises.readdir(dir));
  const readFile = deps.readFile || ((p) => fs.promises.readFile(p, 'utf8'));
  try {
    const resDir = path.join(appPath, 'Contents', 'Resources');
    const files = (await readdir(resDir)).filter((f) => /\.sdef$/i.test(String(f)));
    let commands = 0;
    for (const f of files) {
      try {
        commands += countSdefCommands(await readFile(path.join(resDir, f)));
      } catch {}
    }
    return { available: commands > 0, commands, files: files.length };
  } catch {
    return { available: false, commands: 0, files: 0 };
  }
}

/**
 * 采集完整画像。
 * @param {string} appPath /Applications/X.app
 * @param {object} [deps] 注入用（测试时替换 fs/exec）
 * @returns {Promise<{type:string, evidence:string[], frameworks:string[], links:string[], applescript:{available:boolean,commands:number}, hasAsar:boolean}>}
 */
export async function profileApp(appPath, deps = {}) {
  const [frameworks, links, helpers, asar, jvm, sdef] = await Promise.all([
    listFrameworks(appPath, deps),
    linkedFrameworks(appPath, deps),
    listRendererHelpers(appPath, deps),
    hasAsar(appPath, deps),
    hasJvm(appPath, deps),
    sdefInfo(appPath, deps),
  ]);
  // Helper (Renderer) 的路径要一起送进分类器：Chrome 这类把它埋在框架内部
  const runtime = classifyRuntime([...frameworks, ...links, ...helpers], { hasAsar: asar, hasJvmRuntime: jvm });
  return {
    type: runtime.type,
    evidence: runtime.evidence,
    frameworks,
    links,
    hasAsar,
    applescript: sdef,
  };
}
