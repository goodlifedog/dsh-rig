# ocu 调用审计：还有哪些任务会把未运行的应用拉起/激活

> 生成时间：2026-11-08 · 审计人：cdp-bridge（第三方视角，只读）
> 背景：multi-app 对未运行的 Calculator 直接 `ocu.snapshot`，ocu 把计算器启动并顶到前台，
> 任务结束后没关，后续 app-matrix 的「前台被抢占」被判失败。证据见
> `logs/runs/2026-11-08T08-08-16-233Z-multi-app.jsonl`（两条 line 都是「前台 DeepSeek Harness → 计算器」）。
> 本审计只读：grep + 读代码 + 读历史日志。**没有启动/激活任何应用，没有跑任何任务本体**（屏幕已锁）。
> 覆盖：`core/tasks/*.mjs`（32 个）、`core/agentd.mjs`、`core/background.mjs`、`core/user-chrome.mjs`、`scripts/*.mjs`（31 个）。
> **修复状态（2026-11-08 收尾）**：第 1 节的 11 处高危调用点已全部加运行门禁并补齐单测；统一门禁抽到
> `core/app-presence.mjs`；脚本层 `scripts/bench-ocu.mjs` 也已门禁。逐项状态见文末第 8 节。

## 0. 结论摘要

- **高危直接调用点 11 处**：这些任务在目标应用**没在运行**时会直接调 ocu 读取/输入，ocu 会把应用启动并带出窗口（多数还会抢前台）。其中多数直接读用户自己的应用（Chrome/终端/聊天客户端），有的按参数或固定候选挑应用；`write-task` 是发消息任务，副作用最大。
- **根因层 3 个模块**：`core/agentd.mjs` 的 `ocu.snapshot/call/calls`、`core/background.mjs` 的 `state/find/click/setValue/typeText`、`core/user-chrome.mjs` 的 `readState/find/clickText/typeText` —— 它们都**没有**「应用在不在运行」的前置条件。`readSafe/findSafe` 只处理「读之后前台被抢」，不处理「读之前应用被启动」。
- **已有正确模式 2 个，可当模板**：`core/tasks/coverage-probe.mjs:248`（`if (!item.running) → 未测/跳过，理由是「扫描非运行应用会把它启动起来」）、`core/tasks/multi-app.mjs`（本轮已修：`isAppRunning` + `shouldProbeApp`，未运行直接环境跳过）。
- **「刻意启动器」5 个**（`ensureAppRunning/ensureAppWindow` + 结束 `quitApp`）：`background-control`、`background-stability`、`app-matrix`、`cold-launch`、`concurrent-demo`。它们启动应用是设计行为、且只关自己拉起的；但**用户在场时不应该跑**。
- **脚本层**：`scripts/bench-ocu.mjs` 是高危（默认对 Google Chrome 调 `get_app_state`，没运行检查）；`scripts/cleanup-test-data.mjs` 中危但已有用户空闲门禁；其余脚本要么纯文件/日志，要么是「间接跑任务」的编排脚本（继承任务风险）。

## 1. 高危：可能拉起并激活用户应用（P0）

判据：调用 ocu 读/写某个具体应用之前，同函数/同流程里**没有** `isAppRunning / ensureApp*`，也没有「不在运行就跳过」的分支。

| # | 位置（文件:行） | 目标应用来源 | 调了什么 | 说明 |
| --- | --- | --- | --- | --- |
| 1 | `core/tasks/user-active-demo.mjs:40,41,45,55,59,66,67` | 固定候选「计算器/备忘录/文本编辑」，按用户当前前台避开一个 | `state() / find() / click()` | 目标应用没运行会被拉起并带出窗口；这个任务恰恰是验证「后台操作不抢前台」，一旦拉起自己就破坏了前提，且收尾不关 |
| 2 | `core/tasks/terminal-control.mjs:48,64,72,81` | `TERM_APP`（默认 Ghostty） | `readSafe() / find() / typeText() / state()` | Ghostty 没运行会被启动；之后还往新窗口敲 `echo`（type_text 有前台还原，但启动本身收不回） |
| 3 | `core/tasks/drive-agent.mjs:85,91,98,102,113` | `AGENT_APP`（默认 ChatGPT） | `callTool query/set_value/get_app_state/press_key` | ChatGPT 通常关着；一跑就会启动它并往输入区写提示词、回车。副作用在全仓排前列 |
| 4 | `core/tasks/drive-agent-cli.mjs:72,105,110` | `CLI_TERM_APP`（默认 Ghostty） | `readSafe() / callTool type_text/press_key` | 同 2；只是敲的命令是 `opencode run` |
| 5 | 原扫描任务（站点专用，已移除） | `TARGET_APP`（默认 Google Chrome） | `ocu.snapshot()` ×2 | Chrome 没运行会被启动；这任务读的是用户自己的 Chrome（登录态） |
| 6 | `core/tasks/form-fill.mjs:260,266,276,292,298` | `TARGET_APP`（默认 Google Chrome） | `ocu.frontmost()` + 内层 `ocu js`（cua.getApp/getAXState/set_value…） | `frontmost` 本身安全，但内层 JS 会 getApp → 启动 Chrome；随后改搜索框 |
| 7 | 原写类任务 + 内层脚本（站点专用，已移除） | `TARGET_APP`（默认 Google Chrome） | `execFile(OCU, ['js', '--file', inner])`；内层 `cua.getApp(APP)` | 发消息任务；应用没运行也会被拉起。内层脚本没有运行检查，外层也没补 |
| 8 | `core/tasks/mcp-demo.mjs:21-26` | `TARGET_APP`（默认 Google Chrome） | `mcp.callTool('get_app_state')` | 演示脚本，直接读目标应用；没运行就启动 |
| 9 | `core/tasks/platform-demo.mjs:54` | `TARGET_APP`（默认 Google Chrome） | `ocuState(target)` → 内层 `cua.getApp` + `getAXState` | 只防了「读会抢前台」和锁屏，没防「读会启动」 |
| 10 | `core/tasks/background-control.mjs:188` | 固定「文本编辑」 | `find('文本编辑', { role: 'AXTextArea' })` | 备忘录/计算器有 `ensureAppRunning`（:75/:77）并登记 `launchedByUs`，但文本编辑这一步没有 ensure、没有 running 检查；TextEdit 没运行会被拉起，收尾只关 Notes/Calculator（:100 一带），可能把 TextEdit 留在前台/开着 |
| 11 | `core/tasks/parallel-real-demo.mjs:37,56` | 固定「计算器」「文本编辑」 | `ocu.call('get_app_state')` / `ocu.call('type_text')` | 双应用并行回显；两个应用没运行都会被拉起，任务结束也不关（与 multi-app 同一类） |

> 说明：#10 严格说是「同一任务里一处漏网」；其余 10 处是整条路径都缺前置检查。

## 2. 中危：刻意启动器（有收尾，但用户在场不该跑）

这些任务**故意**用 `ensureAppRunning/ensureAppWindow` 启动应用（这是它们的测试目标），并且大多只关「自己拉起的」。风险不是「偷偷启动」，而是「用户在场时启动窗口/抢前台」；矩阵/验收类命令在用户在场时必须禁跑。

| 位置 | 启动方式 | 收尾 | 备注 |
| --- | --- | --- | --- |
| `core/tasks/background-control.mjs:75,77` | `ensureAppRunning`（Notes/Calculator） | `launchedByUs` + `installEmergencyAppCleanup` + 结束 `quitApp` | 有用户空闲门禁（`shouldDeferForActiveUser`） |
| `core/tasks/background-stability.mjs:37-57` | `ensureAppWindow`（计算器/备忘录/文本编辑） | 结尾对 `launchedByUs` 逐个 `quitApp` | 有「轮次中不允许抢前台」判定 |
| `core/tasks/app-matrix.mjs:251,287,347` | `ensureAppRunning`（矩阵里的每个应用） | `MATRIX_QUIT≠0` 时 `quitApp` 自己拉起的 | 这是被 Lead 明令「用户在场禁跑」的命令 |
| `core/tasks/cold-launch.mjs:80` | `ensureAppRunning` | :69`/:90 附近 `quitApp` + `runningAfterCleanup` 校验 | 冷启动验收，必须独占 |
| `core/tasks/concurrent-demo.mjs:126,185` | `ensureAppRunning`（计算器）+ 独立 Chrome | `launchedByUs` 时 `quitApp` | 并发验收 |
| `core/tasks/user-chrome-demo.mjs:27,31,39` | `ensureUserChrome()` → `open -g -a Chrome` | **不关**（用户浏览器） | 显式启动用户 Chrome（若本来没开），任务语义就是「操作用户自己的 Chrome」；建议在输出里显式声明 `started=true`，并在文档写明它会启动 Chrome |
| `scripts/cleanup-test-data.mjs:132` | `ensureAppRunning`（Notes） | `launchedByUs` + `shouldQuitApp` | 有用户空闲门禁（`shouldRunNoteCleanup`） |
| `core/tasks/form-fill-local.mjs` | 自己 `spawn` 一个独立 Electron 宿主，再对它跑 ocu | `finally` 里 `child.kill` + 删临时目录 | 目标是自己拉起的宿主，不碰用户应用；安全 |

## 3. 根因层：raw 封装没有「运行前置条件」

| 位置 | 封装 | 现状 | 建议 |
| --- | --- | --- | --- |
| `core/agentd.mjs:133,138,149` | `ocu.snapshot / ocu.call / ocu.calls` | 直接走 CLI，调用方给什么应用就读什么 | 增加可选 `{ requireRunning: true }`（或新增 `snapshotIfRunning`），默认对「具名应用」先 `isAppRunning`，不通过就返回结构化跳过结果 |
| `core/background.mjs:232,239,249,258,267` | `state / find / click / setValue / typeText` | 直接 `mcp.callTool`，无运行检查 | 同上；或加 `{ requireRunning }` 参数并让所有任务显式选择 |
| `core/background.mjs:486,531` | `readSafe / findSafe` | 只处理「读之后前台被抢 + 还原」，**不处理读之前应用没运行**（启动已经发生，还原只能把前台还回去，应用还开着） | 在函数开头先 `isAppRunning`；未运行直接返回 `{ skipped: 'not-running', reason }`，不进入 `state` |
| `core/user-chrome.mjs:108,122,133,270,304` | `ensureUserChrome / readState / find / clickText / typeText` | `ensureUserChrome` 是显式启动（`open -g -a Chrome`），其余读写入口不检查 | 读写入口先 `isAppRunning({appName: CHROME_APP})`；未运行返回 skipped，由调用方决定是否 `ensureUserChrome` |

## 4. 证据：ocu 对未运行应用确实会启动

- `logs/runs/2026-11-08T08-08-16-233Z-multi-app.jsonl`：

~~~text
{"event":"line","text":"Finder         节点   108 | 前台 DeepSeek Harness → 计算器"}
{"event":"line","text":"Calculator     节点    37 | 前台 DeepSeek Harness → 计算器"}
{"event":"end","code":0,...}
~~~

  Calculator 当时没在运行（`isAppRunning` 为 false 才走到的 snapshot），结果被拉起且前台变成「计算器」；任务 end code=0（没有任何失败信号），应用也没被关。
- `core/tasks/coverage-probe.mjs:248-256` 的注释已经把这个行为写清楚了：
  「未运行（扫描非运行应用会把它启动起来，因此跳过；需要覆盖请先手动打开）」——这是本仓库里最早的正确认知。
- `core/tasks/multi-app.mjs` 本轮已修复为：先 `isAppRunning` → `shouldProbeApp({ running })` → 未运行记环境跳过，不再碰 ocu；并补了兜底 `cleanupUnexpectedLaunches`（只关「跑之前没在运行、跑之后却在运行」的）。
## 5. 统一修复建议

### P0：11 处高危调用点，先加「运行门禁」再碰 ocu

修复顺序（按用户可见影响排）：

1. `write-task.mjs:80` / `write-inner.mjs:38`（会发消息，副作用最大）
2. `drive-agent.mjs:85…`、`drive-agent-cli.mjs:72…`（会往应用里写内容/回车）
3. `user-active-demo.mjs:40…`、`terminal-control.mjs:48…`、`parallel-real-demo.mjs:37,56`（验证"不打扰"的任务自己先打扰了）
4. `scan.mjs:216,248`、`form-fill.mjs:266,276,292`、`mcp-demo.mjs:26`、`platform-demo.mjs:54`
5. `background-control.mjs:188`（给文本编辑补 ensure 或运行检查）

统一写法（建议抽公共函数，见 P1）：

~~~js
// 读取前
const running = await isAppRunning({ appName: APP, processName: APP, bundleId });
if (!running) {
  console.log('环境跳过：' + APP + ' 没在运行，不为了演示去启动/激活它');
  process.exitCode = 0;   // 或 return，按任务约定
  return;
}
// 只有确定在运行才进入 ocu.snapshot / callTool / cua.getApp
~~~

内层 `ocu js` 脚本（write-task/write-inner、scan、form-fill、platform-demo）**要在外层 Node 进程先判**：内层拿不到可靠的 isAppRunning，外层判完再决定要不要 `execFile(OCU, ['js', …])`。

### P1：根因层收口（防止以后又有人直接调）

建议在 `core/background.mjs`（已落地为独立模块 `core/app-presence.mjs`）加：

~~~js
// 纯逻辑，便于单测：running=undefined/false 一律按"别碰"处理
export function decideRead({ running } = {}) {
  if (running === true) return { read: true, reason: '' };
  return { read: false, status: 'skipped', reason: '没在运行，不为了演示去启动/激活它' };
}

export async function requireRunning(app) {
  const running = await isAppRunning(app).catch(() => false);
  return Object.assign({ running }, decideRead({ running }));
}
~~~

然后：

- `core/background.mjs:486 readSafe` / `:531 findSafe`：开头先 `requireRunning`，未运行返回 `{ skipped: 'not-running', reason }`，不进入 `state`；这能一次性覆盖所有用 `readSafe` 的任务（background-stability、app-matrix、terminal-control、drive-agent-cli、platform-demo 等）。
- `core/background.mjs:232-267 state/find/click/setValue/typeText`：加 `{ requireRunning = true }` 选项（默认 true），调用方要"刻意启动后操作"时显式传 `false` 或在外部先 `ensureAppRunning`。
- `core/agentd.mjs:133-149 ocu.snapshot/call/calls`：同样加 `{ requireRunning }` 或新增 `snapshotIfRunning(app)`；`call`/`calls` 里的应用名从参数里取，可复用同一判断。
- `core/user-chrome.mjs:122,133,270,304`：内部先 `isAppRunning({ appName: CHROME_APP })`，未运行返回 skipped（`ensureUserChrome` 保留为显式启动入口，调用方自己决定）。

### P2：显式启动器统一规范

`ensureAppRunning → if (launched) launchedByUs.push(...) → installEmergencyAppCleanup → 结束时只 quit launchedByUs`。
`background-control:75`、`background-stability:37`、`app-matrix:251`、`cold-launch:80`、`concurrent-demo:126` 已经是这个模式，可作为模板；
`user-chrome-demo:27` 属于"显式启动用户浏览器"，建议在输出/日志里明确 `started=true`，并保持"不关用户浏览器"（当前行为），同时在文档里写清它会启动 Chrome。

### P3：脚本层

- `scripts/bench-ocu.mjs:11,38,49`：`TARGET_APP` 默认 Chrome，读之前先 `isAppRunning`；未运行就只跑 `list_apps` 部分或直接报环境跳过。
- 编排类脚本（`apps-probe`、`bg-verify`、`live-verify`、`soak`、`verify-safe`、`monitor`、`humanize-live`）：它们不直接读应用，但会跑任务/验收；建议在用户在场时默认只跑 "safe" 子集（现有 `verify-safe` 已是这个思路，可扩展）。
- `cleanup-test-data` 保持现状（已有用户空闲门禁 + launchedByUs）。

### P4：静态回归检查（防再次出现）

建议把规则加进 `scripts/safety-audit.mjs` 或 CI：

> 对 `core/tasks/*.mjs`、`core/*.mjs`、`scripts/*.mjs` 里每一个 "对具体应用调用 ocu" 的位置
> （`ocu.snapshot(`、`ocu.call(`、`callTool('get_app_state'|'query'|'click'|'type_text'|'set_value'`、`readSafe(`、`state(`、`find(`、`cua.getApp(`），
> 要求同文件内出现 `isAppRunning` / `ensureAppRunning` / `ensureAppWindow` / `requireRunning` 之一，
> 或该行带显式豁免注释 `// audit-ok: <理由>`；否则报告失败。

这条规则能把本次的高危清单变成"常驻测试"，而不是一次性人工审计。

### P5：单测建议（纯逻辑，不碰应用）

- `decideRead({running:true/false/undefined})` 三分支；
- 各任务抽出的 `shouldProbeApp` 式纯函数（`multi-app.mjs` 已有，`test/multi-app.test.mjs` 已覆盖，可复制模式）；
- 若引入静态检查脚本，用 2 个 fixture 文件测「有检查放行 / 无检查报错」；
- 不给真实应用写字/点击的路径一律不进单测。

### P6：文档建议（Lead 统一改）

在 `docs/SECURITY.md` 或 flow 里补一条硬约束：

> **ocu 对未运行的应用调用读取接口会把它启动并顶到前台**；任何对具体应用的 raw 读取（snapshot/get_app_state/query/state/find/readSafe）之前，必须先 `isAppRunning`；未运行一律环境跳过，不允许"为了演示"启动应用；需要启动的验收任务必须 `ensureAppRunning` + 登记 `launchedByUs` + 结束 `quitApp`，并且用户在场时默认跳过。

## 6. 逐文件清单

### 6.1 core/tasks/*.mjs（32 个）

| 文件 | 对具体应用调 ocu？ | 运行检查 | 结论 |
| --- | --- | --- | --- |
| app-matrix.mjs | 是（`ensureAppRunning:251` → `readSafe:287`） | 有（先 ensure） | 中：刻意启动器 + `quitApp:347`，用户在场禁跑 |
| applescript-channel.mjs | 否（只用 `isAppRunning:79`） | 有 | 安全 |
| background-control.mjs | 是（Notes/Calc 已 ensure；文本编辑 `find:188` 没 ensure） | 部分 | **高**（文本编辑漏网） |
| background-stability.mjs | 是（`ensureAppWindow:50`） | 有 | 中：刻意启动 + 结尾 quit |
| candidates.mjs | 否（无 ocu 读取） | — | 安全 |
| write-task.mjs | 是（内层 `ocu js:80` → `write-inner:38 getApp`） | 无 | **高** |
| scan-dedicated.mjs | 否（专用 profile 离屏 Chrome） | — | 安全（不碰用户窗口） |
| scan.mjs | 是（`snapshot:216,248`） | 无 | **高** |
| browser-background.mjs | 否（CDP 浏览器） | — | 安全 |
| browser-demo.mjs | 否（CDP 独立 profile） | — | 安全 |
| cdp-channel.mjs | 否（自己 spawn headless Chrome + CDP） | — | 安全 |
| cdp-driver.mjs | 否（启动第三方 Electron 应用，非 ocu，`launchWithDebug`） | 有（`expectedPid` 校验） | 中：显式启动器 + quit，用户在场禁跑 |
| cold-launch.mjs | 是（`ensureAppRunning:80`） | 有 | 中：刻意启动 + quit |
| concurrent-demo.mjs | 是（`ensureAppRunning:126`） | 有 | 中：刻意启动 + quit |
| coverage-probe.mjs | 是（`snapshot:158,266`） | 有（`:248 !item.running → 跳过`） | **安全（模板）** |
| drive-agent-cli.mjs | 是（`readSafe:72`、`callTool:105,110`） | 无 | **高** |
| drive-agent.mjs | 是（`callTool:85,91,98,102,113`） | 无 | **高** |
| electron-demo.mjs | 否（自建离屏宿主 + CDP） | — | 安全 |
| form-fill-local.mjs | 是（对自己 spawn 的宿主） | 显式启动（自建宿主） | 安全（`finally` 杀宿主） |
| form-fill.mjs | 是（`runOcuJs:266,276,292`） | 无 | **高** |
| write-inner.mjs | 是（内层 `cua.getApp:38`） | 无 | **高**（由 write-task 驱动） |
| write-verify.mjs | 否（专用 profile Chrome，读消息列表） | — | 安全 |
| headless-demo.mjs | 只用 `ocu call list_apps` 读前台 | — | 安全（不针对应用） |
| human-demo.mjs | 否（独立浏览器 + CDP） | — | 安全 |
| mcp-demo.mjs | 是（`get_app_state:26`，默认 Chrome） | 无 | **高** |
| multi-app.mjs | 是（`ocu.snapshot`），但已加 running 门禁 | 有（本轮修复） | 安全（模板） |
| parallel-demo.mjs | 否（CDP） | — | 安全 |
| parallel-real-demo.mjs | 是（`ocu.call:37,56`，固定计算器/文本编辑） | 无 | **高** |
| platform-demo.mjs | 是（`ocuState:54`，默认 Chrome） | 无（只有 front-risk/锁屏） | **高** |
| terminal-control.mjs | 是（`readSafe:48`、`find:64`、`typeText:72`、`state:81`） | 无 | **高** |
| user-active-demo.mjs | 是（`state/find/click:40,41,45,55,59,66,67`） | 无 | **高** |
| user-chrome-demo.mjs | 是（`ensureUserChrome:27` → `readState:31`/`find:39`） | 显式启动 Chrome | 中-高：会启动用户 Chrome，任务结束不关 |

### 6.2 core 模块

| 文件 | 角色 | 结论 |
| --- | --- | --- |
| agentd.mjs:119-149（ocu.*） | raw CLI 封装 | 根因层：无运行前置条件 |
| background.mjs:232-267（state/find/click/setValue/typeText） | raw MCP 封装 | 根因层：无运行前置条件 |
| background.mjs:486,531（readSafe/findSafe） | 带前台保护的读取 | 只防"读之后抢前台"，不防"读之前被启动" |
| user-chrome.mjs:108-304 | Chrome 专用封装 | `ensureUserChrome` 显式启动；读写入口无检查 |
| driver-resolution.mjs:84-90 | 通道协商 | 安全示例：先 `running` 再 `readSafe` |
| ocu-mcp.mjs:165（getOcuMcp） | 传输层 | 中立；可在 `callTool` 层做应用名白名单/运行检查（影响面大，需单独设计） |
| browser.mjs | 独立 profile Chrome | 安全（不碰用户实例） |
| humanize.mjs / human.mjs | 轨迹与节奏 | 安全（纯逻辑） |

### 6.3 scripts/*.mjs（31 个）

| 文件 | 结论 | 说明 |
| --- | --- | --- |
| bench-ocu.mjs | **高** | `:11` 默认 Chrome，`:38/:49 get_app_state` 无运行检查 |
| cleanup-test-data.mjs | 中 | `:132 ensure Notes`，有用户空闲门禁 + `launchedByUs` |
| apps-probe.mjs / bg-verify.mjs / live-verify.mjs / soak.mjs / verify-safe.mjs / monitor.mjs / humanize-live.mjs | 中 | 编排脚本：spawn 任务/验收，继承任务风险；用户在场时只该跑 safe 子集 |
| restart-check.mjs / start-all.mjs / ui-gallery.mjs | 中 | 会启动/重启服务或小窗（不是用户应用），操作前应确认用户不在 |
| app-resolve.mjs | 安全 | `readSafe` 只在应用 running 时才走（driver-resolution:84-90） |
| app-inventory.mjs / app-runtime.mjs | 安全 | 只扫 bundle/静态识别 |
| check-ocu.mjs / bundle-ocu.mjs / export.sh | 安全 | 版本/打包 |
| env-doc.mjs / tasks-doc.mjs / repo-check.mjs / safety-audit.mjs / syntax-check.mjs | 安全 | 纯文档/静态检查 |
| fps-check.mjs / trends.mjs / prune.mjs / front-risk.mjs / health.mjs | 安全 | 指标/日志/风险名单/服务探活（health 只跑 `ocu doctor`） |
| ui-check.mjs / ui-regression.mjs | 安全 | 只操作 overlay 小窗显隐/截图 |
| session-scope-check.mjs | 安全 | 只读会话/接口 |

## 7. 审计边界

- 只读审计：没有启动/激活任何应用，没有跑任何任务本体（屏幕锁屏，且 Lead 明令禁止）；结论基于代码路径 + 历史日志/注释，不是运行时复现（multi-app 事故与 coverage-probe 注释已证明机制）。
- 未审计 ocu 自身实现（第三方），"未运行应用会被启动"来自实测事故与仓库内注释，不再重复验证。
- 未覆盖 Windows UIA 后端（`core/backends/uia.mjs` 的 snapshot 是否也启动应用未验证，本次只审 ocu/macOS 路径）。
- `ocu js` 内层脚本只审到已知入口（write-task/write-inner、scan、form-fill、platform-demo）；内层脚本自身没有运行检查，因此外层门禁是必须的。
- 行号对应当前工作区版本；其他成员并行改动可能移动行号，修复时以函数名为准。

## 8. 修复状态（2026-11-08 收尾）

> 结论：第 1 节 11 处高危调用点**已全部加上运行门禁**，门禁统一抽到 `core/app-presence.mjs`
> （纯函数 `decideAppPresence` + 注入 `isAppRunning` 的 `requireAppRunning`/`reportAppPresence`，
> 判定失败一律按「没在运行、不要碰」处理，fail-closed）。逐项单测：`test/app-presence.test.mjs`、
> `test/task-app-presence-gate.test.mjs`；任务级 `test/user-active-demo-preflight.test.mjs`、
> `test/parallel-real-demo-guard.test.mjs`。

| # | 位置 | 修复 | 证据 |
| --- | --- | --- | --- |
| 1 | `core/tasks/user-active-demo.mjs` | 候选应用必须**本来就在运行**才挑（`pickRunningCandidates`），一个都没跑就环境跳过；不再自动启动 | `test/user-active-demo-preflight.test.mjs` |
| 2 | `core/tasks/terminal-control.mjs` | 入口 `requireAppRunning`，未运行环境跳过（exit 0），不进入 `readSafe/find/typeText` | `test/task-app-presence-gate.test.mjs` |
| 3 | `core/tasks/drive-agent.mjs` | 同上，目标 agent 没运行不驱动、不写提示词 | 同上 |
| 4 | `core/tasks/drive-agent-cli.mjs` | 同上（CLI 类目标） | 同上 |
| 5 | 原扫描任务（已移除） | 移除前已加 `requireAppRunning` 门禁 | — |
| 6 | `core/tasks/form-fill.mjs` | 入口门禁，未运行就不跑内层 `ocu js` | 同上 |
| 7 | 原写类任务（已移除） | 移除前已加入口门禁 | — |
| 8 | `core/tasks/mcp-demo.mjs` | 入口门禁后再 `get_app_state` | 同上 |
| 9 | `core/tasks/platform-demo.mjs` | 入口门禁，未运行不 `ocuState` | 同上 |
| 10 | `core/tasks/background-control.mjs` | 「文本编辑」步骤先 `isAppRunning`，没运行记为跳过（不再 `find` 触发拉起）；备忘录/计算器仍是显式启动 + `launchedByUs` | `test/task-app-presence-gate.test.mjs` |
| 11 | `core/tasks/parallel-real-demo.mjs` | 双应用逐个 `isAppRunning`，只对已运行应用回显；都不在运行就环境跳过 | `test/parallel-real-demo-guard.test.mjs` |
| 脚本 | `scripts/bench-ocu.mjs` | 默认先查运行状态，未运行只跑无应用部分；要测冷读必须显式 `--allow-launch` | `test/task-app-presence-gate.test.mjs` |
| 模板 | `core/tasks/multi-app.mjs` | 本轮最早修复（`shouldProbeApp` + `cleanupUnexpectedLaunches`），其余任务按它的口径对齐 | `test/multi-app.test.mjs` |

其余各条进度：

- **P1 根因层**：已落地 `core/app-presence.mjs`，并让 11 处调用点显式走它；`readSafe/findSafe`、
  `agentd.ocu.*`、`user-chrome` 的**默认**门禁没有直接改成「没运行就跳」——那会把「刻意启动器」
  （ensure 之后才读）也一起挡掉，属于破坏性改动。当前口径是：调用点显式门禁 + 静态检查兜底（见 P4）。
- **P2 显式启动器**：`user-chrome-demo` 输出已带 `started`，文档写清它会 `open -g -a Chrome`；
  其余启动器维持「`ensureAppRunning` → 登记 `launchedByUs` → 应急清理 → 只关自己拉起的」。
- **P3 脚本层**：`bench-ocu` 已门禁（上表）；编排脚本继承任务门禁，另由 `verify:safe` 兜「不碰屏幕」子集。
- **P4 静态回归检查**：已完成——`core/safety-audit.mjs` 新增规则 5（`raw-ocu-without-presence-gate`）：
  对具体应用调 ocu（`ocu.snapshot/ocu.call`、`callTool('get_app_state|query|click|type_text|set_value')`、
  `readSafe/findSafe/state/find/click/typeText/setValue`、`cua.getApp`）时，同文件必须有
  `isAppRunning/ensureAppRunning/ensureAppWindow/requireAppRunning` 之一，或本行/紧邻上一行有
  `// audit-ok: <理由>`；根因层与 CDP/AppleScript 通道、内嵌 JXA 脚本文本共 14 条文件级白名单（每条写理由）。
  扫描范围扩到 `core/tasks` + `core/*.mjs` + `scripts`：**120 个文件 / 103 处调用点 / 0 违规**；
  规则非空转（命中数下限断言）与白名单防腐烂都有单测。顺带修了 open 规则的误判（`this.state = 'open'`），
  并把「打开系统设置隐私面板」列为显式例外（必须可见、由用户手动授权）。
- **P5 单测**：已补 4 个测试文件（见上）；纯逻辑、不碰真实应用。
- **P6 文档**：已完成——`docs/SECURITY.md` 加了硬约束（「不为了读一个应用把它启动起来」：raw 读取前必须
  `isAppRunning` / `requireAppRunning`，未运行一律环境跳过，不允许「为了演示」启动，唯一启动路径是显式启动器四件套）；
  `docs/MAC-APPS.md` 第 9 条同步并指向本文。

### 8.1 修复边界（防止「修成新的洞」）

- 门禁失败一律 `exit 0 + 环境跳过`，不抛异常、不算 FAIL：环境不具备（应用没开）不是产品缺陷。
- 门禁**只跳过、不启动**：修复后的路径里没有任何「为了通过测试而 `open`/`ensureApp`」的新增调用。
- 只认「已在运行」，不认「也许马上会运行」：`isAppRunning` 抛错/超时按 `false` 处理（fail-closed）。
- 不改用户应用状态：跳过路径不 quit、不 hide、不写数据、不改前台。
- 跳过的任务在输出里必须留一行「环境跳过：<应用> 没在运行，不为了测试去启动/激活它」，便于日志审计。

