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
// 同名方法排除：`list.find(` / `map.click(` 这类不是界面操作，别误判成任务在动界面。
// 注意 getAXState/readSafe/findSafe 常写成 `app.getAXState()`，必须保留（不加后行断言）。
export const UI_ACTION_RE =
  /ocu\.|getAXState|readSafe|findSafe|snapshot\(|typeText|pressKey|(?<![\w.])(?:state\(|click\(|find\(|setValue\()/;
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
    // 纯注释行里的例子/说明（例如 JSDoc 写「按 callTool('get_app_state') 的语义」）不是真实调用，
    // 不参与判定——否则为了过检查得把注释改得含糊，反而没人看得懂（规则 6 同样处理）。
    if (COMMENT_LINE_RE.test(line)) continue;
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


// ---------- 规则 6：发 AppleEvent 之前必须有「自动化预检」 ----------
//
// 背景（flow/PERMISSIONS-AUDIT.md H2）：未授权「自动化」时直接 osascript 控制别的应用会弹系统
// 授权框，无人值守的验收/清理会被卡住。core/appleevent-preflight.mjs 提供了静默预检
// （askUserIfNeeded=false）。规则要求：凡是「对别的应用发 AppleEvent」的位置，同文件里必须有
// checkAutomationPermission / createAppleEventPreflight / preflightAppleEvent / runAppleEventGuarded /
// decideAutomationAllow 之一；或该行（紧邻上一行）写 // audit-ok: <理由>；或文件级白名单（每条写理由）。
//
// 识别方式（刻意做窄，避免误报）：
//   1) exec*/spawn* 调用里出现 osascript，且同一调用窗口（本行 + 后续 6 行）出现 tell application；
//   2) 源码里的 AppleScript 常量：非纯注释行出现 tell application。
//   ObjC/JXA（osascript -l JavaScript + ObjC.import / CGWindowList，脚本里没有 tell application）
//   不算——这类调用不经过 Apple Events 授权，也不该被这条规则拦。
export const APPLEEVENT_SCOPE_RE = /^(?:core|scripts)\//;

/** 只匹配 AppleScript/AppleEvent 的 tell 语义；ObjC/JXA 的 Application('X') 不在内 */
const APPLE_EVENT_SCRIPT_RE = /tell\s+application\s/i;

/** exec/spawn 调用（Any 分隔符文本里出现即算一个调用点） */
const OSASCRIPT_CALL_RE = /(?:execFileSync|execFile|execSync|exec|spawnSync|spawn)\s*\(/;

/** osascript 可执行文件（绝对路径或裸命令名） */
const OSASCRIPT_BIN_RE = /\/usr\/bin\/osascript|['"]osascript['"]/;

/** 纯注释行（行首 // / * / 块注释开头）：里面的 tell application 是说明文字，不是真脚本 */
const COMMENT_LINE_RE = /^\s*(?:\/\/|\*|\/\*)/;

/** 允许「发 AppleEvent」的前置预检函数（同文件出现任意一个即可） */
export const AUTOMATION_PREFLIGHT_RE = /checkAutomationPermission|createAppleEventPreflight|preflightAppleEvent|runAppleEventGuarded|decideAutomationAllow/;

/** 规则 6 的扫描窗口：exec 调用可能跨行写参数，向后看 6 行足够覆盖现有写法 */
const APPLE_EVENT_CALL_WINDOW = 6;

/** 规则 6 要覆盖的目录（与规则 5 一致：CLI 扫 core/tasks+core+scripts） */
export const APPLEEVENT_PREFLIGHT_DIRS = ['core/tasks', 'core', 'scripts'];

/**
 * 文件级白名单：这些文件的 AppleEvent 调用点不是「该由本文件预检」的。
 * 键是仓库相对路径；值必须写清「为什么」——新增条目要慎之又慎。
 */
/**
 * 文件级白名单（结构性豁免）：这些位置不是「该由本文件做预检」的。
 * 键是仓库相对路径；值必须写清理由。
 */
export const AUTOMATION_PREFLIGHT_FILE_ALLOWLIST = Object.freeze({
  // 预检实现本身
  'core/appleevent-preflight.mjs': '预检实现本身：这里就是在做自动化授权探测，不应对自己再要一层预检',
  'core/applescript-driver.mjs': '预检实现本身：checkAutomationPermission / runAppScript 是静默探测与 fail-closed 的权威实现',
  // 底层 helper：调用方众多，入口统一预检；本层塞预检会改变所有调用方的时序/性能
  'core/background.mjs': '底层 AX/AppleEvent 动作层（frontName/dialogs/quitApp）：由调用方入口统一预检；H2 已覆盖 acceptance/browser/headless-demo/清理脚本等入口',
  'core/front-watch.mjs': '前台轮询/还原 helper：任务运行期间每 300ms 调用一次，预检放在这里会把探测放大成每秒数次；由上层入口负责',
  'core/platform.mjs': 'readFrontmostApp 底层封装（单行 osascript 读前台名）：通用平台层，不控制应用状态，预检由调用方负责',
  'core/agentd.mjs': 'restoreFrontTo 兜底还原：只在 guard/任务已经决定要还原前台时调用，属于收尾动作，预检由任务入口负责',
  'core/front-read.mjs': '前台读取策略：优先 ObjC（无 AppleEvent），AppleScript 只是回退路径；回退在预检/回退策略内由上层调用，不在本文件重复探测',
  'core/dialog-guard.mjs': '弹窗守卫：先用 classifyDialog 判定权限弹窗（绝不代点），dialogs/读取是底层 helper；按钮点击只在 benign 类，由调用方入口预检',
  'core/text-edit-guard.mjs': '写前安全检查的只读脚本常量（读文稿名/长度）：只读、不改应用状态，调用方入口负责预检',
  'core/daemon.mjs': 'selfTest 的 automationProbe 本身就是在探测「自动化/System Events 是否可用」，不可能也不应该对自己先预检；daemon 自身不控制别的应用',
  // 辅助脚本：只读桌面尺寸/标签，不控制应用
  'scripts/ui-check.mjs': '截图辅助脚本：只读 Finder 桌面 bounds 用于裁剪小窗区域，不控制应用状态；不是任务执行入口',
  'scripts/ui-gallery.mjs': '截图辅助脚本：只读 Finder 桌面 bounds 用于裁剪截图，不控制应用状态；不是任务执行入口',
});

/**
 * 已知缺口（不是「不该查」，而是「当前还没接预检」）：H2 收口只覆盖了
 * acceptance / browser / headless-demo / note-cleanup / sync-quit / applescript-channel / cold-launch。
 * 这些任务/脚本仍有裸 AppleEvent；本任务不改业务代码，先显式登记，避免静态检查红着或悄悄漏掉。
 * 每条都必须在理由里写「已知缺口」，补完预检后从这里删掉。
 */
export const AUTOMATION_PREFLIGHT_KNOWN_GAPS = Object.freeze({
  'core/tasks/app-matrix.mjs': '已知缺口：矩阵任务收尾还原前台的 AppleEvent 未接预检（有锁屏/前台风险门禁）',
  'core/tasks/boss-scan.mjs': '已知缺口：读 Chrome 标签 URL 的 AppleScript 常量未接预检（有运行门禁，只读浏览器壳）',
  'core/tasks/browser-background.mjs': '已知缺口：frontName 读前台名的 AppleEvent 未接预检',
  'core/tasks/drive-agent.mjs': '已知缺口：front() 读前台名的 AppleEvent 未接预检（有 isAppRunning 门禁）',
  'core/tasks/drive-agent-cli.mjs': '已知缺口：front() 读前台名的 AppleEvent 未接预检（有 isAppRunning 门禁）',
  'core/tasks/form-fill.mjs': '已知缺口：读/切 Chrome 标签 URL 的 AppleScript 未接预检（只改浏览器壳标签）',
  'core/tasks/form-fill-local.mjs': '已知缺口：frontName 的 AppleEvent 未接预检（本地 Electron 对照任务）',
  'core/tasks/parallel-demo.mjs': '已知缺口：front() 读前台名的 AppleEvent 未接预检',
  'core/tasks/parallel-real-demo.mjs': '已知缺口：front() 读前台名的 AppleEvent 未接预检',
  'scripts/cleanup-test-data.mjs': '已知缺口：清理脚本的 AppleEvent（读/关测试文稿、读 Chrome 标签）未接预检；目前靠用户空闲门禁 + 测试格式判定兜底',
});

/**
 * 找出「对别的应用发 AppleEvent」的位置（行号从 1 开始）。
 * @param {string} source
 * @returns {Array<{line:number, why:string, text:string}>}
 */
export function findAppleEventSites(source) {
  const lines = String(source || '').split('\n');
  const hits = [];
  const seen = new Set();
  // exec 调用的脚本参数可能跨行：命中后把这些行标记为已覆盖，避免第 2 步把同一段脚本再报一次
  const covered = new Set();

  // 1) exec/spawn 里的 osascript 调用：窗口里出现 tell application 才算 AppleEvent
  for (let i = 0; i < lines.length; i += 1) {
    if (!OSASCRIPT_CALL_RE.test(lines[i])) continue;
    const end = Math.min(lines.length, i + APPLE_EVENT_CALL_WINDOW);
    const windowText = lines.slice(i, end).join('\n');
    if (!OSASCRIPT_BIN_RE.test(windowText) || !APPLE_EVENT_SCRIPT_RE.test(windowText)) continue;
    if (seen.has(i + 1)) continue;
    seen.add(i + 1);
    for (let j = i; j < end; j += 1) covered.add(j + 1);
    hits.push({ line: i + 1, why: 'osascript 调用', text: lines[i].trim().slice(0, 140) });
  }

  // 2) 源码里的 AppleScript 常量（非纯注释行、且不在上面已覆盖的 exec 窗口里）
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!APPLE_EVENT_SCRIPT_RE.test(line)) continue;
    if (COMMENT_LINE_RE.test(line)) continue;
    if (seen.has(i + 1) || covered.has(i + 1)) continue;
    seen.add(i + 1);
    hits.push({ line: i + 1, why: 'AppleScript 常量', text: line.trim().slice(0, 140) });
  }

  return hits.sort((a, b) => a.line - b.line);
}

/**
 * 规则 6 的执行体：逐个命中检查「同文件预检 / 文件白名单 / audit-ok 豁免」。
 * @param {{file:string, source:string}} input
 * @returns {Array<{rule:string, file:string, detail:string}>}
 */
export function auditAppleEventPreflight(input) {
  const file = String(input && input.file || '');
  const source = String(input && input.source || '');
  const hits = findAppleEventSites(source);
  if (!hits.length) return [];
  if (AUTOMATION_PREFLIGHT_FILE_ALLOWLIST[file] || AUTOMATION_PREFLIGHT_KNOWN_GAPS[file]) return [];
  // 预检要真调用：只写在注释里的名字不算（去掉 // 注释后再判）
  const codeOnly = source.replace(/\/\/[^\n]*/g, '');
  if (AUTOMATION_PREFLIGHT_RE.test(codeOnly)) return [];
  const lines = source.split('\n');
  const out = [];
  for (const hit of hits) {
    const current = lines[hit.line - 1] || '';
    const previous = hit.line >= 2 ? lines[hit.line - 2] : '';
    if (AUDIT_OK_RE.test(current) || AUDIT_OK_RE.test(previous)) continue;
    out.push({
      rule: 'appleevent-without-preflight',
      file,
      detail: 'L' + hit.line + ' 对别的应用发 AppleEvent（' + hit.why + '），但同文件没有自动化预检'
        + '（checkAutomationPermission/createAppleEventPreflight/preflightAppleEvent/runAppleEventGuarded/decideAutomationAllow），'
        + '也没有 // audit-ok: 豁免：' + hit.text,
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

  // 6) 对别的应用发 AppleEvent 之前必须有自动化预检（H2；白名单/audit-ok 见 AUTOMATION_PREFLIGHT_FILE_ALLOWLIST）
  if (options.appleEventPreflight !== false && APPLEEVENT_SCOPE_RE.test(name)) {
    out.push(...auditAppleEventPreflight({ file: name, source }));
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
  if (!list.length) return '安全边界自查通过：没有发现启动不收尾/强杀/前台抢占/绕过风险名单/直接调 ocu 前未确认应用在运行/发 AppleEvent 前没做自动化预检的写法。';
  const byRule = new Map();
  for (const v of list) byRule.set(v.rule, (byRule.get(v.rule) || 0) + 1);
  return '安全边界自查发现 ' + list.length + ' 处问题（' +
    [...byRule].map(([rule, n]) => rule + ' × ' + n).join('，') + '）：\n' +
    list.map((v) => '  - ' + v.file + '：' + v.detail).join('\n');
}
