'use strict';
/**
 * 安全边界静态自查：把"会出人命的几类写法"变成可执行规则，防止以后改代码时悄悄退化。
 *
 * 这里只查**结构性问题**（启动不收尾、强杀、前台抢占没人兜、读取绕过风险名单、
 * 对具体应用调 ocu 前没确认它在运行），不做语义分析，也不替代实机验收。纯函数，便于单测和 CI 直接跑。
 */

/** open 必须后台启动的例外：给用户看的、需要用户手动操作的界面 */
export const OPEN_BACKGROUND_ALLOWLIST = Object.freeze({
  'core/permissions.mjs': 'openPermissionSettings：用户主动查询权限时打开系统设置隐私面板，必须可见并由用户手动授权，不能后台',
});

/** 内层脚本：由外层任务在 guard/锁屏检查之后调用，自身不需要重复检查 */
export const UI_GUARD_ALLOWLIST = ['greet-inner.mjs'];

/** 只看任务目录（这些是真正会动用户应用和屏幕的代码） */
export const UI_ACTION_RE = /ocu\.|getAXState|readSafe|findSafe|snapshot\(|state\(|click\(|find\(|typeText|pressKey|setValue/;
export const UI_GUARD_RE = /isScreenLocked|lockedSkipNotice|foreignAcceptanceOwner|acceptanceLock|ACCEPT_|withAppLock|frontRiskGate|risk\.shouldSkip/;


// ---------- 规则 5：对具体应用调 ocu 之前必须有「运行门禁」 ----------
//
// 根因（flow/OCU-CALL-AUDIT.md 第 1 节）：ocu 对**没在运行**的应用调用 get_app_state / query /
// type_text 之类时，会把它启动起来并顶到前台。所以任何「直接操作某个应用」的调用点，同一文件里
// 必须先有 isAppRunning / ensureAppRunning / ensureAppWindow / requireAppRunning 之一；
// 确实不该被约束的（根因层封装、CDP/AppleScript 通道、内嵌 JXA 脚本文本）走文件级白名单，
// 个别点也可以在该行（或紧邻上一行）写 `// audit-ok: <理由>` 逐点豁免。
// 白名单理由写在下方的 PRESENCE_FILE_ALLOWLIST 里——新增条目要慎之又慎。

/** 规则 5 的作用域：真正会操作应用/屏幕的 Node 代码（test/overlay 不在内） */
export const OCU_PRESENCE_SCOPE_RE = /^(?:core|scripts)\//;

/**
 * 「对具体应用调 ocu」的调用写法。
 * 用负向后行断言排除 xxx.find( / arr.click( 这类同名方法，减少误报；
 * 内嵌 JXA 脚本文本里的 cua.getApp 也会命中，这类文件走白名单（理由见下）。
 */
const OCU_APP_CALL_PATTERNS = [
  String.raw`ocu\.snapshot\(`,
  String.raw`ocu\.call\(`,
  String.raw`callTool\(\s*['"](?:get_app_state|query|click|type_text|set_value)['"]`,
  String.raw`(?<![\w.])(?:readSafe|findSafe|state|find|click|typeText|setValue)\(`,
  String.raw`cua\.getApp\(`,
];
export const OCU_APP_CALL_RE = new RegExp(OCU_APP_CALL_PATTERNS.join('|'));

/** 允许「直接操作应用」的前置门禁函数：同文件出现任意一个即可 */
export const PRESENCE_GATE_RE = /isAppRunning|ensureAppRunning|ensureAppWindow|requireAppRunning/;

/** 逐点豁免注释：`// audit-ok: <理由>`（同一行或紧邻上一行，理由不能为空） */
export const AUDIT_OK_RE = /\/\/\s*audit-ok:\s*\S+/;

/** 规则 5 要覆盖的目录：CLI 扫前两个，core/*.mjs 由单测兜底扫（避免改动 scripts/ 里的入口） */
export const OCU_PRESENCE_DIRS = ['core/tasks', 'core', 'scripts'];

/**
 * 文件级白名单：命中的写法要么不是「Node 侧直接调 ocu」，要么这一层拿不到运行状态。
 * 键是仓库相对路径；值必须写清「为什么不该被这条规则约束」。
 */
export const PRESENCE_FILE_ALLOWLIST = Object.freeze({
  // 根因层 / 通用通道封装：这一层只有「动作」，不知道调用方要操作哪个应用，也拿不到运行状态；
  // 运行门禁必须由调用方（任务）负责。
  'core/background.mjs': '根因封装层：state/find/click/setValue/typeText/readSafe/findSafe 是纯动作封装，运行门禁由调用方负责',
  'core/agentd.mjs': 'ocu 封装层：snapshot/call/calls 是通用调用通道，不知道目标应用语义，门禁由调用方任务负责',
  'core/user-chrome.mjs': '用户 Chrome 专用通道：ensureUserChrome 显式启动 Chrome 是任务语义，读写入口由调用方先 ensure',
  'core/ocu-mcp.mjs': 'MCP 传输层：JSON-RPC 客户端，不决定操作哪个应用',
  'core/applescript-driver.mjs': 'AppleScript 通道：只发 Apple 事件，运行/授权检查由调用方负责',
  // CDP / Electron 通道：目标是页面 DOM 或自己拉起的实例，不存在「AX 读未运行应用会把它拉起来」
  'core/cdp.mjs': 'CDP 协议客户端：页面 DOM 操作，不经过 ocu/AX',
  'core/electron-task.mjs': 'Electron/CDP 通道：目标是 launch 自己拉起的实例或 attach 的外部实例，作用于 DOM',
  'core/cdp-driver.mjs': 'CDP 通道：只探测/校验调试端口，不读用户应用 AX、不启动应用',
  'core/human.mjs': '拟人轨迹纯函数：不直接调用 ocu',
  'core/safety-audit.mjs': '本文件是静态检查器：出现的调用写法是规则字面量与白名单文字，不是真实调用',
  // 内嵌 JXA 脚本文本 / 本地同名 helper 造成的静态命中：不是 Node 侧对 ocu 的直接调用
  'core/tasks/boss-candidates.mjs': '内嵌 JXA 脚本文本：cua.getApp 在字符串里由 ocu js 执行，不是本文件直接调用；外层读的是已运行的用户 Chrome',
  'core/tasks/form-fill-local.mjs': '内嵌 JXA 脚本文本 + 本地 regex 辅助函数；目标是自己 spawn 的 Electron 宿主，不碰用户应用',
  'core/tasks/greet-inner.mjs': '内层 JXA 脚本：由 boss-greet 驱动并在外层做运行门禁；本文件里的 state 是脚本内辅助函数',
  'core/tasks/user-chrome-demo.mjs': '显式启动用户 Chrome 的演示任务：ensureUserChrome 启动 Chrome 是任务语义（审计里归为「刻意启动器」），不是偷偷拉起',
});

/**
 * 找出一段源码里「对具体应用调 ocu」的位置（行号从 1 开始）。
 * @param {string} source
 * @returns {Array<{line:number, call:string, text:string}>}
 */
export function findOcuAppCalls(source) {
  const lines = String(source || '').split('\n');
  const hits = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const hit = line.match(OCU_APP_CALL_RE);
    if (!hit) continue;
    hits.push({ line: i + 1, call: hit[0], text: line.trim().slice(0, 140) });
  }
  return hits;
}

/**
 * 规则 5 的执行体：逐个命中检查「同文件运行门禁 / 文件白名单 / audit-ok 豁免」。
 * @param {{file:string, source:string}} input
 * @returns {Array<{rule:string, file:string, detail:string}>}
 */
export function auditOcuAppCalls(input) {
  const file = String(input && input.file || '');
  const source = String(input && input.source || '');
  const hits = findOcuAppCalls(source);
  if (!hits.length) return [];
  if (PRESENCE_FILE_ALLOWLIST[file]) return [];
  if (PRESENCE_GATE_RE.test(source)) return [];
  const lines = source.split('\n');
  const out = [];
  for (const hit of hits) {
    const current = lines[hit.line - 1] || '';
    const previous = hit.line >= 2 ? lines[hit.line - 2] : '';
    if (AUDIT_OK_RE.test(current) || AUDIT_OK_RE.test(previous)) continue;
    out.push({
      rule: 'raw-ocu-without-presence-gate',
      file,
      detail: 'L' + hit.line + ' 直接对应用调 ocu（' + hit.call + '），但同文件没有 isAppRunning/ensureAppRunning/'
        + 'ensureAppWindow/requireAppRunning，也没有 // audit-ok: 豁免：' + hit.text,
    });
  }
  return out;
}

/**
 * 检查一份源码。
 * @param {{file:string, source:string}} input
 * @param {{base?:string}} [options] file 用相对路径（如 core/tasks/x.mjs）便于展示
 * @returns {Array<{rule:string, file:string, detail:string}>}
 */
export function auditSource(input, options = {}) {
  const file = String(input && input.file || '');
  const source = String(input && input.source || '');
  const base = String(options.base || '');
  const name = base && file.startsWith(base) ? file.slice(base.length) : file;
  const short = name.split('/').pop();
  const out = [];
  const add = (rule, detail) => out.push({ rule, file: name, detail });

  // 1) 自己拉起的应用必须自己收掉，否则用户桌面上会多出测试窗口
  if (/ensureAppRunning\s*\(/.test(source) && !/quitApp\s*\(|cleanupApps\s*\(/.test(source)) {
    add('launch-no-cleanup', '调用了 ensureAppRunning 但没有 quitApp/cleanupApps 收尾');
  }

  // 2) 强杀是丢数据的直接来源（用户没保存的内容会被丢掉）
  const forceKill = source.match(/\bpkill\b[^\n]*(?:-9|-KILL)\b|\bkillall\b|\bkill\s+(?:-9|-KILL)\b/);
  if (forceKill) add('force-kill', '出现强制结束进程的写法：' + forceKill[0].trim());

  // 3) 启动应用必须用后台标志（open -g），否则会把前台抢走。
  //    只认真正的启动调用；不能只匹配字符串 'open'——CDP/WebSocket 状态机里到处是
  //    `this.state = 'open'` 这种字面量，会把 core/cdp.mjs 误判成启动应用。
  const openCall = source.match(
    /\/usr\/bin\/open|(?:exec(?:File|Sync)?|spawn(?:Sync)?|start)\(\s*['"]open['"]/,
  );
  if (openCall && !/'-g'|"-g"|launchFlags/.test(source) && !OPEN_BACKGROUND_ALLOWLIST[name]) {
    add('open-without-background', '调用 open 时没带 -g/launchFlags，会激活应用：' + openCall[0]);
  }

  // 4) 会动屏幕的任务必须有环境/互斥护栏，否则锁屏或被用户打断时会产出假失败。
  //    只对 core/tasks 生效：脚本目录的辅助工具不一定直接操作界面（由调用方传 uiGuard:false 跳过）
  const checkUiGuard = options.uiGuard !== false;
  if (checkUiGuard && UI_ACTION_RE.test(source) && !UI_GUARD_RE.test(source) && !UI_GUARD_ALLOWLIST.includes(short)) {
    add('ui-without-guard', '有界面操作但没有锁屏/前台/互斥护栏（也没在允许名单里）');
  }

  // 5) 对具体应用调 ocu 之前必须确认它在运行：ocu 会把没运行的应用启动起来并顶到前台
  //    （flow/OCU-CALL-AUDIT.md 第 1 节；白名单与 audit-ok 豁免见上方 PRESENCE_FILE_ALLOWLIST）
  if (options.ocuPresence !== false && OCU_PRESENCE_SCOPE_RE.test(name)) {
    out.push(...auditOcuAppCalls({ file: name, source }));
  }

  return out;
}

/**
 * 批量检查。
 * @param {Array<{file:string, source:string}>} entries
 * @param {{base?:string}} [options]
 */
export function auditTree(entries, options = {}) {
  const violations = [];
  for (const entry of entries || []) violations.push(...auditSource(entry, options));
  return violations;
}

/** 汇总成一行结论（CLI/报告用） */
export function summarizeViolations(violations) {
  const list = Array.isArray(violations) ? violations : [];
  if (!list.length) return '安全边界自查通过：没有发现启动不收尾/强杀/前台抢占/绕过风险名单/直接调 ocu 前未确认应用在运行的写法。';
  const byRule = new Map();
  for (const v of list) byRule.set(v.rule, (byRule.get(v.rule) || 0) + 1);
  return '安全边界自查发现 ' + list.length + ' 处问题（' +
    [...byRule].map(([rule, n]) => rule + ' × ' + n).join('，') + '）：\n' +
    list.map((v) => '  - ' + v.file + '：' + v.detail).join('\n');
}
