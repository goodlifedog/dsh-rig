# 权限安全审计：通道 → TCC 权限矩阵、预检现状与 fail-closed

> 生成时间：2026-11-08 · 审计人：human-input（只读审计）
> 范围：`core/`、`overlay/`、`scripts/`、`docs/`、`third_party/open-computer-use/`（含二进制字符串只读分析）
> 纪律：**本审计没有执行任何会触发 TCC 弹窗的命令**——没有用 osascript 控制新应用、没有 screencapture、没有 tccutil、
> 没有跑 acceptance / matrix / 任何任务本体；所有结论来自读代码、只读的 `strings`/`nm` 与纯函数调用（`core/run-classify.mjs`）。
> 相关文档：`docs/SECURITY.md`（安全边界）、`docs/USAGE.md` 4.4 节（用户视角的权限说明）、`flow/OCU-CALL-AUDIT.md`（拉起未运行应用的审计）。
> **修复状态（2026-11-08 收尾）**：H1/H3/H4/H5 + M1/M2 已修复并提交；H2 做了核心项（前台读取不再发 AppleEvent）
> 与三个清理脚本的预检，剩余少量裸 AppleEvent 入口记为待办。逐项证据见文末第 7 节。

## 0. 结论摘要

1. **没有任何权限闸门接在任务执行前（高）**：唯一的统一预检 `core/permissions.mjs:48 checkPermissions()` 只被
   `scripts/health.mjs:133-138` 调用；`core/runner.mjs`、`core/daemon.mjs`、`core/acceptance.mjs` 都不查。
   缺权限时任务照跑，最终表现取决于各条通道自己的报错文本。
2. **权限缺失会被判成「真失败」而不是「环境跳过」（高）**：`core/run-classify.mjs:45` 的 HARD_FAIL 优先于环境规则，
   且 `ENV_RULES`（:7-24）不认 ocu 的英文报错、也不认「缺辅助功能权限」这种措辞。
   纯函数实测（无副作用）：`envSkipReason('Accessibility permission is required…') === ''`；
   `classifyRun('…缺辅助功能权限…' + 失败结束行) === { failed: true, envSkip: false }`。
3. **多处裸 osascript 会在用户不知情时弹「自动化」授权框（高）**：`core/background.mjs:83 frontName()` 是所有后台 helper
   的第一步（`state/find/click/setValue/typeText` 前后各一次），它直接对 System Events 发 AppleEvent；此外
   note-cleanup、sync-quit、acceptance、browser、headless-demo、dialog-guard 都各自直连 AppleEvent，没有预检。
4. **Safari JS 探针会拉起 Safari、并可能弹授权框（高）**：`core/applescript-driver.mjs:81 checkSafariJavaScript()`
   直接 `tell application "Safari" …`（AppleScript 的 tell 语义会启动未运行的应用），而
   `core/tasks/applescript-channel.mjs:112` **无条件**调用它，既没有 isAppRunning，也没有自动化预检。
5. **daemon 自检把「自动化」误报成「辅助功能」（高）**：`core/daemon.mjs:66` 的探针是
   `osascript … tell application "System Events" …`（自动化权限），`:74/:78` 却把它命名成 `axOk`，并提示用户去
   「辅助功能」设置页——用户按提示授权后仍然不通。
6. **屏幕录制没有任何预检（中）**：`overlay/main.js:80/1196/1221`、`overlay/platform.js:56` 直接跑 screencapture；
   只有失败后的中文/英文关键字映射（`overlay/main.js:1082-1097`）。无权限时 CGWindowList 的窗口标题会**静默为空**
   （`overlay/main.js:1511`），小窗按标题匹配失败，而不是报权限问题。

**正面（已 fail-closed）**：自动化预检用 `AEDeterminePermissionToAutomateTarget(askUserIfNeeded=false)` 静默查、未授权绝不发 AppleEvent
（`core/applescript-driver.mjs:22-35, 208-220`）；权限弹窗绝不代点（`core/dialog-guard.mjs:59-96`）；
锁屏检测（ioreg）和进程表（ps）不碰 TCC；`ocu doctor --json` 明确不会启动 onboarding（二进制字符串：
`"--json prints a permission snapshot without launching onboarding (macOS only)."`），我们只用了 `--json`。

## 1. 通道 → TCC 权限矩阵

TCC 服务名：`kTCCServiceAccessibility`（辅助功能）、`kTCCServiceAppleEvents`（自动化，按「发起方 → 目标 app」成对授权）、
`kTCCServiceScreenCapture`（屏幕录制）。「授权主体」不是唯一的——同一个进程由谁启动，TCC 记账对象就不同。

| # | 通道 | 代码入口（文件:行） | 需要的 TCC 权限 | 授权主体（谁被授权） | 缺权限时的实际表现 | fail-closed? |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | AX 读界面树（ocu snapshot / get_app_state / query） | `core/agentd.mjs:133,138,149`、`core/background.mjs:279,294` | 辅助功能 | `Open Computer Use.app`（ocu 原生运行时）；daemon 场景可能落在 node（`core/daemon.mjs:78` 的提示就是让把 `process.execPath` 加进去） | ocu 返回错误文本：`Accessibility permission is required. Run \`open-computer-use doctor\` …`（二进制字符串）；由上层自行翻译 | 否：没有闸门，错误文本原样上浮 |
| 2 | 语义动作（click / set_value / perform_secondary_action / select_text） | `core/background.mjs:311,327,1023`、`core/user-chrome.mjs:254` | 辅助功能 | 同上 | 工具返回 isError；部分工具的失败被 `toolFailureText`（`core/background.mjs` 900 行附近）兜底识别 | 部分 |
| 3 | 后台键盘 / 点击合成（sky_key / sky_click / app_post） | `core/user-chrome.mjs:304`、`core/background.mjs:343` | 辅助功能（CGEvent / SkyLight 事件投递） | 同上 | 键不进、点击无效，或工具报错 | 否 |
| 4 | 自动化控制别的应用（AppleScript / JXA 注入） | 有预检：`core/applescript-driver.mjs:208 runAppScript`；裸调用：见第 3 节清单 | 自动化（每个目标 app 一条授权） | 发起 AppleEvent 的进程（node / 终端 / Electron / 打包 App） | `-1743 denied` / `-1744 needs-consent`；**首次可能弹系统授权框** | 仅 `runAppScript` 一处 fail-closed |
| 5 | 对 System Events 发 AppleEvent（前台/窗口/弹窗/激活） | `core/background.mjs:83,847,948,1023`、`overlay/platform.js:32,39,46`、`core/acceptance.mjs:133,144,192,201,230`、`core/browser.mjs:265,313` | 自动化（System Events 是独立目标） | 同上 | 读不到前台/窗口（各调用点 catch 后返回空串/失败），**首次可能弹授权框** | 否（全部靠 catch 静默） |
| 6 | 截图 / 按窗口抓图（screencapture） | `overlay/main.js:80,1196,1221`、`overlay/platform.js:56`、`scripts/ui-gallery.mjs:30,86`、`scripts/ui-check.mjs:44` | 屏幕录制 | 启动小窗的进程（Electron / Desktop Agent.app / 终端） | 黑图或 screencapture 报错；**首次会弹系统授权框** | 否：只在失败后映射文案（`overlay/main.js:1082-1097`） |
| 7 | CGWindowList 窗口列表与标题 | `overlay/main.js:1493-1518`（osascript -l JavaScript + ObjC，无 AppleEvent 目标） | 列表不需要；**窗口标题需要屏幕录制** | 同上 | 无权限时 `kCGWindowName` 为空串 → 标题匹配静默失败 | 否 |
| 8 | ocu 截图（`include_screenshot: true`） | `core/user-chrome.mjs:69,76`（默认被坐标点击策略拒绝，需显式 allowScreenshot） | 屏幕录制（由 ocu 侧申请） | `Open Computer Use.app` | 图片缺失 → `ensureScreenshot` 抛错 | 部分（调用方有护栏） |
| 9 | CDP（headless Chrome 调试端口） | `core/browser.mjs`、`core/cdp.mjs` | **无 TCC** | — | 只受端口/令牌约束 | 不适用 |
| 10 | 进程表 / 锁屏探测 | `core/platform.mjs:80-90`（ioreg）、`core/foreground-guard.mjs`（ps） | **无 TCC** | — | — | 不适用 |
| 11 | 全局指针兜底（可选） | ocu 侧 `OPEN_COMPUTER_USE_ALLOW_GLOBAL_POINTER_FALLBACKS=1` | 辅助功能 | ocu | 会移动用户真实指针 | 默认关闭 |

## 2. 现有权限预检清单

| 预检函数 | 文件:行 | 查什么 | 怎么查（会不会弹框） | 被谁用 | 单测 |
| --- | --- | --- | --- | --- | --- |
| `checkPermissions()` | `core/permissions.mjs:48` | 辅助功能 + 屏幕录制 | `ocu doctor --json`（`:12,:21`）——**不启动 onboarding**（二进制字符串明确） | 仅 `scripts/health.mjs:135` | **无** |
| `runOcuDoctor()` | `core/permissions.mjs:7` | 同上 | spawn ocu doctor，解析 `accessibilityTrusted/screenCaptureGranted/allGranted`（:53-55） | 同上 | 无 |
| `openPermissionSettings(which)` | `core/permissions.mjs:40` | 打开系统设置页 | `open x-apple.systempreferences:…` | **无调用方（死代码）** | 无 |
| `checkAutomationPermission(app)` | `core/applescript-driver.mjs:152` | 单个 app 的自动化授权 | 编译小 C 程序（`:22-35`）调 `AEDeterminePermissionToAutomateTarget(..., false)`——**askUserIfNeeded=false，不弹框** | `core/tasks/applescript-channel.mjs:86`、`scripts/app-resolve.mjs:95` | 有：`test/applescript-driver.test.mjs:97-108` |
| `runAppScript()` | `core/applescript-driver.mjs:208` | 发事件前预检，未授权不发 | 同上 | `core/tasks/applescript-channel.mjs:96` | 有：`test/applescript-driver.test.mjs:110-166` |
| `parseAeStatus()` / `classifyOsascriptError()` | `core/applescript-driver.mjs:38,49` | 状态码/报错分类（纯函数） | — | 上述两处 | 有：`test/applescript-driver.test.mjs:16,25` |
| `classifyDialog()` / `classifyDialogWithButtons()` | `core/dialog-guard.mjs:59,86` | 识别权限弹窗（纯函数） | — | `scanOnce` | 有：`test/dialog-guard.test.mjs:5,28,33,43` |
| `checkSafariJavaScript()` | `core/applescript-driver.mjs:81` | Safari 页面 JS 通道 | **裸 osascript（无预检、可能弹框/拉起 Safari）** | `core/tasks/applescript-channel.mjs:112` | 只有错误分类测试：`test/applescript-driver.test.mjs:169-188` |
| `selfTest()` | `core/daemon.mjs:64` | System Events + ocu list_apps | osascript（**会触发自动化授权**），结果被叫成 `axOk`（:74,:78） | `/selftest` 路由（:426）← `scripts/health.mjs:59` | **无** |
| `explainCaptureError()` | `overlay/main.js:1082` | 抓图错误归类 | 错误文本 | `captureThumbnail` | **无（内联在 main.js，不可单独 import）** |
| 缺 AX 时环境跳过 | `core/tasks/headless-demo.mjs:236-249` | 读窗口数为 null → 标环境跳过 | 运行时判断 | 自己 | 间接 |

## 3. fail-closed 审查

### 3.1 高危

#### H1 没有权限闸门接在任务执行前

- **证据**：`core/permissions.mjs:48` 是唯一统一预检；全仓引用只有 `scripts/health.mjs:133-138`。
  `core/runner.mjs`、`core/daemon.mjs`、`core/acceptance.mjs` 都不调用它。
- **后果**：缺辅助功能/屏幕录制时，acceptance 会照常跑一轮，把每个任务失败都记成「真实失败」（见 H4），
  用户看到的是「13 项里失败 11 项」，而不是「请先授权」。
- **触发条件**：换机器、重装系统、重新打包 App（TCC 记录绑定 bundle id/签名）后第一次跑验收。
- **建议补丁**：在 `core/runner.mjs` 的 `run`（任务启动处）或 `core/daemon.mjs` 的任务出队前加一次
  `checkPermissions()` 门禁：缺失 → 打印「环境跳过：缺 <权限>，去系统设置 → 隐私与安全性 → <面板>」并 exit 0。
  任务可以声明自己需要哪些权限（例如只读任务只需辅助功能，小窗相关才需要屏幕录制），避免把屏幕录制缺失
  也算到纯 AX 任务头上。
- **测试**：现状 **0 覆盖**（`core/permissions.mjs` 没有测试文件）。

#### H2 裸 osascript 会在用户不知情时弹「自动化」授权框

- **证据**（无预检、直连 AppleEvent 的调用点）：
  - `core/background.mjs:83` `frontName()`——被 `state(:279)/find(:294)/click(:311)/setValue(:327)/typeText(:343)/readSafe(:566)/findSafe(:623)/windowCount(:837)/dialogs(:944)` 前后调用，几乎是所有后台操作的第一步；
    `:847`（count windows）、`:948`（弹窗结构）、`:1023`（点弹窗按钮）也是 System Events。
  - `core/note-cleanup.mjs:89,149,259`——直接控制 Notes（`tell application "Notes"`），没有自动化预检；`countNotes` 还会重试 3 次（`:86-96`）。
  - `core/sync-quit.mjs:96`、`core/tasks/cold-launch.mjs:32`——`tell application X to quit`，在信号/应急清理路径上，缺权限时既弹不了框也会静默失败。
  - `core/acceptance.mjs:133,144,192,201,230`、`core/browser.mjs:265,313`、`core/tasks/headless-demo.mjs:42,61`、`overlay/platform.js:32,39,46`——都是 System Events。
- **后果**：macOS 对「未授权的 (发起方 → 目标) 对」会在第一次发 AppleEvent 时弹系统授权框（或对 launchd 服务直接返回 -1743）。
  这正好违反项目红线「不许在用户不知情时弹授权框」。daemon（launchd）身份下弹框归属还可能是 node/父进程，用户根本不知道该授权谁。
- **触发条件**：新机器/新打包 App 第一次跑任何用到 `frontName()` 的任务；第一次跑 note-cleanup；第一次 quit。
- **建议补丁**：
  1. `core/background.mjs:81-90` 的 `frontName()` 加一个「已探测过自动化」的进程内标志：第一次调用前先用已有能力静默探测
     （System Events 没有 bundle id 可查，可用 `runAppScript` 发一条无副作用脚本并捕获 -1743/-1744 归类，但这一步本身就会触发一次 AppleEvent——
     更稳的是用 `osascript -l JavaScript` + ObjC 读 `NSWorkspace.frontmostApplication`，完全不走 AppleEvent）；
     失败时把状态记成 `automation-denied`，后续所有调用直接返回该状态，不再反复触发。
  2. `core/note-cleanup.mjs:89,149,259`、`core/sync-quit.mjs:96`、`core/tasks/cold-launch.mjs:32` 前置 `checkAutomationPermission({bundleId})`
     （`core/applescript-driver.mjs:152`，静默、不弹框），未授权就打印「环境跳过：未授权自动化」并跳过。
- **测试**：`frontName()` 无单测；note-cleanup 有安全测试（`test/note-cleanup-safety.test.mjs`）但没有权限分支。

#### H3 Safari JS 探针无条件调用，可能拉起 Safari + 弹授权框

- **证据**：`core/applescript-driver.mjs:81-91` `checkSafariJavaScript()` 直接 `osascript -e 'tell application "Safari" to do JavaScript "1+1" in front document'`；
  `core/tasks/applescript-channel.mjs:112` 在 rows 循环**之后无条件**调用（注释只说「不影响判定」），没有 isAppRunning，也没有 `checkAutomationPermission`。
- **后果**：AppleScript 的 `tell application X` 在 X 未运行时会**启动它**（与 `flow/OCU-CALL-AUDIT.md` 里那批 P0 同类），
  同时第一次会弹「终端/Desktop Agent 想要控制 Safari」授权框。任务说明里写着「不影响通过/失败判定」，但副作用已经发生了。
- **建议补丁**：`core/tasks/applescript-channel.mjs:112` 改条件调用：
  `if (await isAppRunning({ appName: 'Safari', bundleId: 'com.apple.Safari' }))` + `checkAutomationPermission({bundleId:'com.apple.Safari'})` 通过后才探测；
  否则打印「环境跳过：Safari 没在运行/未授权自动化，不探测 Apple Events 注入」。
  也可把预检下沉到 `checkSafariJavaScript` 内部（加 `isRunning`/`checkPermission` 注入参数）。
- **测试**：`test/applescript-driver.test.mjs:169-188` 只测错误文本分类，没有「未运行/未授权就不调用 exec」的用例。

#### H4 权限缺失被归成「真失败」而不是「环境跳过」

- **证据**：`core/run-classify.mjs:45` `HARD_FAIL = /❌|未送达|存在失败项|(^|\n)[ \t]*FAIL\b/`，`:50` 先判 HARD_FAIL 再走 ENV_RULES；
  `ENV_RULES`（`:7-24`）只有中文模式（`/读不到 .*界面树|没有辅助功能权限/`，`:12`）。
  纯函数实测（本审计执行，无副作用）：

  ```text
  envSkipReason("Accessibility permission is required. Run \`open-computer-use doctor\` …")  ->  ""
  envSkipReason("[!] 读不到窗口数（后台服务缺辅助功能权限）")                       ->  ""   // 「缺」≠「没有」
  classifyRun("FAIL: 读不到 Google Chrome 的界面树（应用没运行或没有辅助功能权限）\n{…code:1}") -> {failed:true, envSkip:false}
  classifyRun("[!] 读不到窗口数（后台服务缺辅助功能权限）\n{…code:1}")              -> {failed:true, envSkip:false}
  ```

- **后果**：
  1. ocu 的英文权限报错（`Accessibility permission is required…`）→ 真实失败；
  2. `headless-demo.mjs:244` 的 `读不到窗口数（后台服务缺辅助功能权限）` → 真实失败（措辞是「缺」，规则写的是「没有」）；
  3. 任务自己用 `FAIL:` 前缀报权限问题（如 `platform-demo.mjs:67` 抛错后 main catch 打印 `FAIL: …`）→ HARD_FAIL 优先，真实失败。
- **建议补丁**：
  - `core/run-classify.mjs:12` 规则扩成 `/读不到 .*界面树|读不到窗口数|(没有|缺少?)辅助功能权限|Accessibility permission|Screen Recording permission|not authorized.*Apple\s?events/i`；
  - 或者在 `:50` 之前加一条「权限缺失」硬例外：命中权限字样时不走 HARD_FAIL 豁免，而是 `envSkip:true`（权限缺失永远不是代码失败）。
  - 收敛任务输出措辞：统一打「环境跳过：缺辅助功能权限…」，别用 `FAIL:`。
- **测试**：`test/run-classify.test.mjs` 有 16 条用例，但**没有一条覆盖权限缺失文本**（中英文都没有）。

#### H5 daemon 自检把「自动化」误报成「辅助功能」

- **证据**：`core/daemon.mjs:66` `checks.systemEvents = probe(osascript, ['-e','tell application "System Events" to count processes'])`；
  `:74` `const axOk = checks.systemEvents.ok`；`:78` `hint: axOk ? '' : '后台服务缺少辅助功能权限：…把 <node> 加进去'`。
  这条 hint 会经 `/selftest`（`:426`）→ `scripts/health.mjs:59-66` 显示给用户。
- **后果**：用户真正缺的是「自动化 → System Events」时，被指引去「辅助功能」面板加 `node`，加了也没用；
  反过来缺辅助功能（AX）时这条探针（自动化）可能正常，于是健康面板不报错，任务却全读不到 AX。
- **建议补丁**：`selfTest()` 拆成三块分别报告：`accessibility`（用 `ocu doctor --json` 的 `accessibilityTrusted`）、
  `screenCapture`（`screenCaptureGranted`）、`automation`（这条 System Events 探针，或 `checkAutomationPermission` 对 System Events 的 bundle id `com.apple.systemevents`），
  `hint` 按缺失项分别给设置页。
- **测试**：`selfTest` **0 覆盖**；建议抽成纯函数 `classifySelfTest({accessibility, screenCapture, automation})` 后补测。

### 3.2 中危

#### M1 屏幕录制无预检，首次抓帧会弹系统授权框

- **证据**：`overlay/main.js:80` `SCREENSHOT_CMD=/usr/sbin/screencapture`，`:1196` `captureThumbnail` 直接 exec（`:1221`）；
  `overlay/platform.js:56` 同样。没有 `CGPreflightScreenCaptureAccess` 类预检（全仓 grep 为 0）。
  错误映射只在事后（`:1082-1097`），且靠中英文关键字。
- **后果**：小窗第一次绑定被控窗口（`POST /window` 之后自动抓帧）就会触发「想要录制屏幕」系统框——
  这个时机用户往往不在电脑前（daemon 自动跑任务），弹框会一直挂着。
- **建议补丁**：抓帧前先跑一次只读预检（例如用 overlay 自带的 `ocu doctor --json` 解析，或封装一个
  `osascript -l JavaScript` + `CGPreflightScreenCaptureAccess` 的小调用，后者不会弹框）；未授权时直接把会话标成
  `no-permission`，UI 显示「需要屏幕录制权限」并给设置按钮，不启动 screencapture。
- **测试**：`explainCaptureError` 无测试（内联不可 import）；建议抽出 `classifyCaptureFailure(stderr)` 纯函数。

#### M2 无屏幕录制时窗口标题静默为空 → 匹配失败而不是报权限

- **证据**：`overlay/main.js:1511` 用 `kCGWindowName` 当标题；macOS 在无屏幕录制权限时该字段为空。
  小窗的「宿主窗口/被控窗口」匹配（`:1533-1550`）与健康面板的 `画面` 判定（`scripts/health.mjs:127-131`）都依赖标题/帧。
- **后果**：表现为「找不到窗口 / 画面 error」，用户按「窗口没了」去排查，实际是权限。属于「静默拿到错数据」。
- **建议补丁**：`listWindowsMac` 返回时带 `titleEmptyRatio`；超过阈值时在 /health 里单独报「窗口标题为空（可能缺屏幕录制权限）」，
  与「窗口真的不存在」区分开。
- **测试**：窗口列表是 osascript 内联脚本，难单测；建议把「空标题率 → 权限提示」抽纯函数。

#### M3 授权主体不唯一（node / Desktop Agent.app / Open Computer Use.app）

- **证据**：`docs/USAGE.md:402-403` 明确「授权对象：启动小窗的那个进程——终端、Electron、或打包后的 App，三个是不同的授权条目」；
  `core/daemon.mjs:78` 又提示把 `process.execPath`（node）加进辅助功能；ocu 自己的报错说的是
  「grant access to Open Computer Use」。三条说法并存。
- **后果**：用户照着不同文档授权到不同对象，出现「明明授权了还是不行」；打包后 bundle id/签名变化还会让旧授权失效。
- **建议补丁**：文档层统一一张「谁在跑 → 授权给谁」的表（本文件第 1 节可作为来源），
  并在 `selfTest`/`doctor` 输出里打印「当前进程路径 + ocu 路径」，让用户知道该加哪个。

#### M4 ocu 首次调用是否触发屏幕录制授权框，静态无法确认

- **证据**：`third_party/open-computer-use/dist/Open Computer Use.app/Contents/MacOS/OpenComputerUse` 导入了
  `_AXIsProcessTrusted`、`_AXIsProcessTrustedWithOptions`、`_CGPreflightScreenCaptureAccess`、`_CGRequestScreenCaptureAccess`；
  但调用点无法只靠 `nm/strings` 定位。我们只确定 `doctor --json` 不启动 onboarding。
- **后果**：如果某个 `get_app_state(include_screenshot:true)` 路径会调 `CGRequestScreenCaptureAccess`，
  那么 `core/user-chrome.mjs:69 ensureScreenshot` 也会在用户不知情时弹框。
- **建议**：在**已授权**的机器上无法验证「未授权时的行为」，只能在干净 TCC 环境实测一次（不在本次只读审计范围）；
  在此之前，`clickAt` 的 `allowScreenshot` 通道应保持默认关闭（现状已如此，`core/user-chrome.mjs:163` 的策略拒绝）。

#### M5 `openPermissionSettings` 死代码，设置页入口有两套实现

- **证据**：`core/permissions.mjs:40` 无调用方；overlay 另有一套 `openScreenRecordingSettings`（`overlay/main.js:1069`）+ 渲染层按钮（`overlay/renderer.js:111,150`）。
- **后果**：后续改文案/改 URL 容易只改一处，两边不一致。
- **建议**：要么删掉死代码，要么让 overlay IPC 复用 `core/permissions.mjs`（overlay 是 Electron/CJS，需改导出形态，属代码改动，见报告建议）。

### 3.3 低危 / 已 fail-closed（正面）

| # | 项 | 证据 | 评价 |
| --- | --- | --- | --- |
| L1 | 自动化预检静默、未授权不发事件 | `core/applescript-driver.mjs:22-35,208-220`；测试 `test/applescript-driver.test.mjs:110-166` | ✅ 正确做法，可作为其它通道的模板 |
| L2 | 权限弹窗绝不代点 | `core/dialog-guard.mjs:59-96`；测试 `test/dialog-guard.test.mjs:5,28,33,43`；`docs/SECURITY.md:33-35` | ✅ 结构判定 + 不认识的默认不点 |
| L3 | 缺 AX 时标环境跳过 | `core/tasks/headless-demo.mjs:236-249` | ✅ 但措辞「缺辅助功能权限」不被 run-classify 认（见 H4） |
| L4 | 锁屏检测不碰 TCC | `core/platform.mjs:80-90`（ioreg） | ✅ |
| L5 | 验收互斥用进程表 | `core/foreground-guard.mjs`（ps） | ✅ |
| L6 | `ocu doctor --json` 不启动 onboarding | 二进制字符串 `"--json prints a permission snapshot without launching onboarding"`；`core/permissions.mjs:12,21` | ✅ 但结果没接入任务准入（H1） |
| L7 | 点击弹窗失败静默返回 false | `core/dialog-guard.mjs:105-113`（catch 后 return false） | ✅ 不会为了点掉提示而重试触发弹框 |

## 4. 补测试建议（纯逻辑，不碰真实权限）

按「能抽成纯函数就先抽、再测」的顺序：

1. `parseDoctorOutput(stdout) -> { ok, missing, accessibilityTrusted, screenCaptureGranted, allGranted }`
   —— 从 `core/permissions.mjs:48-55` 抽出解析部分；用例：正常 JSON、缺字段、空输出、doctor 非 JSON、exit 非 0。
2. `decidePermissionGate({ need: ['accessibility','screenRecording','automation'], granted: {…} }) -> { proceed, skipReason }`
   —— 给 H1 的闸门用；用例：全有、缺一项、全缺、任务不声明需求（向后兼容）。
3. `classifySelfTest({ accessibility, screenCapture, automation }) -> { ok, missing, hint }`
   —— 给 H5 用；用例：只缺自动化时 hint 必须指向「自动化」面板而不是「辅助功能」。
4. `classifyPermissionText(text) -> '' | 'accessibility' | 'screenRecording' | 'automation'`
   —— 给 H4 用；用例含中英文：「Accessibility permission is required」「缺辅助功能权限」「没有辅助功能权限」
   「Screen Recording permission」「not authorized to send Apple events」「-1743」「-1744」。
5. `classifyCaptureFailure(stderr) -> 'permission' | 'window-gone' | 'timeout' | 'other'`
   —— 从 `overlay/main.js:1082-1097` 抽出；用例：`not authorized` / `could not create image` / 超时 / 其它。
6. `windowTitleHealth({ titles, limitRatio }) -> { suspectPermission, ratio }`
   —— M2 的判定；用例：全空、全有、一半空。
7. `applescriptChannelPlan({ running, permission }) -> { probe, skipReason }`
   —— H3 的 Safari 探针门禁（与 `core/app-presence.mjs` 的闸门风格一致）；用例：未运行、未授权、已授权。

已有覆盖可复用的：`test/applescript-driver.test.mjs`（AE 状态码/预检/分类）、`test/dialog-guard.test.mjs`（弹窗分类）、
`test/run-classify.test.mjs`（出口归类，需补权限文本用例）。

## 5. 未验证项与边界

- 本机 TCC 状态未读取（`ocu doctor` 会启动 onboarding 风险未验证前不跑；本审计纪律禁止触发权限弹窗），
  因此「当前机器是否已授权」不在本文件结论内。
- ocu 内部首次调用的授权行为（H 之外，见 M4）只能靠二进制导入符号推断，未实测。
- SkyLight（sky_key/sky_click）在「有辅助功能、但没有屏幕录制」时的行为未实测；从设计上它不应依赖屏幕录制。
- 锁屏状态下 AX/截图都不可用（`docs/USAGE.md` 4.5），本审计不重复展开。
- Windows/Linux 无 TCC 概念（UIA/AT-SPI），不在本审计范围。

## 6. 结论（修复优先级）

| 优先级 | 项 | 最小动作 |
| --- | --- | --- |
| P0 | H1 权限闸门 | runner/daemon 启动任务前 `checkPermissions()`，缺就环境跳过 |
| P0 | H3 Safari 探针 | 前置 isRunning + checkAutomationPermission |
| P0 | H4 归类 | run-classify 认权限文本（中英文），权限缺失永远算环境跳过 |
| P1 | H2 裸 osascript | `frontName` 等改为 ObjC 读前台/或预检后缓存状态，不再盲发 AppleEvent |
| P1 | H5 selfTest | 拆成 AX / 屏幕录制 / 自动化三项分别报，hint 指对面板 |
| P2 | M1/M2 | 屏幕录制预检 + 空标题判权限 |
| P2 | M3/M5 | 文档统一授权主体；删死代码或让 overlay 复用 |
| P3 | M4 | 在干净 TCC 环境实测 ocu 首次截图行为并记录 |

---

**本审计只读：没有触发任何权限弹窗，没有启动/激活任何应用，没有跑 acceptance / matrix / 任何任务本体，没有执行 screencapture / tccutil / 控制第三方应用的 osascript。**

## 7. 修复状态（Lead 收尾 2026-11-08）

| 项 | 状态 | 做法 | 提交 / 证据 |
| --- | --- | --- | --- |
| H1 任务前没有权限闸门 | ✅ 已修 | 新增 `core/permission-gate.mjs`：spawn 前静态推断任务需不需要辅助功能/录屏，需要且明确未授权 → 环境跳过（exit 0、`logs/runs` 写 `code=0 envSkip=true`、不进重试/失败统计、提示带设置页深链）；探测不出来只 warning 放行；`AGENT_ALLOW_MISSING_PERMISSION=1` 强制继续 | `9202961`；`test/permission-gate.test.mjs` 17 条 |
| H2 裸 osascript 可能弹自动化授权框 | ✅ 已修 | ① `frontName()` 默认改走 `osascript -l JavaScript` + ObjC（`NSWorkspace`，不发 AppleEvent），400ms 超时回退老实现（`AGENT_FRONT_READ` 可切换）；② note-cleanup / sync-quit / cold-launch 发事件前静默预检（sync-quit 300ms 硬超时、绝不阻塞退出）；③ 新增 `core/appleevent-preflight.mjs`，acceptance 五处入口（激活宿主/还原前台/读前台名与 bundle）以及 browser / headless-demo 的前台与窗口查询全部接上：已授权时脚本/参数/timeout 与旧实现逐字一致，仅 denied/needs-consent 跳过（0 次 osascript）并写 warning，unknown/超时仍尝试 | `8bf2ba1`、`d81dd6b`、`0a52f69`、`32cd7a8`；`test/front-read.test.mjs` 23 条 + `test/automation-preflight.test.mjs` 18 条 + `test/appleevent-preflight.test.mjs` 13 条 + `test/acceptance-appleevent.test.mjs` 5 条 + `test/appleevent-preflight-browser.test.mjs` 10 条 |
| H3 Safari JS 探针会拉起 Safari | ✅ 已修 | 先 `isAppRunning` 再 `checkAutomationPermission`（askUserIfNeeded=false）；未运行/未授权绝不执行 `tell Safari`，按环境跳过 | `d81dd6b`；`applescriptChannelPlan` 六种组合 + 任务侧顺序回归 |
| H4 权限缺失被判成真失败 | ✅ 已修 | `core/run-classify.mjs` 新增权限文案归类（中英文 + `-1743/-1744/errAEEventNotPermitted`），真失败优先不变，「均已授权」健康行不被误判 | `9202961`；`test/run-classify.test.mjs` 26 条 |
| H5 daemon 自检把自动化误报成辅助功能 | ✅ 已修 | `selfTest` 拆成 accessibility / automation / screenCapture 三项，hint 各自指向正确设置页；旧 `checks.systemEvents`/`ok` 兼容 | `9202961` |
| M1 屏幕录制零预检 | ✅ 已修 | 抓图前 `CGPreflightScreenCaptureAccess` 静默预检（15s 缓存、unknown 不阻断）；未授权不跑 screencapture，回 `permission-missing` +「打开设置」 | `2bd5f8a`；11 条单测 |
| M2 无录屏时窗口标题静默为空 | ✅ 已修 | `classifyWindowTitles` 判「全空/大量为空」，`/health.windowTitles` 暴露；抓图失败文案与「目标窗口已失效」区分 | `2bd5f8a` |
| M3 授权主体说法不统一 | 🟡 文档已统一 | `docs/USAGE.md` 4.4 改成「启动方式 → 被授权条目」对照表（终端 / launchd daemon 的 node / 打包 App / ocu 自己截图 / AppleScript 发起方 × 目标应用），并补上自动化权限与三项症状速查；daemon 自检 hint 已按 H5 分项指对设置页 | 本次（见 CHANGELOG） |
| M4 ocu 首次截图是否弹授权框 | ⬜ 待办 | 需要干净 TCC 环境实测，不能靠静态推断 | — |
| M5 openPermissionSettings 死代码 | ⬜ 待办 | 删掉或让 overlay 复用；属小重构 | — |

### 7.1 修复边界（不能修成新的问题）

- 闸门只「跳过」，不启动、不授权、不改系统设置：所有提示只打印设置页路径与深链命令，不替用户点。
- 探测不出来（ocu doctor 失败/超时/没装）按「未知」放行 + warning，绝不因为查不到权限把所有任务卡死。
- 环境跳过必须是 exit 0 且不算失败：真失败优先原则不变（有 `❌`/`FAIL`/「未送达」就不许被权限文案豁免）。
- 退出路径（sync-quit）预检有 300ms 硬上限，超时继续原有逻辑：清理可以少做一次授权查询，但绝不能卡住退出。
- 前台读取改造保留回退与开关（`AGENT_FRONT_READ=applescript`）：任何不确定都回到旧实现，绝不返回错的前台应用名。

