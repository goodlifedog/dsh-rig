'use strict';
/**
 * CDP 驱动通道：给 Electron / Chromium 系应用开一个调试端口，连进去直接操作页面。
 *
 * 为什么这条通道值得做：这类应用的界面是网页，AX 树只能看到"外壳"，页面里的按钮往往拿不到；
 * 而 CDP 能直接读 DOM、按文字点元素、往输入框写内容，不依赖无障碍树，也不需要应用在前台。
 *
 * 前提（和架构文档一致）：应用愿意开放调试端口。不是所有 Electron 应用都允许，
 * 所以 attach 失败就如实返回"通道不可用"，由上层降级到 AX / 画面。
 */
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { CDP, listTargets, getVersion } from './cdp.mjs';
import { parseLsofPid, debugPortTrust } from './safety.mjs';

const exec = promisify(execFile);

/**
 * 给应用分配一个稳定的调试端口（0-59 偏移，落在 9330-9389）。
 * 用 bundle id 做哈希，同一个应用每次端口一致，方便排障；不同应用不撞车。
 * @param {string} key bundle id 或应用名
 * @param {{base?:number, span?:number}} [options]
 * @returns {number}
 */
export function debugPortFor(key, options = {}) {
  const opts = options || {};
  const base = Number.isFinite(opts.base) ? opts.base : 9330;
  const span = Number.isFinite(opts.span) ? opts.span : 60;
  const text = String(key || '');
  const digest = crypto.createHash('sha1').update(text).digest();
  return base + (digest.readUInt32BE(0) % span);
}

/** 启动参数（Chromium 系认这个开关） */
export function buildLaunchArgs(port) {
  return ['--remote-debugging-port=' + port];
}

/**
 * 挑一个"页面"类型的 target，优先 http/https/data 页，避开 devtools 自身。
 * @param {Array<object>} targets /json/list 的返回
 * @param {{match?:RegExp}} [options]
 * @returns {object|null}
 */
/**
 * 给 page target 打分：主界面分高，detached/空白窗口分低。
 * 实测 ChatGPT 会同时开一个 detached-window.html 的空页，先连它就读不到内容。
 */
export function scorePageTarget(target, options = {}) {
  const url = String((target && target.url) || '');
  const title = String((target && target.title) || '');
  let score = 0;
  if (/^https?:/i.test(url)) score += 3;
  else if (/^data:/i.test(url)) score += 2;
  else if (/^file:/i.test(url)) score += 1;
  if (/index\.html/i.test(url)) score += 2;
  if (/detached|devtools|about:blank|extension/i.test(url)) score -= 5;
  if (title && !/^(新标签页|New Tab|about:blank)$/i.test(title)) score += 1;
  const match = options.match;
  if (match && match.test(url + ' ' + title)) score += 10;
  return score;
}

/**
 * 挑一个"页面"类型的 target：优先主界面，避开 detached/devtools 空页。
 * @param {Array<object>} targets /json/list 的返回
 * @param {{match?:RegExp}} [options]
 * @returns {object|null}
 */
export function rankPageTargets(targets, options = {}) {
  const list = (targets || []).filter((t) => t && t.webSocketDebuggerUrl && String(t.type || '') === 'page');
  const scored = list.map((t) => ({ target: t, score: scorePageTarget(t, options) }));
  scored.sort((a, b) => b.score - a.score);
  return scored.map((x) => x.target);
}

export function pickPageTarget(targets, options = {}) {
  return rankPageTargets(targets, options)[0] || null;
}

/**
 * 查某个本地端口是哪个进程在监听（防本地端口劫持：必须先确认主人再连）。
 * @returns {Promise<number>} pid，查不到返回 0
 */
export async function debugPortOwner(port, options = {}) {
  const opts = options || {};
  const run = (opts.deps && opts.deps.exec) || exec;
  try {
    const { stdout } = await run('/usr/sbin/lsof', ['-nP', '-iTCP:' + Number(port), '-sTCP:LISTEN'], { timeout: 4000 });
    return parseLsofPid(stdout);
  } catch {
    return 0;
  }
}

/**
 * 探测某个端口上有没有活的 CDP 服务。
 * @returns {Promise<{ok:boolean, version?:object, error?:string}>}
 */
export async function probeDebugPort(port, options = {}) {
  const opts = options || {};
  const timeout = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : 1200;
  try {
    const version = await getVersion({ port, timeout });
    if (version && version.Browser) return { ok: true, version };
    return { ok: false, error: '端口有响应但不是 CDP 服务' };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e).slice(0, 120) };
  }
}

/**
 * 带调试端口启动应用（open -g，不激活前台），然后等端口起来。
 *
 * 注意：如果应用已经在运行，open 传的 --args 不会生效（macOS 只会激活已有进程）。
 * 所以调用方必须先确认应用没在跑，或者明确接受"重启应用"。
 *
 * @param {{bundleId?:string, appName?:string}} app
 * @param {{port:number, waitMs?:number, intervalMs?:number, deps?:object}} options
 * @returns {Promise<{ok:boolean, port:number, waitedMs:number, version?:object, error?:string}>}
 */
export async function launchWithDebug(app, options = {}) {
  const opts = options || {};
  const deps = Object.assign({
    exec,
    probe: probeDebugPort,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  }, opts.deps || {});
  const bundle = app.bundleId || app.bundle || '';
  const appName = app.appName || app.name || '';
  const port = opts.port || debugPortFor(bundle || appName);
  const waitMs = Number.isFinite(opts.waitMs) ? opts.waitMs : 12000;
  const intervalMs = Number.isFinite(opts.intervalMs) ? opts.intervalMs : 400;
  const target = appName ? ['-a', appName] : ['-b', bundle];
  try {
    await deps.exec('/usr/bin/open', ['-g', ...target, '--args', ...buildLaunchArgs(port)], { timeout: 8000 });
  } catch (e) {
    return { ok: false, port, waitedMs: 0, error: '启动失败：' + String(e && e.message || e).slice(0, 80) };
  }
  const started = Date.now();
  for (;;) {
    const probe = await deps.probe(port, { timeoutMs: 1000 });
    if (probe.ok) return { ok: true, port, waitedMs: Date.now() - started, version: probe.version };
    const waited = Date.now() - started;
    if (waited >= waitMs) return { ok: false, port, waitedMs: waited, error: probe.error || '端口始终没起来' };
    await deps.sleep(intervalMs);
  }
}

/**
 * 连上某个应用的页面 target。
 * @param {{port:number, match?:RegExp, timeoutMs?:number}} options
 * @returns {Promise<{ok:boolean, cdp?:object, target?:object, error?:string}>}
 */
export async function attachPage(options = {}) {
  const opts = options || {};
  // 给了 expectedPid 就先确认端口主人，避免连到一个冒充 CDP 的本地进程
  if (opts.expectedPid) {
    const ownerPid = await (opts.portOwner || debugPortOwner)(opts.port, opts);
    const trust = debugPortTrust({ ownerPid, appPid: opts.expectedPid });
    if (trust !== 'ok') {
      return { ok: false, trust, error: '调试端口主人校验未通过（' + trust + '，owner=' + ownerPid + ' 期望=' + opts.expectedPid + '）' };
    }
  }
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : 8000;
  const deps = Object.assign({
    listTargets,
    attach: (args) => CDP.attach(args),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  }, opts.deps || {});
  const sleep = deps.sleep;
  const started = Date.now();
  let lastError = '';
  for (;;) {
    try {
      const targets = await deps.listTargets({ port: opts.port });
      // 按分数依次试：有的空窗口连上就断（ChatGPT 的 detached 窗口实测会这样），换下一个
      const candidates = rankPageTargets(targets, { match: opts.match });
      for (const target of candidates) {
        let cdp = null;
        try {
          cdp = await deps.attach({ port: opts.port, target: target.id });
          const alive = await cdp.evaluate('document.readyState');
          if (alive) return { ok: true, cdp, target };
        } catch (e) {
          lastError = String(e && e.message || e).slice(0, 140);
        }
        try { if (cdp) cdp.close(); } catch {}
      }
      if (!candidates.length) lastError = '没有可用的页面 target（可能窗口还没建好）';
    } catch (e) {
      lastError = String(e && e.message || e).slice(0, 140);
    }
    if (Date.now() - started >= timeoutMs) return { ok: false, error: lastError };
    await sleep(500);
  }
}

/** 读页面标题/地址/可见文字（不截图） */
export async function readPage(cdp, options = {}) {
  const opts = options || {};
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : 6000;
  const sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const started = Date.now();
  let last = { title: '', url: '', text: '' };
  for (;;) {
    // CDP.evaluate 直接返回 JS 的值（returnByValue），不是协议外层信封
    const value = (await cdp.evaluate(
      '({ title: document.title, url: location.href, ready: document.readyState, text: (document.body && document.body.innerText || "").slice(0, 4000) })',
    )) || {};
    last = { title: value.title || '', url: value.url || '', text: value.text || '' };
    // 空页（detached/还没渲染）就再等等，别把"还没加载"当成"这个应用没内容"
    if (last.text.trim() || (value.ready === 'complete' && Date.now() - started > 1200)) return last;
    if (Date.now() - started >= timeoutMs) return last;
    await sleep(400);
  }
}

/**
 * 按可见文字点元素：完全匹配优先，其次包含匹配；点之前先滚动到可见区域。
 * @returns {Promise<{clicked:boolean, matched:string, count:number}>}
 */
export async function clickText(cdp, text) {
  const wanted = JSON.stringify(String(text));
  const script = [
    '(() => {',
    '  const want = ' + wanted + ';',
    '  const nodes = Array.from(document.querySelectorAll("button, a, [role=button], [role=link], input[type=submit], input[type=button], li, div, span"));',
    '  const label = (el) => ((el.innerText || el.value || el.getAttribute("aria-label") || "") + "").trim();',
    '  const exact = nodes.filter((el) => label(el) === want);',
    '  const partial = nodes.filter((el) => label(el).includes(want));',
    '  const target = (exact.length ? exact : partial).sort((a, b) => label(a).length - label(b).length)[0];',
    '  if (!target) return { clicked: false, matched: "", count: 0 };',
    '  target.scrollIntoView({ block: "center" });',
    '  target.click();',
    '  return { clicked: true, matched: label(target).slice(0, 80), count: (exact.length ? exact : partial).length };',
    '})()',
  ].join('\n');
  const res = await cdp.evaluate(script);
  return res || { clicked: false, matched: '', count: 0 };
}

/**
 * 往页面里的输入框写文字：按选择器或 placeholder/aria-label 找，聚焦后用 CDP 插字。
 * @returns {Promise<{typed:boolean, selector:string, verified?:string}>}
 */
export async function typeInto(cdp, { selector, text, submit = false }) {
  const sel = JSON.stringify(String(selector || ''));
  const focusScript = [
    '(() => {',
    '  const sel = ' + sel + ';',
    '  let el = null;',
    '  if (sel) el = document.querySelector(sel);',
    '  if (!el) {',
    '    const cands = Array.from(document.querySelectorAll("input:not([type=hidden]), textarea, [contenteditable=true]"));',
    '    el = cands.find((x) => (x.getAttribute("aria-label") || x.placeholder || "") === sel) || cands[0] || null;',
    '  }',
    '  if (!el) return { ok: false, tag: "" };',
    '  el.focus();',
    '  if (el.isContentEditable) { el.innerText = ""; } else if ("value" in el) { el.value = ""; }',
    '  return { ok: true, tag: el.tagName.toLowerCase() };',
    '})()',
  ].join('\n');
  const focused = await cdp.evaluate(focusScript);
  if (!focused || !focused.ok) {
    return { typed: false, selector: String(selector || '') };
  }
  await cdp.insertText(String(text));
  if (submit) {
    const key = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...key }).catch(() => {});
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...key }).catch(() => {});
  }
  const read = await cdp.evaluate('(() => { const el = document.activeElement; return el ? (el.value || el.innerText || "") : ""; })()');
  return { typed: true, selector: String(selector || ''), verified: String(read || '') };
}
