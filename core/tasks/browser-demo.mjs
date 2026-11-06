'use strict';

/**
 * 专用浏览器自证：离屏 Chrome 实例 + CDP，全程不碰用户窗口。
 *
 * 验证：
 *   1. 能启动独立实例（独立 user-data-dir、屏幕外、随机调试端口）
 *   2. 能通过 CDP 导航到本地页面、读 title、读 DOM
 *   3. 能点击、能写输入框
 *   4. 用户前台应用全程不变
 */

import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { launch } from '../browser.mjs';
import { frontmostApp } from '../electron-task.mjs';

const TITLE = 'Agent Browser Demo';
const TYPE_MARKER = 'AGENT-BROWSER-9527';
const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok });
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + '  ' + (detail === undefined ? '' : JSON.stringify(detail)));
};

const HTML = [
  '<!doctype html><html><head><meta charset="utf-8"><title>' + TITLE + '</title></head><body>',
  '<h1 id="h">专用浏览器自证页</h1>',
  '<button id="btn">加一</button><span id="count">0</span>',
  '<input id="name" value="原名">',
  '<div id="out"></div>',
  '<script>',
  'var n=0;',
  'document.getElementById("btn").addEventListener("click",function(e){n++;count.textContent=n;out.textContent="点击"+n+" trusted="+e.isTrusted;});',
  '</script></body></html>',
].join('\n');

const evalExpr = async (cdp, expression) => {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r && r.exceptionDetails) throw new Error('JS 异常: ' + JSON.stringify(r.exceptionDetails).slice(0, 300));
  return r && r.result ? r.result.value : undefined;
};

async function main() {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'agent-browser-'));
  const pagePath = path.join(tmp, 'demo.html');
  await fsp.writeFile(pagePath, HTML);
  const url = 'file://' + pagePath;

  const before = await frontmostApp();
  console.log('[1] 初始前台:', before);

  const profile = path.join(tmp, 'profile');
  let browser;
  try {
    console.log('[2] 启动离屏 Chrome（独立 profile + 随机端口）…');
    browser = await launch({ userDataDir: profile, port: 0, timeoutMs: 45000 });
    console.log('    端口:', browser.port, 'pid:', browser.pid, 'profile:', browser.userDataDir);

    const cdp = await browser.connect({ timeoutMs: 30000 });
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    console.log('[3] 导航到本地页面…');
    await cdp.send('Page.navigate', { url });
    await new Promise((r) => setTimeout(r, 800));

    const title = await evalExpr(cdp, 'document.title');
    check('读到页面 title', title === TITLE, title);

    const nodes = await evalExpr(cdp, 'document.querySelectorAll("*").length');
    check('能读 DOM 节点', Number(nodes) > 5, nodes);

    console.log('[4] 点击按钮…');
    const click = await cdp.send('Runtime.evaluate', {
      expression: 'var b=document.getElementById("btn"); var r=b.getBoundingClientRect(); ({x:r.x+r.width/2, y:r.y+r.height/2})',
      returnByValue: true,
    });
    const pt = click.result.value;
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1 });
    const count = await evalExpr(cdp, 'document.getElementById("count").textContent');
    check('点击后计数变为 1', count === '1', count);

    console.log('[5] 填输入框…');
    await evalExpr(cdp, 'var el=document.getElementById("name"); el.focus(); el.select();');
    await cdp.send('Input.insertText', { text: TYPE_MARKER });
    const value = await evalExpr(cdp, 'document.getElementById("name").value');
    check('输入框写入并读回', value === TYPE_MARKER, value);

    const during = await frontmostApp();
    console.log('[6] 运行中前台:', during);
    // 断言的是「自动化浏览器没有占住前台」，而不是「前台一字不差」
    check('自动化浏览器未占据前台', during !== 'Google Chrome' || during === before, { before, during });
  } finally {
    try { if (browser) await browser.close(); } catch {}
    await new Promise((r) => setTimeout(r, 1200));
    const after = await frontmostApp();
    console.log('[7] 结束后前台:', after);
    check('结束后前台未变', after === before, after);
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }

  const passed = results.filter((r) => r.ok).length;
  console.log('\n结果: ' + passed + '/' + results.length);
  console.log(JSON.stringify({ verdict: passed === results.length ? 'ALL PASS' : 'FAIL', passed, total: results.length }, null, 2));
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
