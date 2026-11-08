# macOS 软件适配盘点与建议清单（2026-11-08 修正版）

- 盘点时间：2026-11-08（本版按**外部监控实跑**的结果修正了上一版的三个预判）
- 盘点方式：**只读**。本文不启动/激活任何应用、不跑矩阵/验收、不动屏幕。
- 证据等级（全文统一标注）：
  - **S = 实测通过**（有可指认的报告/任务日志）
  - **P = 预判**（包结构/历史报告推断，当前版本未实测）
  - **X = 实测否定**（跑过、结论是「这条路走不通」，**不要再按预判硬试**）
- 真机探测必须等「屏幕解锁 + 用户离开 + 键鼠空闲」的窗口再跑；本文所有命令都只是**可复制清单**，本轮一条都没执行。

## 0. 一句话结论（修正后的顺序）

上一版把 **Preview 排第一**、把 **OpenCode / ChatGPT 当 Electron 走 CDP**，这三点都已被实跑推翻（见第 2 节）。
修正后的顺序是：

1. **先做两个通道已验证、且不在前台风险名单里的**：**Safari**（AppleScript 4/4 实测）、**Google Chrome**（独立 profile CDP 实测）；
2. **再做「真 Electron」**：**Antigravity / 抖音**——但必须先过一道**二进制是否接受调试参数**的预检（OpenCode 就是死在这一步）；
3. **其余全部排后、按前台风险名单决定**：Preview（新进名单）、TextEdit、QQ、Ghostty、WPS Office 都在名单里，默认读取会被跳过；
   要用 `npm run front:risk` 显式清名单并单独评估。

一句话：**先做「通道已通 + 不抢前台」的，再做「文件证明是 Electron」的，最后才是会抢前台的。**

## 1. 本机软件现状

### 1.1 按运行时族（本版按包结构复核，修正了 ChatGPT 归类）

| 运行时族 | 装了 | 已适配 | 说明 |
| --- | --- | --- | --- |
| native | 多数 | 18+ | Finder / 备忘录 / 计算器 / 系统设置 / Safari / TextEdit 等 |
| **electron（真）** | 4 | **0** | Antigravity、抖音、OpenCode、DeepSeek Harness（宿主，不接管）；QQ 是 QQNT Electron 但清点归 chromium |
| chromium | 3 | 2 | **Google Chrome**（专用方案：独立 profile 实例）、QQ、微信（微信实为 native + Cronet） |
| qt | 1 | 1 | WPS Office |
| **Chromium 派生但非 Electron** | 1 | 部分验证 | **ChatGPT**：Frameworks 里只有 Codex Framework + Sparkle，**没有 Electron Framework**（X） |

> 上一版把 ChatGPT 记成 electron 是**分类器误判**（按 app.asar / framework 名字猜的），已由外部监控实跑确认：
> ChatGPT 是 Codex 自己的 Chromium 派生壳，不是 Electron。分类器修正另任务负责，本文先按事实写。

### 1.2 状态与前台风险名单（读取会自己激活、默认跳过）

| 应用 | 是否在 front-risk | count | 对本批意味着什么 |
| --- | --- | --- | --- |
| **Safari** | 否 | — | 可直接实测（S） |
| **Google Chrome** | 否 | — | 可直接实测（S，走独立 profile） |
| Antigravity / 抖音 | 否（但零实测 / CDP 全失败） | — | 可试，但必须先过调试参数预检 |
| QQ | **是** | 1 | 默认跳过；需 front:risk -- --clear "QQ" 才能读 |
| Ghostty | **是** | 1 | 默认跳过 |
| WPS Office | **是** | 4 | 默认跳过 |
| 文本编辑（TextEdit） | **是** | 1 | 默认跳过 |
| 预览（Preview） | **是**（本版新增） | 1 | 默认跳过；见第 2 节 X-1 |
| ChatGPT / Gemini / Telegram / Steam / UURemote / iRightMouse | 是 | 4~5 | 本批不做 |

> 名单是**累积证据**（30 天过期），不是永久判决；确认修好后可用 `npm run front:risk -- --clear` "<应用名>" 清一条重测。

### 1.3 已实测的通道证据（可复用，S）

- **AppleScript**：reports/applescript-channel-2026-11-08T12-52-51-134Z.json → Finder / Google Chrome / Safari / TextEdit 4/4 成功，frontStolen=false、自动化权限 granted；Safari 页面 JS 桥默认关闭。
- **CDP（独立 profile Chrome）**：docs/MAC-APPS.md 第八节记录 4/4 通过（读标题/正文、写输入框、按文字点按钮），不碰用户正在用的 Chrome。
- **AX**：flow/COVERAGE.md 覆盖率表（Chrome 946/114、Safari 32/12、QQ 125/20、Ghostty 17/3、WPS 81/23、TextEdit 50/4 等）。注意是 2026-11-05 的读数，版本/登录态变化后要复核。
- **adapter-demo**：`core/tasks/adapter-demo.mjs`（本轮新增的实测工具，见第 4 节）。

## 2. 三个被实跑推翻的假设（X 清单，不要再按预判做）

### X-1　Preview 不是「低风险只读样板」（上一版排第 1，作废）

- **冷启动 12 秒仍无窗口**：open -g 之后进程在，但窗口迟迟不建；用「等窗口就绪」的判定会一直等到超时。
- **带文档打开后再读会抢前台**：open -a Preview <file> 把文档交给 Preview 之后，读它的 AX 树会把 Chrome / 用户应用顶掉一次；外部监控实跑已复现，**「预览」已进 front-risk（count=1）**。
- **结论**：Preview 从「第 1 位、只读样板」降为**排后候选**；要做只能在 front-risk 名单清掉 + 用户离开窗口时，且只读窗口/菜单，不打开/保存/导出/批注。
- 同步修正上一版「冷启动可能没有文档窗口」的模糊说法：**不是「可能」，是实测 12 秒都没有**。

### X-2　OpenCode 不能用 CDP 接（应用侧限制，别再试）

- 实跑：给 OpenCode 传 `--remote-debugging-port` → **二进制直接拒绝（bad option）**，端口从没起来过。
- 归因：**应用侧限制**（它主动裁掉了调试开关），不是「参数不对」也不是「沙盒拦截」。
- **结论**：OpenCode 归「应用侧限制」，从候选里移除；**不要再换端口/换启动方式重试**（之前 CDP 10/10 ECONNREFUSED 也是同一根因）。
- 这条经验要泛化到所有 Electron：**先证明二进制接受参数，再谈 CDP**（见第 3 节的预检）。

### X-3　ChatGPT 不是 Electron（分类器误判）

- 包结构：Contents/Frameworks 只有 **Codex Framework** + **Sparkle**，**没有 Electron Framework**；没有 app.asar。
- 之前它被记成 electron，是因为分类器看到 app.asar / 类 Electron framework 名字就归类；实跑 /json/version 回的是 Codex 自己的 Chrome 版本，**是 Chromium 派生，不是 Electron**。
- **结论**：ChatGPT 不能作为「electron 族已打通」的证据；本批不做（且它在 front-risk，count=5）。

## 3. 建议适配顺序（三档）

| 档 | 应用 | 证据等级 | 开工前置条件 | 完成标志 |
| --- | --- | --- | --- | --- |
| **A（先做）** | **Safari** | S（AS 4/4；AX 105/47 仅壳） | 无（不在名单）；首次自动化权限走静默预检 | adapter-demo `--app` Safari 读到窗口/按钮；只读任务通过、前台不变 |
| **A（先做）** | **Google Chrome** | S（独立 profile CDP 4/4） | 无（不在名单）；**只碰独立 profile 实例** | 独立实例起停、端口回收、任务前后台不变 |
| **B（真 Electron，先过预检）** | **Antigravity** | P（零实测）→ 先做 B0 预检 | 二进制接受 `--remote-debugging-port`；退出当前工作区前先问用户 | 端口起来 + /json/version 有响应 + 读到页面标题 |
| **B（真 Electron，先过预检）** | **抖音** | X（CDP 10/10 ECONNREFUSED）→ 先做 B0 预检 | 同上；App Store 沙盒版优先试固定端口 | 同上；**起不来就如实记「应用侧限制」，不算适配失败** |
| **C（排后，front-risk）** | Preview | P + X（12s 无窗口、抢前台） | 清「预览」名单 + 用户离开 15 分钟；只读 | 只读窗口/菜单成功；不打开文档 |
| **C（排后，front-risk）** | TextEdit | S（AX+AS） | 清「文本编辑」名单；只写空文稿 | 只写空文稿 + 读回校验 |
| **C（排后，front-risk）** | QQ | S（AX 125/20）+ P（CDP 未验） | 清「QQ」名单 | 只读会话/标题；不碰草稿 |
| **C（排后，front-risk）** | Ghostty | S（AX 17/3） | 清「Ghostty」名单 | 只读窗口文本；键入需前台+空闲门禁 |
| **C（排后，front-risk）** | WPS Office | S（AX 81/23，count=4） | 清「WPS Office」名单 | 只读正文结构；不保存 |

**B0 预检（真 Electron 必做，OpenCode 的教训）**——只在用户离开窗口时跑，这一条**会启动应用**，跑完立刻退出：

    # 把 <App> 换成 Antigravity / 抖音；先看二进制是否接受调试参数（不接受会像 OpenCode 一样报 bad option）
    BIN="/Applications/<App>.app/Contents/MacOS/<exe>"
    "$BIN" --remote-debugging-port=0 --headless --version 2>&1 | head -5
    # 看到 bad option / unknown option → 应用侧限制，直接停止，不要再试
    # 参数被接受 → 再走 adapter-demo / cdp-driver 的正式实测

> 说明：QQ 是「Electron 内核但 AX 已够用」的样本，放到 C 档不是因为它难，而是**它在名单里**（读取会抢前台）；
> 名单清掉后它其实比 B 档更稳（AX 125 节点 / 20 按钮）。

## 4. 适配完成判定 + adapter-demo 7 条可复制命令

### 4.1 判定口径（避免假绿）

- **PASS（S 升级）**：应用已运行 → 读到窗口/控件 → 一次真实动作读回校验通过 → 任务前后前台未变，且能指到具体报告/日志。
- **环境跳过**：应用没运行 / 屏幕锁 / 权限缺失 / 在 front-risk 名单 → **exit 0 + `envSkip:true`**，报告写清原因。**环境跳过不等于通过，也不许为了全绿去掉门禁。**
- **能力失败（真失败）**：应用在跑、权限也有，但读不到树 / 点不动 / 写不进 → exit 1，如实记 FAIL。
- **区分原则**：所有「没跑成」都要先回答一句——**是环境问题（没开/锁屏/没授权/名单）还是能力问题（通道不通/结构不支持）**。两者混在一起就是假绿/假红。
- **不许假绿**：禁止「读不到就当通过」「弹窗提示当结果」「没运行时静默算 PASS」。

### 4.2 adapter-demo（`core/tasks/adapter-demo.mjs`，没有 npm 脚本，直接用 node 跑）

用法：`node core/tasks/adapter-demo.mjs --app <显示名> [--file <样例>] [--click-text <文字>] [--type-text <文字>] [--allow-launch]`

守卫顺序（都是环境跳过，exit 0）：锁屏 → 用户键鼠活跃 → **front-risk 名单（`--allow-launch` 也绕不过）** → 应用没运行（不加 `--allow-launch` 不启动）。
样例文件在 `examples/adapters/`（sample.txt / sample.png / sample.html）；`--file` 会先复制到 0700 临时目录再 `open -g`，**不会写仓库里的样例**。

| # | 命令 | 覆盖的用法 | 预期（跑完看 JSON 的 steps / envSkip） |
| --- | --- | --- | --- |
| 1 | `node core/tasks/adapter-demo.mjs --app Safari` | 最简：只读树 | Safari 在跑 → 读到窗口/按钮；不在跑 → envSkip |
| 2 | `node core/tasks/adapter-demo.mjs --app Chrome` | 只读树（用户 Chrome） | 读到地址栏/按钮；**只读，不碰 profile** |
| 3 | `node core/tasks/adapter-demo.mjs --app Chrome --file examples/adapters/sample.html` | `--file`：后台开临时副本 | 临时目录里打开、读完删掉；仓库样例不改 |
| 4 | `node core/tasks/adapter-demo.mjs --app TextEdit --file examples/adapters/sample.txt --type-text "[AGENT-TEST] typed"` | `--file` + `--type-text` | **会先被 front-risk（文本编辑）拦成 envSkip**；要真跑先 `npm run front:risk -- --clear "文本编辑"` |
| 5 | `node core/tasks/adapter-demo.mjs --app Preview --file examples/adapters/sample.png` | 带文档打开（Preview 专用） | **会先被 front-risk（预览）拦成 envSkip**；且见 X-1：即使清名单也可能 12s 无窗口/抢前台 |
| 6 | `node core/tasks/adapter-demo.mjs --app QQ` | 只读树（名单内应用） | **envSkip：QQ 在 front-risk（count=1）**；清名单后才读得到 125 节点 |
| 7 | `node core/tasks/adapter-demo.mjs --app Safari --allow-launch` | `--allow-launch`：没运行就启动 | Safari 没跑时：ensureAppRunning → 读树 → 结束 quitApp 只关自己拉起的；跑完前台不变 |

补充：`node core/tasks/adapter-demo.mjs --help` 看完整参数；`--click-text "确定"` 是「按可见文字点按钮并读回变化」的用法，在 C 档应用上使用前先清名单（否则同样 envSkip）。

### 4.3 真实输出怎么记

本轮**没有执行**这些命令（不启动应用是硬约束）。S 级结论要求：把命令、完整 JSON（steps / nodes / envSkip / reason）和前后台对比贴进 reports/adapters-<日期>.md，
并把 envSkip 与 FAIL 分开统计——**没有真实输出的条目只能写 P，不能写 S**。

## 5. 不建议适配名单

| 应用/类型 | 等级 | 理由 |
| --- | --- | --- |
| **OpenCode** | **X** | 二进制拒绝 `--remote-debugging-port`（bad option），应用侧限制；CDP 10/10 失败同根因。**不要再试** |
| DeepSeek Harness（宿主） | X | 本工具运行在它里面；带调试端口重启会杀掉当前会话 |
| Clash Verge / 奇游加速器 | — | 用户代理/加速工具，已在「不动」名单：只读状态、永不退出、不点按钮 |
| 密码库（Passwords / 钥匙串） | — | 自动化=批量导出凭据；TCC 授权弹窗属「绝不代点」红线 |
| App Store / 系统设置隐私页 | — | 安装/购买/授权不可逆，项目红线是不替用户点授权 |
| Messages（iMessage） | — | 读=看他人私信、写=不可撤回；没有后台只读的正当用途 |
| ChatGPT | X（原分类归 electron） | 不是 Electron（Codex Framework + Sparkle）；且 front-risk count=5 |
| Steam | — | front-risk count=4，自动化价值低，只保留只读样本 |
| Telegram | — | AX 20~26 节点 / 0 按钮，front-risk count=5，聊天内容隐私 |
| Keynote / Numbers Creator Studio | — | 只能画面；首启许可/引导不能代点 |
| iMovie / GarageBand | — | 音视频编辑副作用大、引导多 |
| Steam 快捷方式壳（Dome Keeper / Escape From Duckov） | — | 只有 run.sh、没有 bundle id，不是可接管应用 |

### 5.1 暂缓（不是永久不建议）

| 应用 | 暂缓原因 | 将来可做的安全范围 |
| --- | --- | --- |
| Mail | 自动化权限首次弹框；发信/删除不可逆；未配账号是引导页 | 只读未读数 / 主题列表 |
| Calendar / Reminders | 新建/删除是写操作；iCloud 同步提示 | 只读今天日程 / 未完成提醒 |
| Photos | 图库巨大、加载慢；删除/编辑不可逆 | 只读相册 / 最近照片 |
| Music | 播放会出声；资料库修改不可逆 | 只读当前曲目 / 播放状态 |
| Terminal / iTerm2（本机未装） | 未测；命令执行不可逆 | 只读窗口文本；执行优先直接 shell |

## 6. 证据索引

- 最新清点：reports/app-inventory-*.md（取最新时间戳那份）
- 应用手册与风险名单：docs/MAC-APPS.md 第六~十节
- CDP 三档：flow/CDP-READINESS.md
- AX 覆盖率：flow/COVERAGE.md
- AppleScript 通道：reports/applescript-channel-*.json
- CDP 实测：reports/cdp-driver-*.json
- 适配实测工具：`core/tasks/adapter-demo.mjs`（用法见第 4.2 节）
- 前台风险名单：`npm run front:risk`（读取 ~/.desktop-agent/front-risk.json，30 天过期）

> 本版修正自外部监控的实跑结论；标注 P 的条目仍需等用户离开窗口后补实测才能升级为 S，标注 X 的条目不要再按预判重试。
