# macOS 软件适配盘点与建议清单

- 盘点时间：2026-11-08
- 盘点方式：**只读**。没有启动/激活任何应用、没有跑矩阵/探测/验收、没有动屏幕、没有改代码。
- 主要输入（均只读）：
  - reports/app-inventory-2026-11-08T13-54-57-858Z.md（最新清点，38 个应用）
  - core/app-presets.mjs（门类预设）
  - flow/APP-ADAPTER-PLAN.md、flow/CDP-READINESS.md、flow/COVERAGE.md
  - docs/MAC-APPS.md（第六~十节：覆盖情况、边界、前台风险名单）
  - reports/app-matrix-*.json、reports/applescript-channel-*.json、reports/cdp-driver-*.json（历史实测）
- 证据标记：**S = 有实测证据**（AX 读数 / AppleScript 通道 / CDP 实测 / 真任务通过）；**P = 预判**（包结构、运行时族、历史报告推断，尚未实测）；**画面级** = 读不到结构化树，只能回显画面。
- 本文所有「建议」都是预判/方案，不等于已经适配；真机探测仍必须在「屏幕解锁 + 用户离开 + 键鼠空闲」的窗口里做。

## 0. 一句话结论

本机 38 个应用里已适配 21 个，native / chromium / qt 三族都有跑通样本；真正的结构性空白是 **electron 族端到端（0 个已适配）** 和 **阅读/邮件/日历等系统门类**。本轮建议跨门类选 **7 个** 进入适配清单：

**Preview（系统/阅读，新）、Safari（浏览器，AS 已实测）、Google Chrome（浏览器，独立 profile CDP 已实测）、TextEdit（编辑器，AX+AS 已实测）、QQ（IM，AX 已实测）、Ghostty（终端，AX 弱+抢前台）、WPS Office（办公，qt/AX 强但抢前台）**。

顺序上先做「只读、低风险、能补新门类」的 Preview，再做两个浏览器通道，最后做有写入/抢前台风险的 TextEdit、QQ、Ghostty、WPS。**Messages、密码库、App Store、系统设置隐私页、宿主 DeepSeek Harness、加速器、抖音、Antigravity/OpenCode 明确不建议适配。**

## 1. 本机软件现状

### 1.1 按运行时族（数据源：最新清点报告）

| 运行时族 | 装了 | 已适配 | 部分验证 | 可只用画面 | 专用方案 | 限制 | 不动 | 未测 | 默认通道链 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| native | 29 | 18 | 0 | 2 | 0 | 0 | 2 | 7 | ax → applescript → visual |
| electron | 5 | 0 | 1 | 0 | 0 | 2 | 1 | 1 | ax → cdp → applescript → visual |
| chromium | 3 | 2 | 0 | 0 | 1 | 0 | 0 | 0 | cdp → ax → applescript → visual |
| qt | 1 | 1 | 0 | 0 | 0 | 0 | 0 | 0 | ax → applescript → visual |

合计 38 个：已适配 21、部分验证 1（ChatGPT）、可只用画面 2（Keynote/Numbers Creator Studio）、专用方案 1（Google Chrome 独立实例）、不动 3（Clash Verge / 奇游加速器 / DeepSeek Harness）、限制 2（Antigravity / 抖音）、未测 8（Calendar / Mail / Music / OpenCode / Photos / Preview / Reminders / Telegram）。另有 2 个 Steam 快捷方式壳（只有 run.sh、没有 bundle id），不计入可接管应用。

> 归类差异：清点报告把 QQ / 微信归到 chromium；CDP-READINESS 进一步确认 QQ 是 Electron 40（QQNT.framework），微信是 native + Cronet（不是完整 Chromium）。本文以「运行时族看清点、通道结论看 CDP-READINESS」为准，正文里逐条注明。

### 1.2 状态与风险概况

- 已适配 21 个：Finder、Notes、TextEdit、Calculator、System Settings、Safari、QQ、Gemini、WPS、Ghostty、Steam（只读）、OrbStack、Pages Creator Studio、iMovie、GarageBand、FastZip、State、iRightMouse、UURemote、TencentMeeting、ChatGPT（部分验证单列，未计入 21）。
- **前台风险名单**（读取会自己激活、默认跳过界面读取，30 天过期）：清点报告汇总 9 个（Ghostty / ChatGPT / QQ / Gemini / Steam / UURemote / Telegram / WPS / iRightMouse）；审计时本机 ~/.desktop-agent/front-risk.json 已有 10 条（后加了「文本编辑」，count=1）。
- **限制/不动**：Antigravity 与抖音启动后无窗口/CDP 起不来；DeepSeek Harness 是宿主本身；Clash Verge、奇游加速器是用户代理/加速工具，不接管。
- **未测 8 个**：系统应用为主（Mail / Calendar / Reminders / Preview / Photos / Music）+ Telegram + OpenCode。其中 Preview 是只读价值最高、风险最低的一个（本批入选）。
- **IDE 空白**：本机没有装 VS Code / Cursor / Xcode；OpenCode、Antigravity 是 electron IDE 但 CDP 实测起不来/零实测，且重启会丢工作区，不建议现在排适配。因此「编辑器/IDE」门类本轮用 **TextEdit（纯文本编辑器）** 代表，不把 IDE 硬算进去。

### 1.3 已实测的通道证据（可复用）

- **AppleScript**：reports/applescript-channel-2026-11-08T12-52-51-134Z.json → Finder / Google Chrome / Safari / TextEdit 4/4 成功，frontStolen=false、frontUnchanged=true、自动化权限 granted；Safari 的页面 JS 桥默认关闭（需在 Safari 设置打开 Allow JavaScript from Apple Events）。
- **CDP（独立 profile Chrome）**：docs/MAC-APPS.md 第八节记录 4/4 通过（读标题/正文、写输入框、按文字点按钮），独立 profile，不碰用户正在用的 Chrome。
- **AX**：flow/COVERAGE.md 的覆盖率表（Finder 77 节点/22 可交互、Google Chrome 946/114、Safari 32/12、TextEdit 50/4 来自清点、QQ 125/20、Ghostty 17/3、WPS 81/23、Telegram 20/11、微信 20/7）。注意这是 2026-11-05 的只读探测，版本/登录态变化后需要复核。

## 2. 建议适配清单（7 个，跨门类）

| 应用（现状/证据） | 运行时 | 首选通道 | 能做什么 | 风险 | 现有可复用任务/守卫 |
| --- | --- | --- | --- | --- | --- |
| **Preview 预览**<br>未测（P；已在 reading 预设） | native | AX（窗口/菜单/标题/页码） | 只读：窗口标题、文档页数/缩放、菜单项；不实现打开/保存/导出/批注等写操作 | 打开文档会改变窗口状态；大 PDF 树可能超节点预算；冷启动可能没有文档窗口；不要猜用户在看哪个文件 | `core/tasks/coverage-probe.mjs` 的只读统计、`core/tasks/app-matrix.mjs` 的读树判定、`core/app-presence.mjs` 的「未运行就跳过」闸门；判定模板见 `docs/MAC-APPS.md` 第七节 |
| **Safari**<br>已适配（S：AS 4/4；AX 105/47，仅浏览器壳） | native / WebKit | AX（壳）+ AppleScript（标签页/URL） | 读/写当前标签页 URL、新开/切换标签、后台打开页面；页面 DOM 需开发者菜单开 Allow JavaScript from Apple Events | 自动化权限首次会弹系统框（必须先静默 checkAutomationPermission）；冷启动不留窗口；页面内容不在 AX 树；JS 桥默认关闭 | `core/tasks/applescript-channel.mjs`、`core/applescript-driver.mjs`、`core/app-presence.mjs` 的 requireAppRunning、`core/tasks/app-matrix.mjs` 的只读断言 |
| **Google Chrome**<br>专用方案（S：独立 profile CDP 4/4） | chromium | CDP（独立 user-data-dir 的 headless/离屏实例；browser:bg） | 页面导航、DOM/文本读取、按文字点击、输入、截图回显；**不接管用户正在用的 Chrome** | 必须独立 profile；用户实例加不了调试端口；CDP 端口只绑回环、无鉴权（用完即退）；不要读用户默认 profile 的登录态 | `core/browser.mjs`、`core/tasks/browser-background.mjs`、`core/tasks/cdp-driver.mjs`（端口/退出模板）、`core/local-token.mjs` 的本地票据；`docs/MAC-APPS.md` 第八节 headless 实测 |
| **TextEdit 文本编辑**<br>已适配（S：AX 50/4 + AS ok；front-risk count=1） | native | AX（set_value/读文本）+ AppleScript | 读写纯文本、打开/切换文稿；**只对「未命名且空内容」的文稿写**，不覆盖用户文档 | 覆盖写不可逆；首次冷启动是打开面板、没有文稿窗口；读取可能抢一次前台（已在名单） | `core/text-edit-guard.mjs`、`core/note-write-guard.mjs`、`core/tasks/background-control.mjs` 的写入前 guard、`core/front-risk.mjs` 的前台风险名单 |
| **QQ**<br>已适配（S：AX 125/20；front-risk count=1；CDP 未实测） | electron（QQNT，清点归 chromium） | AX 主、CDP 备选（未验证，沙盒可能起不来） | 只读：会话列表、聊天标题、按文字点可见按钮；写消息/发文件不在本批范围 | 启动/读取会抢前台（名单）；重启/操作可能丢未发送草稿；App Store 沙盒下 CDP 端口大概率起不来 | `core/tasks/app-matrix.mjs` 历史读数、`core/tasks/cdp-driver.mjs` 的 CDP 重启/退出模板、`core/app-presence.mjs`、`core/front-risk.mjs` |
| **Ghostty**<br>已适配（S：AX 17/3；front-risk count=1） | native | AX 只读；键盘输入需前台+空闲门禁（sky_key） | 读终端窗口文本/标题；命令执行优先直接 shell，不建议驱动终端 | 读取会抢前台（名单默认跳过）；后台键入要求目标在前台且用户键鼠空闲，否则有误操作/打扰风险；命令不可逆 | `core/tasks/terminal-control.mjs`（空闲/前台门禁模板）、`core/front-risk.mjs`、`core/user-activity.mjs` 的 hidIdleMs、`core/app-presence.mjs` |
| **WPS Office**<br>已适配（S：AX 81/23；front-risk count=4） | qt | AX 只读优先（qt 族） | 读文档窗口/菜单/正文控件；本批不做保存/覆盖，写操作后续单独评审 | 读取会抢前台（名单）；保存/覆盖/另存不可逆；首启可能登录/广告弹窗，不能代点 | `core/tasks/background-control.mjs` 的只读断言与写入守卫模式、`core/front-risk.mjs`、`core/dialog-guard.mjs`（权限/系统弹窗不代点） |

> 说明 1：Preview 是唯一「未测、预判」入选项；其余 6 个都是已有实测/已适配，但本轮把它们收成「可复用的正式 adapter 说明」：明确首选通道、禁区、守卫和判定口径。
>
> 说明 2：所有「能做什么」都是本批**只读/低副作用**范围；写操作（发消息、保存、删除、播放、新建日程）一律不在本批。

## 3. 适配顺序建议

| 顺序 | 应用 | 为什么排这个位置 | 完成标志（判定口径见第 4 节） |
| --- | --- | --- | --- |
| 1 | Preview | 新门类、纯只读、风险最低；一次适配就能补上「阅读/系统」空白，适合当只读样板 | 已运行时 AX 读到窗口/页码/菜单；真任务只读通过且前台不变；环境跳过分支有单测 |
| 2 | Safari | 浏览器是最高频场景；AppleScript 4/4 已实测，坑（自动化权限、JS 桥开关）已有现成探测 | AS 只读任务 4/4；未授权/无窗口时环境跳过；页面 JS 桥关闭时给出明确提示 |
| 3 | Google Chrome | 浏览器自动化主力；独立 profile CDP 已实测，安全边界和临时目录/端口模板齐全 | 独立 profile 启动/退出、端口回收、任务前后台不变；不碰用户默认 profile |
| 4 | TextEdit | 编辑器/纯文本；AX+AS 都有证据，写守卫已存在，先固化「只写空文稿」规则 | 只写空文稿；覆盖场景被 guard 拦住；读取抢前台时走风险名单跳过 |
| 5 | QQ | IM 唯一 AX 够用样本；先把只读会话列表做稳，再讨论 CDP | AX 读到会话/标题；只读任务通过；草稿/登录态不触碰；CDP 只做只读验证 |
| 6 | Ghostty | 终端读文本价值中等，但抢前台风险明确；放到后段，只做只读+严格前台门禁 | 只读窗口文本；读取触发风险名单时跳过；任何键入都要求前台+空闲门禁 |
| 7 | WPS Office | 办公文档写风险最高（保存/覆盖不可逆）+ 抢前台 count=4；最后做，且先只读 | 只读窗口/正文结构；写/保存不实现；首启弹窗不代点 |

排序原则：**新门类/低风险 → 高频浏览器 → 有守卫的编辑器 → IM → 终端/办公（高风险写操作）**。每一步都先跑「用户离开窗口」的只读探测，再谈写能力。

## 4. 判定口径（避免假绿）

1. **S 级证据 = 读得到**：目标应用已在运行，AX/AppleScript/CDP 真的读到窗口/控件/页面内容，并且一次真实任务通过、前后台未被抢。对应的报告要能指到具体文件（app-matrix / applescript-channel / cdp-driver / 任务日志）。
2. **画面级 = 读不到但能回显**：只有 live 帧、没有结构化树。只能标记「画面+坐标」，不宣称元素级能力，也不做写操作。
3. **环境跳过 = 不算通过也不算失败**：目标没运行、屏幕锁定、权限缺失（辅助功能/屏幕录制/自动化）、应用在风险名单里，都打环境跳过、退出码 0，并在报告里写清原因；**不许为了全绿去掉门禁或伪造读数**。
4. **预判必须标注**：没有 app-matrix/通道实测的条目写 P；不得把「包结构看起来支持」「历史报告说支持」当成当前版本已适配。
5. **前置门禁**：读之前先 `core/app-presence.mjs` 的 requireAppRunning；需要刻意启动时走 ensureAppRunning → 登记 launchedByUs → installEmergencyAppCleanup → 结束 quitApp；权限用静默预检（Automation / ScreenCapture），未授权一律环境跳过；读取可能抢前台的先看 `core/front-risk.mjs` 名单。
6. **写操作单独评审**：发消息、保存、删除、播放、新建日程等不可逆动作不进本批；必须另有 guard（text-edit-guard / note-write-guard / dialog-guard）与只写空内容等约束。

## 5. 不建议适配名单（含理由）

| 应用/类型 | 理由 |
| --- | --- |
| DeepSeek Harness（宿主） | 本工具运行在它里面；带调试端口重启会杀掉当前会话（CDP-READINESS 明确列为不用于实验） |
| Clash Verge / 奇游加速器 | 用户的代理与游戏加速工具，已在「不动」名单：只读状态、永不退出、不点按钮 |
| 密码库类（Passwords / 钥匙串访问） | 自动化密码库 = 批量导出凭据；TCC 授权弹窗属于「绝不代点」红线（`core/dialog-guard.mjs`） |
| App Store / 系统设置「隐私与安全性」页 | 安装/购买/授权不可逆，且项目红线是不替用户点授权（`docs/SECURITY.md`） |
| Messages（iMessage） | 读=看他人私信（隐私）、写=不可撤回的消息；没有「后台只读」的正当用途 |
| 抖音 | Electron 但 CDP 实测 10/10 失败（ECONNREFUSED）+ App Store 沙盒 + 登录/草稿风险，两条路都断 |
| Antigravity / OpenCode | 本机唯一的两类 electron IDE：CDP 起不来或零实测，重启会丢工作区/终端；只值得一次只读排查，不值得排适配 |
| Steam | front-risk count=4，自动化价值低；只保留了只读样本 |
| Telegram | AX 历史只有 20~26 节点/0 按钮（只读窗口壳），front-risk count=5，聊天内容属隐私；本批不做，若用户明确需要再单独评估 |
| Keynote / Numbers Creator Studio | 只能画面；首启许可/引导不能代点；深控投入产出低 |
| iMovie / GarageBand | 音视频编辑副作用大、自动化价值低，且首次启动引导多 |
| Steam 快捷方式壳（Dome Keeper / Escape From Duckov） | 只有 run.sh、没有 bundle id，不是可接管的独立应用 |

### 5.1 暂缓（不是永久不建议）

| 应用 | 暂缓原因 | 将来可做的安全范围 |
| --- | --- | --- |
| Mail 邮件 | 自动化权限首次弹框；发信/删除不可逆；未配账号时是引导页 | 只读未读数/主题列表；严格权限预检 + 不发信 |
| Calendar / Reminders | 新建/删除是写操作；iCloud 同步提示；低优先 | 只读「今天的日程/未完成提醒」 |
| Photos 照片 | 图库巨大、加载慢；删除/编辑不可逆；隐私 | 只读相册/最近照片，绝不写 |
| Music 音乐 | 播放会出声；资料库修改不可逆 | 只读当前曲目/播放状态，不点播放 |
| 终端（若装 Terminal/iTerm2） | 本机未装/未测；命令执行有不可逆风险 | 只读窗口文本；执行命令优先直接 shell |

## 6. 证据索引与建议 INDEX 行

- 最新清点：reports/app-inventory-2026-11-08T13-54-57-858Z.md
- 适配方案：flow/APP-ADAPTER-PLAN.md
- CDP 三档：flow/CDP-READINESS.md
- AX 覆盖率：flow/COVERAGE.md
- 应用手册/风险名单：docs/MAC-APPS.md 第六~十节
- AppleScript 通道：reports/applescript-channel-2026-11-08T12-52-51-134Z.json
- CDP 实测：reports/cdp-driver-2026-11-07T21-13-27-981Z.json；headless Chrome 验收见 docs/MAC-APPS.md 第八节

**建议 flow/INDEX.md 新增一行（由 Lead 添加，本文不越权修改）：**

| 我想… | 看这份 |
| --- | --- |
| 本机装了哪些软件、下一批建议适配哪 7 个（跨门类/通道/风险/不建议名单） | [../docs/ADAPTERS.md](../docs/ADAPTERS.md) |

> 本文按「只读盘点 + 历史证据 + 明确预判」编写；所有 S 级结论都能指到上列报告，P 级结论需要等用户离开窗口后补 probe/matrix 才能升级。
