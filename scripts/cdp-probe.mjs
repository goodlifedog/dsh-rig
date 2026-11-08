'use strict';

/**
 * CDP 兜底路径的验收脚本（在受控的 overlay 上跑）。
 *
 * 前置：overlay 必须先带调试端口启动：
 *   cd desktop-agent/overlay
 *   env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron . --remote-debugging-port=9333
 *
 * 运行：
 *   node desktop-agent/flow/cdp-probe.mjs            # 默认 port=9333
 *   node desktop-agent/flow/cdp-probe.mjs 9334       # 指定端口
 *
 * 检查项：
 *   1. HTTP /json/version + /json/list 能拿到 target；
 *   2. WebSocket 连上后能 evaluate（document.title）；
 *   3. 能读 DOM（节点数、可交互元素、可见文本）；
 *   4. 能改 DOM 并读回（证明 JS 执行有副作用，不只是只读）；
 *   5. Input.dispatchMouseEvent 能触发真实点击（事件 isTrusted=true，DOM 状态随之变化）；
 *   6. Input.insertText 能往输入框里打真实文本；
 *   7. Page.captureScreenshot 能拿到画面。
 *
 * 任何一项失败都会打印 FAIL 并以非零退出码结束。
 */

import { CDP, getVersion, listTargets } from '../core/cdp.mjs';

const PORT = Number(process.argv[2] || process.env.CDP_PORT || 9333);
const HOST = '127.0.0.1';

const results = [];
function check(name, ok, detail) {
  results.push({ name: name, ok: Boolean(ok), detail: detail });
  const tag = ok ? 'PASS' : 'FAIL';
  console.log(tag + '  ' + name + (detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''));
}

function summarize() {
  const failed = results.filter((r) => !r.ok);
  console.log('');
  console.log(JSON.stringify({
    port: PORT,
    total: results.length,
    passed: results.length - failed.length,
    failed: failed.map((r) => r.name),
    verdict: failed.length === 0 ? 'ALL PASS' : 'HAS FAILURE',
  }, null, 2));
  return failed.length === 0;
}

async function main() {
  // 1. HTTP 侧
  const version = await getVersion({ host: HOST, port: PORT });
  check('GET /json/version 返回 Browser', Boolean(version.Browser), version.Browser);

  const targets = await listTargets({ host: HOST, port: PORT });
  const pageTargets = targets.filter((t) => t.type === 'page');
  check('GET /json/list 有 page target', pageTargets.length > 0,
    pageTargets.map((t) => ({ title: t.title, url: t.url })));

  // 2. WebSocket + evaluate
  const cdp = await CDP.attach({ host: HOST, port: PORT, target: 'Desktop Agent' });
  try {
    const title = await cdp.getTitle();
    check('Runtime.evaluate 返回 document.title', title === 'Desktop Agent', title);

    // 3. 读 DOM
    const dom = await cdp.inspectDom();
    check('能读 DOM 节点数', dom.nodes > 0, { nodes: dom.nodes, interactive: dom.interactive, readyState: dom.readyState });
    check('能读到可交互元素', dom.interactive >= 2, dom.interactiveSample.map((e) => e.tag + '#' + (e.id || '')).slice(0, 5));

    // 4. 写 DOM 并读回（副作用证据）
    const marker = 'cdp-probe-' + Date.now();
    const written = await cdp.evaluate('(window.__cdpProbe = ' + JSON.stringify(marker) + ', document.documentElement.getAttribute("data-cdp-probe"));');
    await cdp.evaluate('document.documentElement.setAttribute("data-cdp-probe", ' + JSON.stringify(marker) + ')');
    const readBack = await cdp.evaluate('document.documentElement.getAttribute("data-cdp-probe")');
    check('写 DOM 属性后能读回', readBack === marker && written === null, { marker: marker, readBack: readBack });

    // 5. 真实点击：先装监听记录 isTrusted，再 Input 点击，最后验证 DOM 变化
    const beforeOpen = await cdp.evaluate('document.getElementById("logs").classList.contains("open")');
    await cdp.evaluate([
      '(function () {',
      '  window.__cdpClick = { count: 0, trusted: [], target: null };',
      '  document.getElementById("pill").addEventListener("click", function (e) {',
      '    window.__cdpClick.count += 1;',
      '    window.__cdpClick.trusted.push(e.isTrusted);',
      '    window.__cdpClick.target = e.target.id || e.target.tagName;',
      '  }, { once: true });',
      '})()',
    ].join('\n'));

    const clickInfo = await cdp.clickSelector('#pill');
    await new Promise((resolve) => setTimeout(resolve, 300));
    const clickState = await cdp.evaluate('window.__cdpClick');
    const afterOpen = await cdp.evaluate('document.getElementById("logs").classList.contains("open")');
    check('Input.dispatchMouseEvent 点到 #pill', clickState && clickState.count === 1,
      { point: clickInfo.point, fired: clickState && clickState.count });
    check('点击事件 isTrusted=true（真实输入管线）', Boolean(clickState && clickState.trusted[0] === true),
      clickState && clickState.trusted);
    check('点击后 DOM 状态改变（日志抽屉 open）', beforeOpen !== afterOpen,
      { beforeOpen: beforeOpen, afterOpen: afterOpen });

    // 再点一次复原，避免留下展开状态
    await cdp.clickSelector('#pill');
    const restoredOpen = await cdp.evaluate('document.getElementById("logs").classList.contains("open")');
    check('再次点击可还原（开->关）', restoredOpen === beforeOpen, { restoredOpen: restoredOpen });

    // 6. 键盘输入：临时插一个输入框，Input.insertText 打进去
    await cdp.evaluate([
      '(function () {',
      '  var el = document.createElement("input");',
      '  el.id = "__cdp_input";',
      '  el.style.cssText = "position:fixed;left:0;top:0;width:120px;height:24px;z-index:9999";',
      '  document.body.appendChild(el);',
      '  el.focus();',
      '})()',
    ].join('\n'));
    await cdp.insertText('hello-cdp');
    const typed = await cdp.evaluate('document.getElementById("__cdp_input").value');
    check('Input.insertText 输入文本', typed === 'hello-cdp', typed);
    await cdp.evaluate('(function () { var el = document.getElementById("__cdp_input"); if (el) el.remove(); })()');

    // 7. 截图
    const shot = await cdp.screenshot('/tmp/cdp-probe-shot.png');
    check('Page.captureScreenshot 拿到 PNG', shot.length > 1000, { bytes: shot.length, path: '/tmp/cdp-probe-shot.png' });

    check('本次会话 CDP 消息数 > 10', cdp.protocolMessages > 10, cdp.protocolMessages);
  } finally {
    cdp.close();
  }

  const ok = summarize();
  process.exit(ok ? 0 : 1);
}

main().catch((error) => {
  console.error('[cdp-probe] ' + (error && error.stack ? error.stack : error));
  process.exit(1);
});
