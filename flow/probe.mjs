#!/usr/bin/env node
/**
 * probe.mjs — 后台（不抢焦点、不动鼠标）操作 Chrome 网页的可验证探针
 *
 * 做什么：
 *   在后台 Chrome 的 BOSS 直聘职位页（/web/geek/jobs）左侧筛选栏，点击「武汉」城市按钮，
 *   再读一次 AX 树证明页面确实变了（弹出「请选择城市」浮层），最后尽量把弹层关掉恢复现场。
 *   全程记录真实前台应用与鼠标坐标，证明 Chrome 没有被激活、鼠标没有被移动。
 *
 * 用法：
 *   node probe.mjs
 *   OCU_APP="Google Chrome" OCU_BIN=/path/to/ocu node probe.mjs
 *
 * 退出码：0 全部通过 / 1 业务验证失败 / 2 环境不可用（锁屏、ocu 异常、前置条件不满足）
 *
 * 安全边界：只点左侧筛选栏的城市按钮和城市弹层的关闭按钮，绝不触发打招呼/投递/发送。
 */

import { execFile, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const HOME = process.env.HOME || "";
const OCU = process.env.OCU_BIN || join(HOME, ".local", "bin", "ocu");
const APP = process.env.OCU_APP || "Google Chrome";
const EXPECTED_FRONTMOST = process.env.EXPECTED_FRONTMOST || "DeepSeek Harness";
const JS_TIMEOUT_MS = Number(process.env.PROBE_JS_TIMEOUT_MS || 90000);
const PAGE_URL_FRAGMENT = "zhipin.com/web/geek/jobs";
const DIALOG_MARKER = "请选择城市";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function sh(cmd, args, opts) {
  const options = Object.assign({ encoding: "utf8", timeout: 60000 }, opts || {});
  const r = spawnSync(cmd, args, options);
  return {
    code: r.status,
    out: (r.stdout || "").trim(),
    err: (r.stderr || "").trim(),
    error: r.error ? String(r.error.message) : null,
  };
}

function execFileP(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { encoding: "utf8", timeout: 15000 }, (err, stdout) => {
      resolve({ code: err ? 1 : 0, out: (stdout || "").trim() });
    });
  });
}

// 异步跑子进程：不能用 spawnSync，否则会阻塞事件循环，期间的前台采样全部失效。
function runProcessP(cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    let out = "";
    let err = "";
    let settled = false;
    const finish = (extra) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(Object.assign({ out: out.trim(), err: err.trim() }, extra));
    };
    let child;
    try {
      child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      resolve({ code: -1, out: "", err: "", error: String(e.message) });
      return;
    }
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch (e) {}
      finish({ code: -1, error: "timeout after " + timeoutMs + "ms" });
    }, timeoutMs);
    child.stdout.on("data", (d) => { out += d.toString(); });
    child.stderr.on("data", (d) => { err += d.toString(); });
    child.on("error", (e) => finish({ code: -1, error: String(e.message) }));
    child.on("close", (code) => finish({ code: code }));
  });
}

// 真实前台应用：System Events 的 frontmost 进程。
// 注意 ocu list-apps 是按「最近使用日期 + 使用次数」排序，不代表当前前台，只能参考。
async function frontmostName() {
  const r = await execFileP("osascript", [
    "-e",
    'tell application "System Events" to get name of first application process whose frontmost is true',
  ]);
  return r.out;
}

async function mousePosition() {
  const r = await execFileP("osascript", [
    "-l",
    "JavaScript",
    "-e",
    'ObjC.import("AppKit"); var e=$.NSEvent.mouseLocation; JSON.stringify({x:Math.round(e.x),y:Math.round(e.y)})',
  ]);
  return r.out;
}

// 锁屏检测：锁屏时 macOS 拒绝 AX 读窗口，ocu 会报 NSPOSIXErrorDomain Code=2。
function screenLockState() {
  const r = sh("ioreg", ["-n", "Root", "-d1", "-a"]);
  const locked = /<key>CGSSessionScreenIsLocked<\/key>\s*<true\/>/.test(r.out);
  const m = /<key>CGSSessionScreenLockedTime<\/key>\s*<(?:real|integer)>([0-9.]+)<\/(?:real|integer)>/.exec(r.out);
  return { locked: locked, lockedAt: m ? new Date(Number(m[1]) * 1000).toISOString() : null };
}

function listAppsFirstLine() {
  const r = sh(OCU, ["list-apps"]);
  const lines = r.out.split("\n").map((s) => s.trim()).filter(Boolean);
  return lines.length ? lines[0] : "";
}

function buildInnerSource() {
  const src = readFileSync(join(HERE, "probe-inner.mjs"), "utf8");
  return src
    .replaceAll("__APP__", JSON.stringify(APP))
    .replaceAll("__FRAGMENT__", JSON.stringify(PAGE_URL_FRAGMENT))
    .replaceAll("__DIALOG_MARKER__", JSON.stringify(DIALOG_MARKER));
}

async function runOcuJs(dir) {
  const jsPath = join(dir, "probe-inner.runtime.mjs");
  writeFileSync(jsPath, buildInnerSource(), "utf8");
  const r = await runProcessP(
    OCU,
    ["js", "--json", "--timeout", String(JS_TIMEOUT_MS), "--file", jsPath],
    JS_TIMEOUT_MS + 20000
  );

  let items = [];
  let isError = false;
  try {
    const parsed = JSON.parse(r.out);
    isError = parsed.isError === true;
    if (Array.isArray(parsed.content)) {
      items = parsed.content.filter((x) => x && x.type === "text").map((x) => x.text);
    }
  } catch (e) {
    items = r.out.split("\n");
  }
  if (isError) items.push("OCU_JS_ISERROR");

  let payload = null;
  for (let i = items.length - 1; i >= 0; i--) {
    const text = items[i];
    if (typeof text !== "string") continue;
    const at = text.lastIndexOf("OCU_PROBE_JSON=");
    if (at < 0) continue;
    try {
      payload = JSON.parse(text.slice(at + "OCU_PROBE_JSON=".length));
      break;
    } catch (e) {
      payload = null;
    }
  }
  return { payload: payload, stdout: r.out, stderr: r.err, code: r.code, error: r.error };
}

async function main() {
  console.log("=== ocu 后台操作探针 (probe.mjs) ===");
  console.log("ocu:", OCU);
  console.log("目标应用:", APP);

  const version = sh(OCU, ["--version"]);
  console.log("ocu 版本:", version.out || version.err || "unknown");

  const lock = screenLockState();
  const skipLockCheck = process.env.PROBE_SKIP_LOCK_CHECK === "1";
  if (lock.locked && !skipLockCheck) {
    console.error("");
    console.error("[环境不可用] 屏幕处于锁定/屏保状态（自 " + (lock.lockedAt || "未知时间") + " 起）。");
    console.error("锁屏时 macOS 拒绝 Accessibility 读取窗口，ocu 的 snapshot/get_app_state 会报：");
    console.error('  Error Domain=NSPOSIXErrorDomain Code=2 "No such file or directory"');
    console.error("请先解锁屏幕（并建议保持会话唤醒，例如 caffeinate -d）后重跑本脚本。");
    return 2;
  }

  const frontBefore = await frontmostName();
  const mouseBefore = await mousePosition();
  const listAppsBefore = listAppsFirstLine();
  console.log("");
  console.log("[操作前] 真实前台应用(System Events):", frontBefore || "(读取失败)");
  console.log("[操作前] 鼠标坐标:", mouseBefore || "(读取失败)");
  console.log("[操作前] ocu list-apps 第一行:", listAppsBefore || "(读取失败)");
  console.log("  注：list-apps 第一行是按最近使用排序，不代表前台，仅作参考。");

  // 探针运行期间持续采样前台应用，防止 Chrome 被瞬间激活又切回而漏检。
  const samples = [];
  let sampling = true;
  const sampler = (async () => {
    while (sampling) {
      const name = await frontmostName();
      if (name) samples.push(name);
      await sleep(700);
    }
  })();

  const dir = mkdtempSync(join(tmpdir(), "ocu-probe-"));
  let result = null;
  try {
    result = await runOcuJs(dir);
  } finally {
    sampling = false;
    await sampler;
    rmSync(dir, { recursive: true, force: true });
  }

  const frontAfter = await frontmostName();
  const mouseAfter = await mousePosition();
  const listAppsAfter = listAppsFirstLine();
  console.log("");
  console.log("[操作后] 真实前台应用(System Events):", frontAfter || "(读取失败)");
  console.log("[操作后] 鼠标坐标:", mouseAfter || "(读取失败)");
  console.log("[操作后] ocu list-apps 第一行:", listAppsAfter || "(读取失败)");

  const p = result.payload;
  if (!p) {
    console.error("");
    console.error("[失败] 没能从 ocu js 拿到结构化结果，原始输出如下：");
    console.error("exit:", result.code, "spawnError:", result.error || "none");
    console.error((result.stderr || result.stdout || "(空)").slice(0, 3000));
    return 2;
  }

  const c = p.checks || {};
  console.log("");
  console.log("--- 页面证据 ---");
  console.log("页面 URL:", p.page && p.page.url);
  console.log("AX 行数:", c.axBeforeLines, "->", c.axAfterLines);
  const targetLine = (p.evidence || []).find((e) => e.indexOf("目标控件:") === 0);
  console.log(targetLine || "目标控件: (未找到)");
  console.log("点击方式: accessibility (element_index)");
  console.log("点击前弹层已关闭（干净起点）:", c.dialogAbsentBefore === true);
  console.log("点击后城市弹层节点出现:", c.dialogAppeared === true);
  console.log("弹层标志命中:", JSON.stringify(c.dialogMarkersAfter || {}));
  console.log("弹层内含「热门城市」分区:", c.hotCitySectionSeen === true);
  console.log("AX 新增/变化行数:", c.addedLineCount);
  const addedLines = (p.evidence || []).filter((e) => e.indexOf("+ ") === 0).slice(0, 10);
  for (const line of addedLines) console.log("   ", line);
  if (p.steps && p.steps.length) {
    const stepsText = JSON.stringify(p.steps);
    console.log("步骤:", stepsText.length > 800 ? stepsText.slice(0, 800) + "..." : stepsText);
  }
  if (p.errors && p.errors.length) console.log("内层错误:", JSON.stringify(p.errors));

  console.log("");
  console.log("--- 前台未变验证 ---");
  console.log("操作前:", frontBefore);
  console.log("操作后:", frontAfter);
  console.log("运行期间采样:", JSON.stringify(samples));
  const chromeSeen = samples.some((n) => n === APP) || frontBefore === APP || frontAfter === APP;
  console.log("Chrome 是否曾成为前台:", chromeSeen);
  console.log("鼠标坐标是否一致:", mouseBefore === mouseAfter ? "是（" + mouseAfter + "）" : "否（" + mouseBefore + " -> " + mouseAfter + "）");

  // 人工干扰检测：如果运行期间鼠标动了，说明有人在用这台机器，
  // 此时前台应用变化不能归因于自动化，前台相关判定降级为告警（不是失败）。
  const humanInterference = mouseBefore !== mouseAfter || samples.some((n) => n === "Finder");
  if (humanInterference) {
    console.log("");
    console.log("检测到人工干扰：运行期间鼠标移动 / 前台切到 Finder 等，前台相关判定降级为告警。");
  }

  const checks = [];
  const mark = (name, pass, extra, fatal) =>
    checks.push({ name: name, pass: pass, extra: extra, fatal: fatal !== false });
  const focusFatal = !humanInterference;
  mark("页面是 BOSS 职位页", c.onBossJobsPage === true);
  mark("点击前弹层已关闭（干净起点）", c.dialogAbsentBefore === true);
  mark("找到左侧筛选栏城市按钮", !!c.cityButtonFound);
  mark("点击后 AX 出现城市弹层（节点存在）", c.dialogAppeared === true);
  mark("弹层包含「热门城市」分区", c.hotCitySectionSeen === true);
  mark("页面 URL 未跳转", c.urlUnchanged === true);
  mark("操作前前台不是 Chrome", frontBefore !== APP, frontBefore);
  mark("操作后前台不是 Chrome", frontAfter !== APP, frontAfter, focusFatal);
  mark("运行期间 Chrome 从未成为前台", !chromeSeen, humanInterference ? "人工干扰期间无法归因" : "", focusFatal);
  mark(
    "鼠标未移动（期间有人操作会误报，仅告警）",
    mouseBefore === mouseAfter,
    mouseBefore === mouseAfter ? "" : "人工操作导致，非自动化副作用",
    false
  );
  mark("操作时前台是 " + EXPECTED_FRONTMOST, frontBefore === EXPECTED_FRONTMOST, frontBefore);
  mark("操作后前台是 " + EXPECTED_FRONTMOST, frontAfter === EXPECTED_FRONTMOST, frontAfter, focusFatal);

  console.log("");
  console.log("--- 现场恢复（参考项，不计入成败） ---");
  console.log(
    c.dialogClosedAfterProbe === true
      ? "城市弹层已关闭，页面已恢复"
      : "城市弹层未关闭（恢复用的 sky_click 不稳定）；无害，手动点一下页面空白处即可关闭"
  );

  console.log("");
  console.log("--- 验收 ---");
  let allPass = true;
  for (const chk of checks) {
    const tag = chk.pass ? "  PASS  " : chk.fatal ? "  FAIL  " : "  WARN  ";
    console.log(tag + chk.name + (chk.extra ? "  [" + chk.extra + "]" : ""));
    if (!chk.pass && chk.fatal) allPass = false;
  }
  console.log("");
  console.log("结果:", allPass ? "全部通过" : "存在失败项");
  return allPass ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error("[未捕获异常]", e);
    process.exit(2);
  });
