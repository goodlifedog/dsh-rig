'use strict';
// 跨平台启动小窗：清掉 ELECTRON_RUN_AS_NODE 后再起 electron。
// 原来用 `env -u`（POSIX 专用），Windows 上跑不了。
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

let electronPath;
try {
  electronPath = require('electron');
} catch (e) {
  console.error('没装 electron，请先在 overlay 目录执行 npm install');
  process.exit(1);
}

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electronPath, ['.'], { cwd: __dirname, env, stdio: 'inherit' });
child.on('exit', (code) => process.exit(code === null ? 1 : code));
