'use strict';
/**
 * Electron 可执行文件的统一解析。
 *
 * 背景：发布包里不含 overlay/node_modules（打包时排除），所以全局安装后
 * `overlay/node_modules/electron` 不存在；electron 作为本包的 dependencies 安装，
 * 二进制落在 <包>/node_modules/electron/dist/...。
 *
 * 解析顺序：
 *   1) overlay/package.json 所在目录（仓库开发态：overlay 自己装了 electron）
 *   2) 包根目录（全局/普通安装：electron 是 dependencies）
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..');

/** 依次用于 require('electron') 的基准路径（纯函数，便于单测） */
export function electronRequireBases(rootDir = ROOT) {
  return [
    path.join(rootDir, 'overlay', 'package.json'),
    path.join(rootDir, 'package.json'),
  ];
}

/** 没装 Electron 时的中文提示（两处调用共用，避免各写一套） */
export function electronInstallHint() {
  return [
    '没装 Electron（小窗需要它）。',
    '  普通安装：重新执行 npm i -g dsh-rig（Electron 已作为依赖自动安装）；',
    '  仓库开发：在仓库根目录执行 npm install，或在 overlay 目录执行 npm install。',
  ].join('\n');
}

/**
 * 解析 Electron 可执行文件路径。
 * @param {{rootDir?:string, requireResolve?:Function, fileExists?:Function}} [options]
 * @returns {{path:string, from:string, tried:string[]}}
 */
export function resolveElectronBinary(options = {}) {
  const opts = options || {};
  const rootDir = opts.rootDir || ROOT;
  const bases = electronRequireBases(rootDir);
  const tried = [];
  for (const base of bases) {
    let req;
    try {
      req = opts.requireResolve ? createRequireFrom(opts.requireResolve, base) : createRequire(base);
    } catch {
      tried.push(base);
      continue;
    }
    try {
      const resolved = req('electron');
      if (typeof resolved === 'string' && resolved) return { path: resolved, from: base, tried };
    } catch {}
    tried.push(base);
  }
  return { path: '', from: '', tried };
}

function createRequireFrom(requireResolve, base) {
  const req = (id) => requireResolve(id, { paths: [path.dirname(base)] });
  return req;
}
