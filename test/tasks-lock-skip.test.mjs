'use strict';
// 锁屏时所有 AX/画面类任务必须「环境跳过 + 正常退出」，不能挂住、不能报 FAIL。
// 真锁屏环境不可控（而且会跳过整个测试），用 AGENT_FAKE_LOCKED=1 强制判锁来验这条路径。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const TASKS = [
  'electron-demo',
  'form-fill-local',
  'form-fill',
  'parallel-real-demo',
  'user-chrome-demo',
  'human-demo',
  'multi-app',
];

function runTask(name) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'core', 'tasks', name + '.mjs')], {
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

for (const name of TASKS) {
  test(name + '：锁屏时环境跳过且退出码 0', async () => {
    const r = await runTask(name);
    assert.equal(r.code, 0, name + ' 锁屏时应 exit 0，实际 ' + r.code + '；输出：' + r.out.slice(-200));
    assert.match(r.out, /环境跳过|锁屏/, name + ' 应明确说环境跳过；输出：' + r.out.slice(-200));
    assert.doesNotMatch(r.out, /FAIL|❌/, name + ' 锁屏时不该出现失败标记；输出：' + r.out.slice(-200));
  });
}
