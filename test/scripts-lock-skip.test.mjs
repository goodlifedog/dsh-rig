'use strict';
// 可视化检查脚本在锁屏时必须环境跳过：锁屏下小窗按设计隐藏，断言/截图/帧率都没有意义。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPTS = ['ui-regression.mjs', 'ui-check.mjs', 'fps-check.mjs'];

function runScript(name) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'scripts', name)], {
      cwd: ROOT,
      env: { ...process.env, AGENT_FAKE_LOCKED: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 20000);
    child.stdout.on('data', (b) => { out += b; });
    child.stderr.on('data', (b) => { out += b; });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out }); });
  });
}

for (const name of SCRIPTS) {
  test(name + '：锁屏时环境跳过且退出码 0', async () => {
    const r = await runScript(name);
    assert.equal(r.code, 0, name + ' 锁屏时应 exit 0，实际 ' + r.code + '；输出：' + r.out.slice(-200));
    assert.match(r.out, /环境跳过/, name + ' 应明确说环境跳过；输出：' + r.out.slice(-200));
  });
}
