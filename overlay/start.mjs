'use strict';
// 跨平台启动小窗：清掉 ELECTRON_RUN_AS_NODE 后再起 electron。
// 原来用 `env -u`（POSIX 专用），Windows 上跑不了。
import { spawn } from 'node:child_process';
import { resolveElectronBinary, electronInstallHint } from '../core/electron-bin.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Electron 可能在 overlay/node_modules（开发态），也可能在包根 node_modules（全局安装的依赖）
const resolved = resolveElectronBinary();
if (!resolved.path) {
  console.error(electronInstallHint());
  process.exit(1);
}
const electronPath = resolved.path;

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electronPath, ['.'], { cwd: __dirname, env, stdio: 'inherit' });
child.on('exit', (code) => process.exit(code === null ? 1 : code));
