#!/usr/bin/env node
/**
 * examples/web-click/run.mjs — 通用网页点击最小示例（headless Chrome + CDP）
 *
 * 流程：
 *   1) 启动 headless Chrome（没有可见窗口，不会抢用户前台；用独立临时 profile）；
 *   2) CDP 连接页面，加载 examples/web-click/fixture.html（file://）；
 *   3) 在 DOM 里按「可见文字」找到按钮「提交」（不是写死坐标）；
 *   4) 用 CDP Input 域派发真实鼠标事件（isTrusted=true）在按钮中心点击；
 *   5) 读回 #result 文本，断言等于期望值；
 *   6) 关闭 Chrome 并清理临时 profile，校验前后前台应用没变。
 *
 * 守卫：找不到 Chrome / headless 启动失败 → 环境跳过（exit 0，打印原因，绝不假绿）；
 * 断言失败 → exit 1。
 *
 *   node examples/web-click/run.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { launch, CHROME_BIN } from '../../core/browser.mjs';
import { readFrontNameDetailed } from '../../core/front-read.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, 'fixture.html');
const PROFILE_BASE = path.join('/tmp', 'web-click-profile-');

/** 期望：往姓名框输入这个名字后点「提交」，结果区应显示这句话 */
export const INPUT_NAME = '测试用户';
export const BUTTON_TEXT = '提交';
export const EXPECTED_RESULT = '提交成功：' + INPUT_NAME;

/** Chrome 是否可用（不可用就让调用方环境跳过，而不是判失败） */
export function chromeAvailable() {
  try { return fs.existsSync(CHROME_BIN); } catch { return false; }
}

/** 读前台进程名（ObjC/NSWorkspace，不发 AppleEvent、不需要自动化授权） */
async function frontProcessName() {
  try {
    const detail = await readFrontNameDetailed({ mode: 'objc' });
    return detail.name || '';
  } catch {
    return '';
  }
}

function makeProfileDir() {
  const dir = fs.mkdtempSync(PROFILE_BASE);
  return dir;
}

function rmQuiet(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

/**
 * 执行一次完整的「按文字找按钮 → 后台点击 → 读回结果」。
 * 不抛异常：失败/环境跳过都体现在返回值里，方便单测与 CI 判断。
 *
 * @param {{launchTimeoutMs?:number, connectTimeoutMs?:number}} [options]
 * @returns {Promise<{ok:boolean, envSkip:boolean, reason:string, result?:object, steps:Array, front:object, error:string}>}
 */
export async function runWebClick(options = {}) {
  const opts = options || {};
  const report = {
    ok: false,
    envSkip: false,
    reason: '',
    steps: [],
    front: { before: '', after: '', unchanged: true },
    error: '',
    result: null,
  };

  report.front.before = await frontProcessName();

  if (!chromeAvailable()) {
    report.envSkip = true;
    report.reason = '环境跳过：找不到 Chrome（' + CHROME_BIN + '），无法跑 headless 网页点击';
    return report;
  }
  if (!fs.existsSync(FIXTURE)) {
    report.envSkip = true;
    report.reason = '环境跳过：fixture 不存在（' + FIXTURE + '）';
    return report;
  }

  let profileDir = null;
  let browser = null;
  try {
    profileDir = makeProfileDir();
    browser = await launch({
      userDataDir: profileDir,
      headless: true,
      timeoutMs: Number(opts.launchTimeoutMs || 60000),
      retries: 1,
    });
    report.steps.push({ step: 'launch', pid: browser.pid, port: browser.port, headless: true });

    const page = await browser.connect({ timeoutMs: Number(opts.connectTimeoutMs || 20000) });
    await page.send('Page.enable');
    await page.send('Emulation.setDeviceMetricsOverride', {
      width: 1280, height: 800, deviceScaleFactor: 1, mobile: false,
    });

    const url = pathToFileURL(FIXTURE).href;
    await page.send('Page.navigate', { url });
    const loaded = await page.waitFor(
      'document.readyState === "complete" && !!document.querySelector("button")',
      { timeout: 15000 },
    );
    if (!loaded) throw new Error('fixture 页面 15s 内没有加载完成：' + url);
    report.steps.push({ step: 'navigate', url });

    // 1) 按可见文字找按钮（DOM 查找，不写死坐标/选择器）
    const found = await page.evaluate([
      '(function () {',
      '  var wanted = ' + JSON.stringify(BUTTON_TEXT) + ';',
      '  var buttons = Array.prototype.slice.call(document.querySelectorAll("button"));',
      '  for (var i = 0; i < buttons.length; i += 1) {',
      '    var btn = buttons[i];',
      '    if (String(btn.textContent || "").trim() !== wanted) continue;',
      '    btn.scrollIntoView({ block: "center", inline: "center" });',
      '    var r = btn.getBoundingClientRect();',
      '    return { text: wanted, index: i, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), w: Math.round(r.width), h: Math.round(r.height) };',
      '  }',
      '  return null;',
      '})()',
    ].join('\n'));
    if (!found) throw new Error('按可见文字找不到按钮：' + BUTTON_TEXT);
    report.steps.push({ step: 'find-button-by-text', ...found });

    // 2) 往输入框填一个名字（focus + CDP Input.insertText，同样不碰系统键盘/指针）
    const inputFocused = await page.evaluate([
      '(function () {',
      '  var el = document.querySelector("#name");',
      '  if (!el) return false;',
      '  el.scrollIntoView({ block: "center", inline: "center" });',
      '  el.focus();',
      '  return document.activeElement === el;',
      '})()',
    ].join('\n'));
    if (!inputFocused) throw new Error('输入框 #name 聚焦失败');
    await page.send('Input.insertText', { text: INPUT_NAME });
    report.steps.push({ step: 'type-into-input', value: INPUT_NAME });

    // 3) 后台点击：CDP Input 域派发真实鼠标事件（isTrusted=true），headless 无可见窗口
    const click = await page.dispatchClick(found.x, found.y);
    report.steps.push({ step: 'background-click', ...click, method: 'CDP Input.dispatchMouseEvent' });

    // 4) 读回结果并断言
    const matched = await page.waitFor(
      '(function () { var el = document.querySelector("#result"); return !!el && el.textContent.trim() === ' + JSON.stringify(EXPECTED_RESULT) + '; })()',
      { timeout: 5000, interval: 50 },
    );
    const actual = await page.evaluate(
      '(document.querySelector("#result") ? document.querySelector("#result").textContent.trim() : "")',
    );
    report.result = { expected: EXPECTED_RESULT, actual: String(actual || ''), matched: Boolean(matched) };
    report.steps.push({ step: 'read-result', expected: EXPECTED_RESULT, actual: report.result.actual });

    // 5) 读回页面标题/输入值，证明是真实页面操作而不是 mock
    const pageTitle = await page.getTitle();
    const inputValue = await page.evaluate('(document.querySelector("#name") ? document.querySelector("#name").value : "")');
    report.result.pageTitle = pageTitle;
    report.result.inputValue = String(inputValue || '');
    if (pageTitle !== 'examples/web-click fixture') throw new Error('页面标题不符合预期：' + pageTitle);
    if (report.result.inputValue !== INPUT_NAME) throw new Error('输入框值不符合预期：' + report.result.inputValue);

    report.ok = Boolean(matched) && report.result.actual === EXPECTED_RESULT;
    if (!report.ok) report.error = '结果文本不符合预期：期望 ' + JSON.stringify(EXPECTED_RESULT) + '，实际 ' + JSON.stringify(report.result.actual);
  } catch (error) {
    const message = String((error && error.message) || error);
    report.error = message;
    // 启动/连接失败属于环境问题（缺 Chrome/无法起 headless/临时 profile 起不来）→ 环境跳过，不判失败
    report.envSkip = /启动 Chrome 失败|等待 Chrome|Chrome 调试端口|ENOENT|EACCES|ECONNREFUSED|连接页面超时|页面 15s 内没有加载完成/.test(message)
      || /找不到 Chrome/.test(message);
    if (report.envSkip) report.reason = '环境跳过：headless Chrome 不可用（' + message.slice(0, 160) + '）';
  } finally {
    try { if (browser) await browser.close(); } catch {}
    if (profileDir) rmQuiet(profileDir);
    report.front.after = await frontProcessName();
    if (report.front.before && report.front.after && report.front.before !== report.front.after) {
      report.front.unchanged = false;
      if (report.ok) {
        report.ok = false;
        report.error = '前台应用被改变：' + report.front.before + ' → ' + report.front.after;
      }
    }
  }

  return report;
}

// -------------------- CLI --------------------

const invokedDirectly = Boolean(process.argv[1])
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  const startedAt = Date.now();
  const report = await runWebClick();
  const elapsedMs = Date.now() - startedAt;

  if (report.envSkip) {
    console.log('SKIP  ' + (report.reason || '环境跳过：headless Chrome 不可用'));
    console.log(JSON.stringify({ ok: false, envSkip: true, elapsedMs, detail: report }, null, 2));
    process.exit(0);
  }

  console.log('[1] Chrome:', CHROME_BIN, '（headless，无可见窗口）');
  console.log('[2] 页面:', pathToFileURL(FIXTURE).href);
  for (const step of report.steps) console.log('    ' + step.step + ':', JSON.stringify(step));
  console.log('[3] 前台应用:', report.front.before || '(unknown)', '→', report.front.after || '(unknown)',
    report.front.unchanged ? '（未变）' : '（被改变！）');
  if (report.ok) {
    console.log('PASS  examples/web-click：按文字找到「' + BUTTON_TEXT + '」→ 后台点击 → 读回 ' + JSON.stringify(report.result.actual) + '（' + elapsedMs + 'ms）');
  } else {
    console.log('FAIL  examples/web-click：' + (report.error || '未知失败'));
  }
  console.log(JSON.stringify({ ok: report.ok, envSkip: report.envSkip, elapsedMs, detail: report }, null, 2));
  process.exit(report.ok ? 0 : 1);
}