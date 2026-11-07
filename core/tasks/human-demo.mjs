import { isScreenLocked, lockedSkipNotice } from '../platform.mjs';
'use strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { launch } from '../browser.mjs';
import { HumanMouse, centerOf } from '../human.mjs';
import { frontmostApp } from '../electron-task.mjs';

const HTML = [
  '<!doctype html><html><head><meta charset="utf-8"><title>Human Demo</title>',
  '<style>body{font:15px -apple-system;padding:40px}button{padding:8px 18px;font-size:15px}input{padding:6px;width:240px;margin-top:20px}</style></head><body>',
  '<h1>拟人输入自证</h1><button id="btn">点我</button><div id="out">未点击</div>',
  '<input id="txt" placeholder="输入框">',
  '<script>window.__ev=[];document.getElementById("btn").addEventListener("mousemove",function(e){window.__ev.push({t:"move",x:e.clientX,y:e.clientY,trusted:e.isTrusted})});document.getElementById("btn").addEventListener("click",function(e){document.getElementById("out").textContent="已点击 trusted="+e.isTrusted;});</script>',
  '</body></html>',
].join('\n');

const results = [];
const check = (n, ok, d) => { results.push({ n, ok }); console.log((ok ? '  PASS  ' : '  FAIL  ') + n + '  ' + (d === undefined ? '' : JSON.stringify(d))); };

// 拟人输入需要真实指针/屏幕，锁屏下没法验证，按环境跳过
if (await isScreenLocked()) {
  console.log(lockedSkipNotice('human-demo.mjs'));
  process.exit(0);
}

const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'human-demo-'));
const file = path.join(tmp, 'demo.html');
await fsp.writeFile(file, HTML);

const before = await frontmostApp();
let b;
try {
  b = await launch({ userDataDir: path.join(tmp, 'profile'), headless: false, timeoutMs: 60000 });
  const p = await b.connect({ timeoutMs: 30000 });
  await p.send('Page.enable');
  await p.send('Page.navigate', { url: 'file://' + file });
  await new Promise(r => setTimeout(r, 800));

  const mouse = new HumanMouse(p);
  const btn = await centerOf(p, '#btn');
  console.log('按钮位置:', JSON.stringify(btn));
  const clickInfo = await mouse.click(btn);
  await new Promise(r => setTimeout(r, 400));

  const out = await p.send('Runtime.evaluate', { expression: 'document.getElementById("out").textContent', returnByValue: true });
  check('点击生效', /已点击/.test(out.result.value), out.result.value);

  const evs = await p.send('Runtime.evaluate', { expression: 'JSON.stringify({n:window.__ev.length, trusted:window.__ev.every(e=>e.trusted)})', returnByValue: true });
  const ev = JSON.parse(evs.result.value);
  check('产生了鼠标移动事件', ev.n > 5, ev);
  check('事件都是可信的', ev.trusted === true, ev);

  const txt = await centerOf(p, '#txt');
  await mouse.click(txt);
  await mouse.type('Hello 拟人输入');
  const val = await p.send('Runtime.evaluate', { expression: 'document.getElementById("txt").value', returnByValue: true });
  check('拟人打字写入成功', val.result.value === 'Hello 拟人输入', val.result.value);

  const during = await frontmostApp();
  check('全程前台未变', during === before, { before, during });
} finally {
  if (b) await b.close().catch(() => {});
  await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
}

const passed = results.filter(r => r.ok).length;
console.log('\n结果: ' + passed + '/' + results.length, JSON.stringify({ moves: true }));
process.exit(passed === results.length ? 0 : 1);
