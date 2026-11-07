#!/usr/bin/env node
/**
 * CDP 通道端到端验证：自己起一个 Chromium 实例，验证"读页面 / 按文字点 / 往输入框写"这三件事。
 *
 *   node core/tasks/cdp-channel.mjs
 *
 * 用 headless + 独立 profile，不碰用户正在用的 Chrome，也不影响前台。
 */
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchWithDebug, attachPage, readPage, clickText, typeInto } from '../cdp-driver.mjs';

const exec = promisify(execFile);
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9411;

const PAGE = 'data:text/html;charset=utf-8,' + encodeURIComponent(`<!doctype html>
<html><head><title>CDP 通道测试页</title></head>
<body>
  <h1>通道验证</h1>
  <input id="name" placeholder="姓名" aria-label="姓名">
  <button id="submit">提交</button>
  <div id="out">未点击</div>
  <script>
    document.getElementById('submit').addEventListener('click', function () {
      document.getElementById('out').textContent = '已点击:' + (document.getElementById('name').value || '空');
    });
  </script>
</body></html>`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-channel-'));
  let chrome = null;
  const results = [];
  const add = (name, ok, detail) => {
    results.push({ name, ok, detail });
    console.log((ok ? 'PASS' : 'FAIL') + ' ' + name + (detail ? '：' + detail : ''));
  };

  try {
    chrome = spawn(CHROME, [
      '--headless=new',
      '--remote-debugging-port=' + PORT,
      '--user-data-dir=' + profile,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      'about:blank',
    ], { stdio: 'ignore' });

    let up = null;
    for (let i = 0; i < 40; i += 1) {
      up = await attachPage({ port: PORT, timeoutMs: 800, expectedPid: chrome.pid });
      if (up.ok) break;
      await sleep(250);
    }
    add('连上调试端口并找到页面', Boolean(up && up.ok), up && up.ok ? '' : (up && up.error) || '');

    if (up && up.ok) {
      const cdp = up.cdp;
      try {
        await cdp.send('Page.enable');
        await cdp.send('Page.navigate', { url: PAGE });
        await sleep(600);
        const page = await readPage(cdp, { timeoutMs: 5000 });
        add('读页面标题与正文', page.title.includes('CDP 通道测试页') && page.text.includes('通道验证'),
          'title=' + page.title + ' textLen=' + page.text.length);

        const typed = await typeInto(cdp, { selector: '#name', text: '后台写入' });
        add('往输入框写文字', Boolean(typed.typed), 'verified=' + String(typed.verified || '').slice(0, 20));

        const clicked = await clickText(cdp, '提交');
        await sleep(300);
        const out = await cdp.evaluate('document.getElementById("out").textContent');
        add('按文字点按钮', Boolean(clicked.clicked) && String(out).includes('已点击'),
          'matched=' + clicked.matched + ' out=' + String(out));
      } catch (e) {
        add('CDP 操作', false, String(e && e.message || e).slice(0, 120));
      } finally {
        try { cdp.close(); } catch {}
      }
    }
  } finally {
    if (chrome) {
      try { chrome.kill('SIGTERM'); } catch {}
      await sleep(400);
      try { chrome.kill('SIGKILL'); } catch {}
    }
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
  }

  const failed = results.filter((r) => !r.ok);
  console.log('\n' + (failed.length ? '失败 ' + failed.length + ' 项' : '全部通过') + '（' + results.length + ' 项）');
  if (failed.length) process.exitCode = 1;
}

main().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
