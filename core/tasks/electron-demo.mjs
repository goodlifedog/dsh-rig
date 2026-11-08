import { isScreenLocked, lockedSkipNotice } from '../platform.mjs';
'use strict';

/**
 * 任务层示例：用「临时 Electron 实例 + CDP」自证读写能力。
 *
 * 做法：
 *   1. 在临时目录写一个最小页面（标题、按钮、计数器、输入框）；
 *   2. 用 electron-task.mjs 生成离屏宿主脚本（accessory + 透明 + 屏幕外，不抢前台）；
 *   3. 带 --remote-debugging-port=0 启动，从 DevToolsActivePort 读真实端口；
 *   4. 连上 CDP：读 document.title → 点按钮看计数器变化 → 往输入框打字并读回；
 *   5. 全程检查前台应用，证明没抢焦点；最后杀进程、清临时目录。
 *
 * 运行：
 *   node core/tasks/electron-demo.mjs
 *
 * 退出码：全部通过 0，否则 1。
 */

import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { launch, writeOffscreenHost, frontmostApp } from '../electron-task.mjs';

const TITLE = 'CDP Task Demo';
const TYPE_MARKER = 'CDP-DEMO-9527';

const DEMO_HTML = [
  '<!doctype html>',
  '<html lang="zh-CN">',
  '<head>',
  '<meta charset="utf-8">',
  '<title>' + TITLE + '</title>',
  '<style>',
  '  body { font: 15px -apple-system, sans-serif; padding: 24px; }',
  '  h1 { font-size: 18px; }',
  '  #row { margin: 14px 0; }',
  '  #name { font-size: 14px; padding: 4px 6px; width: 220px; }',
  '  #count { font-weight: 600; }',
  '</style>',
  '</head>',
  '<body>',
  '  <h1 id="h">CDP 任务层自证页</h1>',
  '  <div id="row">',
  '    <button id="btn" type="button">加一</button>',
  '    <span>计数：</span><span id="count">0</span>',
  '  </div>',
  '  <div id="row2">',
  '    <label>输入框 <input id="name" type="text" value="原名" placeholder="这里会被 CDP 写入"></label>',
  '  </div>',
  '  <div id="out">点击次数：0</div>',
  '<script>',
  '  var n = 0;',
  '  document.getElementById("btn").addEventListener("click", function (event) {',
  '    n += 1;',
  '    document.getElementById("count").textContent = String(n);',
  '    document.getElementById("out").textContent = "点击次数：" + n + "（isTrusted=" + event.isTrusted + "）";',
  '  });',
  '</script>',
  '</body>',
  '</html>',
  '',
].join('\n');

const results = [];
function check(name, ok, detail) {
  results.push({ name: name, ok: Boolean(ok), detail: detail === undefined ? null : detail });
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail === undefined ? '' : '  -> ' + JSON.stringify(detail)));
}

async function main() {
  // 锁屏下 AX/抓图不可用：这是环境限制，不是任务失败（手动跑也不该红）
  if (await isScreenLocked()) {
    console.log(lockedSkipNotice('electron-demo.mjs'));
    return;
  }
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'electron-demo-'));
  const htmlPath = path.join(tempDir, 'demo.html');
  let host = null;
  let page = null;

  const evidence = { tempDir: tempDir, steps: [] };

  const frontBefore = await frontmostApp();
  console.log('[1] 初始前台:', frontBefore || '(unknown)');
  evidence.frontmostBefore = frontBefore;

  try {
    await fsp.writeFile(htmlPath, DEMO_HTML, 'utf8');
    const hostInfo = await writeOffscreenHost({
      htmlPath: htmlPath,
      dir: tempDir,
      width: 420,
      height: 300,
    });
    console.log('[2] 离屏宿主脚本:', hostInfo.hostPath);
    evidence.hostScript = hostInfo.hostPath;

    console.log('[3] 启动 Electron（随机调试端口 + 独立 user-data-dir）…');
    host = await launch({
      entry: hostInfo.hostPath,
      userDataDir: path.join(tempDir, 'userdata'),
      port: 0,
      timeoutMs: 30000,
    });
    console.log('    调试端口:', host.port, 'pid:', host.pid);
    console.log('    DevToolsActivePort:', path.join(host.userDataDir, 'DevToolsActivePort'));
    evidence.port = host.port;
    evidence.pid = host.pid;
    evidence.userDataDir = host.userDataDir;

    page = await host.connect({ target: TITLE, timeoutMs: 20000 });
    console.log('    已连上 target:', JSON.stringify({ title: page.target.title, url: page.target.url }));
    evidence.target = { title: page.target.title, url: page.target.url };

    // ---- 1) 读 document.title ----
    const title = await page.title();
    check('读到 document.title', title === TITLE, title);

    // ---- 2) 读 DOM 概览 ----
    const dom = await page.inspect();
    check('能读 DOM', dom.nodes > 0 && dom.interactive >= 2,
      { nodes: dom.nodes, interactive: dom.interactive, readyState: dom.readyState });

    // ---- 3) 真实点击：点两次按钮，看计数器变化 + isTrusted ----
    await page.evaluate([
      'window.__demoClicks = { count: 0, trusted: [] };',
      'document.getElementById("btn").addEventListener("click", function (event) {',
      '  window.__demoClicks.count += 1;',
      '  window.__demoClicks.trusted.push(event.isTrusted);',
      '});',
    ].join('\n'));

    const clickInfo = await page.click('#btn');
    const firstCount = await page.evaluate('document.getElementById("count").textContent');
    await page.click('#btn');
    const secondCount = await page.evaluate('document.getElementById("count").textContent');
    const clickState = await page.evaluate('window.__demoClicks');

    check('点击 #btn 后计数 0→1', firstCount === '1', { count: firstCount, point: clickInfo.point });
    check('再点一次计数 1→2', secondCount === '2', secondCount);
    check('点击事件 isTrusted=true', Boolean(clickState && clickState.trusted.every((v) => v === true)),
      clickState && clickState.trusted);
    const outText = await page.evaluate('document.getElementById("out").textContent');
    check('DOM 文本随点击变化', String(outText).indexOf('点击次数：2') === 0, outText);

    // ---- 4) 填输入框并读回 ----
    await page.evaluate('document.getElementById("name").focus(); document.getElementById("name").select();');
    await page.insertText(TYPE_MARKER);
    const inputValue = await page.evaluate('document.getElementById("name").value');
    check('输入框写入并读回', inputValue === TYPE_MARKER, inputValue);

    // ---- 5) 截图（顺带证明渲染进程可截图） ----
    const shotPath = path.join(tempDir, 'page.png');
    const shot = await page.screenshot(shotPath);
    check('页面截图成功', shot.length > 1000, { bytes: shot.length, path: shotPath });

    // ---- 6) 前台检查（读值发生在宿主机） ----
    const frontDuring = await frontmostApp();
    evidence.frontmostDuring = frontDuring;
    console.log('[4] 运行中前台:', frontDuring || '(unknown)');
    check('运行中前台不是 Electron 宿主', !/electron/i.test(frontDuring), frontDuring);

    evidence.cdpMessages = page.cdp.protocolMessages;
  } finally {
    if (page) { try { page.close(); } catch {} }
    if (host) {
      const closed = await host.close();
      evidence.closed = closed;
      console.log('[5] 已关闭 Electron:', JSON.stringify(closed));
    }
    await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }

  const frontAfter = await frontmostApp();
  evidence.frontmostAfter = frontAfter;
  check('结束后前台不是 Electron 宿主', !/electron/i.test(frontAfter), frontAfter);

  const failed = results.filter((r) => !r.ok);
  console.log('');
  console.log(JSON.stringify({
    title: TITLE,
    verdict: failed.length === 0 ? 'ALL PASS' : 'HAS FAILURE',
    passed: results.length - failed.length,
    total: results.length,
    failed: failed.map((r) => r.name),
    frontmost: {
      before: evidence.frontmostBefore,
      during: evidence.frontmostDuring,
      after: evidence.frontmostAfter,
    },
    port: evidence.port,
    target: evidence.target,
    cdpMessages: evidence.cdpMessages,
  }, null, 2));

  return failed.length === 0 ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error('FAIL:', error && error.message ? error.message : error);
    process.exit(1);
  });
