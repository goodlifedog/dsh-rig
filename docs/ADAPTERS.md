# macOS 软件适配盘点与建议清单（2026-11-08 修正版 · 含 Safari 端到端实测）

- 盘点时间：2026-11-08（本版在上一版基础上写入 Safari 的端到端实测证据、修正 Chrome 计划、补下一批安全应用）
- 盘点方式：**只读**。本文不启动/激活任何应用、不跑矩阵/验收、不动屏幕。
- 证据等级：**S = 实测通过**（有可指认的输出/报告）· **P = 预判**（未实测）· **X = 实测否定**（跑过、走不通，不要再按预判硬试）
- 规则：**没有真实输出的条目只能写 P，不能写 S**；本轮写入的 S 级证据都附了命令与实测数值。

## 0. 一句话结论

**5 个应用达到 S（读界面 + 按文字点击/键入 + 读回）**：Safari 端到端（读 105 / 40 → 点「边栏」→ 105→112 → 回显 → 前台未变 → 点回 105）；计算器（点「7」→ 显示 77 → 点「清除」还原 0）；访达（点「下载」→ 窗口标题 文稿→下载、节点 87→77 → 点回「文稿」还原）；备忘录（点「新建备忘录」→ 节点 48→55 → 键入 `[AGENT-TEST]` 读回 → cleanup 后 0 残留）；Chrome（独立 profile + CDP 读/点/键入，见 3.2）。
**Chrome 的适配只在「独立 profile 的 CDP 通道」意义上成立（S）**——不要用 adapter-demo 去碰用户正在用的 Chrome/profile。
**下一批优先做不在前台风险名单里的安全应用**：计算器、访达、备忘录、微信（只读 + 受限键入 + 可清理）。
front-risk 名单当前 **11 个应用**，命中即环境跳过，**--allow-launch 不绕过**；写操作（--type-text）必须先有不覆盖用户内容的守卫。

## 1. 本机软件现状

### 1.1 按运行时族

| 运行时族 | 装了 | 已适配 | 说明 |
| --- | --- | --- | --- |
| native | 多数 | 18+（Safari 本轮升级为 S） | Finder / 备忘录 / 计算器 / 系统设置 / Safari / TextEdit 等 |
| **electron（真）** | 4 | **0** | Antigravity、抖音、OpenCode、DeepSeek Harness（宿主，不接管）；QQ 是 QQNT Electron 但清点归 chromium |
| chromium | 3 | 2 | **Google Chrome**（专用方案：独立 profile 实例）、QQ、微信（微信实为 native + Cronet） |
| qt | 1 | 1 | WPS Office |
| **Chromium 派生但非 Electron** | 1 | 部分验证 | **ChatGPT**：Frameworks 只有 Codex Framework + Sparkle，**没有 Electron Framework**（X） |

### 1.2 前台风险名单（front-risk，读取会把前台抢走 → 默认跳过）

当前 **11 个**（`~/.desktop-agent/front-risk.json`，30 天过期）：

| 应用 | count | 说明 |
| --- | --- | --- |
| ChatGPT | 5 | 本批不做（且非 Electron） |
| Telegram | 5 | 聊天内容隐私，本批不做 |
| Steam | 4 | 只保留只读样本 |
| WPS Office | 4 | 排后，只读 |
| UURemote | 2 | 本批不做 |
| Ghostty | 1 | 排后，只读 |
| QQ | 1 | 排后，只读 |
| Gemini | 1 | 本批不做 |
| iRightMouse | 1 | 本批不做 |
| 文本编辑 | 1 | 排后，只写空文稿 |
| 预览（Preview） | 1 | 排后；见 X-1（12s 无窗口 + 抢前台） |

**名单内应用一律被工具拒绝**：adapter-demo 的 `--allow-launch` **绕不过名单**，要实测必须先显式清名单：

    node scripts/front-risk.mjs clear "<应用名>"      # 与 npm run front:risk -- --clear "<应用名>" 等价
    npm run front:risk                                   # 查看当前名单

**不在名单里的**（本轮可直接做）：Safari、Google Chrome、计算器、访达、备忘录、微信。

### 1.3 已实测的通道证据（S）

- **Safari 端到端（新）**：见 3.1，读树 105/40 → 点「边栏」→ 105→112 → 回显 → 前台不变 → 再点恢复 105。
- **AppleScript**：reports/applescript-channel-*.json → Finder / Google Chrome / Safari / TextEdit 4/4 成功，frontStolen=false、自动化权限 granted；Safari 页面 JS 桥默认关闭。
- **CDP（独立 profile Chrome）**：docs/MAC-APPS.md 第八节 4/4 通过（读标题/正文、写输入框、按文字点按钮）；本仓库 examples/web-click 与 cdp-channel 也已跑通。
- **AX**：flow/COVERAGE.md 覆盖率表（Chrome 946/114、Safari 32/12、QQ 125/20、Ghostty 17/3、WPS 81/23、TextEdit 50/4）。注意是 2026-11-05 读数，本版 Safari 的 105/40 是最新读数。

## 2. 三个被实跑推翻的假设（X 清单）

### X-1　Preview 不是「低风险只读样板」（作废上一版第 1 位）

- 冷启动 **12 秒仍无窗口**（不是「可能没有」，是实测没有）。
- 带文档打开后再读会抢前台：**「预览」已进 front-risk（count=1）**。
- 结论：降为排后候选；即使清名单也只读窗口/菜单，不打开/保存/导出/批注。

### X-2　OpenCode 不能用 CDP 接（应用侧限制）

- 传 `--remote-debugging-port` → 二进制直接拒绝（**bad option**），端口从没起来过。
- 结论：应用侧限制，从候选移除，不要再换端口/换启动方式重试（历史 10/10 ECONNREFUSED 同根因）。

### X-3　ChatGPT 不是 Electron

- Frameworks 只有 Codex Framework + Sparkle、无 Electron Framework / app.asar → 是 Chromium 派生壳。
- 结论：不能当「electron 族已打通」的证据；且 front-risk count=5，本批不做。

## 3. 适配状态与顺序

### 3.1 Safari：端到端已适配（S 级实测）

**命令（可直接复制）：**

    node core/tasks/adapter-demo.mjs --app Safari --click-text "边栏"

**实测输出摘要：**

| 步骤 | 结果 |
| --- | --- |
| gate | 通过（Safari 在运行、不在 front-risk、用户不在键鼠活跃期） |
| read-tree | **nodes = 105，buttons = 40**，窗口标题可读 |
| click-by-text | 命中 **SidebarButton**（按可见文字「边栏」匹配到侧边栏按钮） |
| 变化证据 | 节点数 **105 → 112**（+7，展开侧边栏后新增节点） |
| 回显 | echo 步骤返回 windowId 并成功截图（字节数见当次输出） |
| 前台 | **DeepSeek Harness → DeepSeek Harness**（全程未被抢） |
| 恢复 | 再跑一次 `--click-text "隐藏边栏"`，节点数**回到 105**，现场还原 |

**判定：PASS（S）。** 完成标志（Safari 版）：读得到窗口/按钮 → 点得中 → 有可读的变化证据 → 前台不变 → 能恢复原状。

> 说明：105 / 40 / 112 是本次实测数值，换系统版本或 Safari 侧边栏状态不同会变；判定时以「点前点后节点数有变化 + 前台未变」为准，不硬编码数字。

### 3.2 Google Chrome：CDP 通道已适配（S），但不要用 adapter-demo 碰用户 Chrome

- **证据（S）**：独立 profile 的 CDP 通道 4/4 通过（examples/web-click、cdp-channel；详见 docs/MAC-APPS.md 第八节）。
- **明确不做**：用 adapter-demo 对用户正在用的 Chrome 执行 `--file` / `--type-text`——那会往用户 profile 里开页面、改输入框，碰登录态和用户数据。
- **本轮不做**：Chrome 可见窗口的 AX 闭环（标 P）；Chrome 的「已适配」只指**独立 profile + CDP** 这条通道。
- 走 CDP 的推荐入口：`npm run cdp:channel`（headless 通道）、`npm run browser:bg`（离屏实例）、`examples/web-click`（按文字点击的样例）。

### 3.3 其余应用顺序（三档）

| 档 | 应用 | 证据 | 开工前置 | 完成标志 |
| --- | --- | --- | --- | --- |
| **A（已完成）** | Safari | **S** | — | 见 3.1 |
| **A（已完成）** | Google Chrome | **S**（CDP 通道） | 只用独立 profile 实例 | 见 3.2 |
| **A2（已完成）** | 计算器 / 访达 / 备忘录 | **S**（读 + 点击/键入 + 读回，2026-11-09 实测） | 见第 4 节 | 见第 4 节判定 |
| **A2（待测）** | 微信 | P（需登录态） | 见第 4 节 | 见第 4 节判定 |
| **B（真 Electron，先过预检）** | Antigravity | P（零实测） | 二进制接受调试参数；退出工作区前问用户 | 端口起来 + /json/version 有响应 |
| **B（真 Electron，先过预检）** | 抖音 | X（CDP 10/10 ECONNREFUSED） | 同上；起不来如实记「应用侧限制」 | 同上 |
| **C（排后，front-risk）** | Preview | P + X | 清「预览」名单 + 用户离开 15 分钟 | 只读窗口/菜单，不开文档 |
| **C（排后，front-risk）** | TextEdit | S | 清「文本编辑」名单，只写空文稿 | 只写空文稿 + 读回 |
| **C（排后，front-risk）** | QQ / Ghostty / WPS Office | S | 各自清名单 | 只读 |

**B0 预检（真 Electron 必做，OpenCode 的教训）**——只在用户离开窗口时跑，这一条**会启动应用**：

    BIN="/Applications/<App>.app/Contents/MacOS/<exe>"
    "$BIN" --remote-debugging-port=0 --headless --version 2>&1 | head -5
    # 看到 bad option / unknown option → 应用侧限制，直接停止


## 4. 下一批安全应用（都不在 front-risk）

> 共同前提：用户在键鼠活跃期不要跑；应用没运行不加 `--allow-launch`；跑完确认没留下窗口/测试数据。
> 2026-11-09 补充实测：计算器 / 访达 / 备忘录 已完成「点击 + 读回」，证据见本节表格与 4.1。
> 注意：adapter-demo 已内置中文显示名映射（计算器→Calculator、访达→Finder、备忘录→Notes、微信→WeChat、预览→Preview），中英文名都可直接用。

| 应用 | 怎么读 | 点什么 | 键入 | 清理 |
| --- | --- | --- | --- | --- |
| **计算器（Calculator）** | 读显示屏文本 | 点数字按钮（如「7」），读回显示值变化 | 不需要 | 无需清理（不留数据） |
| **访达（Finder）** | 读窗口标题 + 侧边栏节点 | 侧边栏多为「行/单元格」而不是按钮，`--click-text` **可能点不到** → 先只读 | 不需要 | 无需清理 |
| **备忘录（Notes）** | 读窗口/列表 | 点「新建备忘录」 | 只往**新建的**空笔记里写 `[AGENT-TEST] ...` | `npm run cleanup:test -- --force`（只删带 [AGENT-TEST] 标记的） |
| **微信（WeChat）** | 只读会话/登录态节点（登录后控件才多） | 不发消息、不点发送 | 仅搜索框键入，**不回车** | 手工清空搜索框，或保留也不影响消息 |

**本轮实测（评审侧，2026-11-08 23:30–23:50）：**

| 应用 | 命令 | 实测结果 |
| --- | --- | --- |
| 计算器 | `--app 计算器` | ✅ 读 37 节点 / 24 按钮；回显 57608 字节；前台未变（Calculator） |
| 访达 | `--app 访达` | ✅ 读 87 节点 / 21 按钮（英文名当次 204 节点，随窗口不同）；回显如实跳过；前台未变 |
| 备忘录 | `--app Notes` | ✅ 读 57 节点 / 14 按钮；`--type-text` 被写入守卫拒绝（AXTextArea 有内容，未覆盖） |
| 微信 | — | 未测（当时未运行，需要登录态） |
| Electron 夹具 | `--app Electron --type-text ... --allow-write` | ✅ 写入成功、恢复为空、用户回来即停 |
| 计算器（点击） | `--app Calculator --click-text "7"` → `--click-text "清除"` | ✅ 点「7」显示 0→77，点「清除」还原 0；前台未变（2026-11-09） |
| 访达（点击） | `--app Finder --click-text "下载"` → `--click-text "文稿"` | ✅ 标题 文稿→下载、节点 87→77；点回「文稿」还原、前台未变 |
| 备忘录（点击 + 键入） | `--app Notes --click-text "新建备忘录"` → `--type-text "[AGENT-TEST] adapter demo" --allow-write` → `npm run cleanup:test -- --force` | ✅ 节点 48→55；写入并读回一致；清理后单查 Notes：带标记 0 条、空笔记 0 条；前台未变 |

写已有内容：默认拒绝（避免覆盖用户数据）。确需覆盖用 --type-index <元素索引> 加 --allow-write，写入后自动恢复原值；不要靠放宽启发式猜字段（Finder 的文件名框解析后没有标签，会被误判成可写目标）。

### 4.1 2026-11-09 新增 S 证据（命令可直接复制）

| 应用 | 命令 | 实测输出（要点） |
| --- | --- | --- |
| 计算器 | `node core/tasks/adapter-demo.mjs --app Calculator --click-text "7"` | read-tree nodes=37 / 24 按钮；点中「7」role=button、clickOk=true、changed=true，显示值变化；前台 DSH 未变。还原：`--click-text "清除"` 显示回 0 |
| 访达 | `node core/tasks/adapter-demo.mjs --app Finder --click-text "下载"` | read-tree 窗口「文稿」nodes=87；点中「下载」role=tableRow，窗口标题 文稿→下载、nodes 87→77；前台未变。还原：`--click-text "文稿"` 标题回「文稿」 |
| 备忘录 | `node core/tasks/adapter-demo.mjs --app Notes --click-text "新建备忘录"` | read-tree nodes=48 / 13 按钮；点中「新建备忘录」role=button，nodes 48→55、窗口标题出现「1个备忘录」；前台未变 |
| 备忘录（写入） | `--app Notes --type-text "[AGENT-TEST] adapter demo" --allow-write` | type-guard 二次确认正文区为空；写入并读回 `value="[AGENT-TEST] adapter demo"`；前台未变；清理后 Notes 总数 25、标记 0、空笔记 0 |
| Chrome | `node examples/web-click/run.mjs` | headless Chrome + CDP：按文字找按钮 → 点击 → 读回结果 → 断言通过（详见 3.2、examples/web-click/README.md） |

**命令草案（都可复制）：**

    1) 计算器：点 7 并读回显示
       node core/tasks/adapter-demo.mjs --app Calculator --click-text "7"
       判定：PASS = 点击成功 + 显示值发生可读变化（0→7 或已知值→新值）；否则记能力失败

    2) 访达：只读
       node core/tasks/adapter-demo.mjs --app Finder
       判定：PASS = nodes > 0 且窗口标题可读；点侧边栏先不做（元素角色不是按钮）

    3) 备忘录：新建 + 写测试标记 + 清理
       node core/tasks/adapter-demo.mjs --app Notes --click-text "新建备忘录" --type-text "[AGENT-TEST] adapter demo"
       npm run cleanup:test -- --force
       判定：PASS = 新建成功 + 键入读回一致 + 清理后无 [AGENT-TEST] 残留
       **风险**：绝不能对用户已有笔记 set_value（覆盖不可逆）→ 必须确认目标是新建的空笔记；写守卫待落地（见 5.3）

    4) 微信：只读优先（登录后）
       node core/tasks/adapter-demo.mjs --app WeChat
       可选（只往搜索框键入、不回车）：--type-text "测试"
       判定：PASS = 只读 nodes > 0；键入版 PASS = 能读回搜索词；**任何发送/点按发送按钮都是越界**


## 5. 判定口径与命令表

### 5.1 判定口径（避免假绿）

- **PASS（升级 S）**：应用已运行 → 读到窗口/控件 → 一次真实动作读回校验通过 → 任务前后前台未变，且能指到输出/报告。
- **环境跳过**：应用没运行 / 屏幕锁 / 权限缺失 / 在 front-risk → **exit 0 + envSkip:true**，写清原因。环境跳过不等于通过。
- **能力失败（真失败）**：应用在跑、权限也有，但读不到树 / 点不动 / 写不进 → exit 1，如实记 FAIL。
- **区分原则**：每个「没跑成」先回答——环境问题（没开/锁屏/没授权/名单）还是能力问题（通道不通/结构不支持）。
- **不许假绿**：禁止「读不到就当通过」「弹窗提示当结果」「没运行时静默算 PASS」。

### 5.2 adapter-demo 命令表（7 条）

用法：`node core/tasks/adapter-demo.mjs --app <显示名> [--file <样例>] [--click-text <文字>] [--type-text <文字>] [--allow-launch]`

守卫顺序（都是环境跳过，exit 0）：锁屏 → 用户键鼠活跃 → **front-risk（--allow-launch 绕不过）** → 应用没运行（不加 --allow-launch 不启动）。
样例文件在 `examples/adapters/`；--file 先复制到 0700 临时目录再 `open -g`，**不写仓库样例**。

| # | 命令 | 覆盖用法 | 预期 |
| --- | --- | --- | --- |
| 1 | `node core/tasks/adapter-demo.mjs --app Safari` | 只读树 | Safari 在跑 → 读到窗口/按钮（近期 105/40）；不在跑 → envSkip |
| 2 | `node core/tasks/adapter-demo.mjs --app Safari --click-text "边栏"` | 按文字点按钮（**S 证据**） | 命中 SidebarButton，节点 105→112，前台不变 |
| 3 | `node core/tasks/adapter-demo.mjs --app Safari --click-text "隐藏边栏"` | 点回去 + 现场还原 | 节点回到 105 |
| 4 | `node core/tasks/adapter-demo.mjs --app Calculator --click-text "7"` | 点按钮 + 读回值 | 显示值发生可读变化 |
| 5 | `node core/tasks/adapter-demo.mjs --app Finder` | 只读树（侧边栏不是按钮） | nodes > 0、窗口标题可读 |
| 6 | `node core/tasks/adapter-demo.mjs --app Notes --click-text "新建备忘录" --type-text "[AGENT-TEST] adapter demo" --allow-write` | 点 + 键入（新建的空正文区） | 新建成功 + 读回一致；跑完 `npm run cleanup:test -- --force`（单查 Notes：标记 0、空笔记 0） |
| 7 | `node core/tasks/adapter-demo.mjs --app WeChat` | 只读（名单外、无写操作） | nodes > 0；登录前控件少属正常 |

补充：`--allow-launch` 的用法示例：`node core/tasks/adapter-demo.mjs --app Safari --allow-launch`（没运行才启动，结束 quitApp 只关自己拉起的；**名单内应用仍然被拒**）。

### 5.3 写操作前置条件（待落地）

- `--type-text` 目前**没有内建写守卫**：它只往「找到的可写输入区」写，无法判断那是不是用户正在编辑的内容。
- 因此写类实测必须满足其一：目标明确是**新建的空内容**（备忘录新建笔记 / TextEdit 未命名空文稿 / 搜索框），或先人工确认现场；
- 正在落地的守卫：文本/备忘录只写「未命名且内容为空」、只删 `[AGENT-TEST]` 标记、清理默认只报告（`--force` 才删）。守卫落地前，写类条目只能到 **P**，不能升 S。

## 6. 不建议适配名单

| 应用/类型 | 等级 | 理由 |
| --- | --- | --- |
| **OpenCode** | **X** | 二进制拒绝 --remote-debugging-port（bad option），应用侧限制，不要再试 |
| DeepSeek Harness（宿主） | X | 工具运行在它里面；带调试端口重启会杀掉当前会话 |
| Clash Verge / 奇游加速器 | — | 用户代理/加速工具，「不动」名单：只读状态、永不退出、不点按钮 |
| 密码库（Passwords / 钥匙串） | — | 自动化=批量导出凭据；TCC 授权弹窗属「绝不代点」红线 |
| App Store / 系统设置隐私页 | — | 安装/购买/授权不可逆，红线是不替用户点授权 |
| Messages（iMessage） | — | 读=看他人私信、写=不可撤回，没有后台只读的正当用途 |
| ChatGPT | X（原分类归 electron） | 不是 Electron（Codex Framework + Sparkle）；front-risk count=5 |
| Steam / Telegram | — | front-risk（4 / 5）；自动化价值低或隐私 |
| Keynote / Numbers Creator Studio | — | 只能画面；首启许可/引导不能代点 |
| iMovie / GarageBand | — | 音视频编辑副作用大、引导多 |
| Steam 快捷方式壳（Dome Keeper / Escape From Duckov） | — | 只有 run.sh、没有 bundle id |

### 6.1 暂缓（不是永久不建议）

| 应用 | 暂缓原因 | 将来可做的安全范围 |
| --- | --- | --- |
| Mail | 自动化权限首次弹框；发信/删除不可逆 | 只读未读数 / 主题列表 |
| Calendar / Reminders | 新建/删除是写操作 | 只读今天日程 / 未完成提醒 |
| Photos | 图库巨大；删除/编辑不可逆 | 只读相册 / 最近照片 |
| Music | 播放会出声；资料库修改不可逆 | 只读当前曲目 / 播放状态 |
| Terminal / iTerm2（本机未装） | 未测；命令执行不可逆 | 只读窗口文本；执行优先直接 shell |

## 7. 证据索引

- Safari 端到端实测：本文 3.1（命令 + 输出摘要）
- 应用手册与风险名单：docs/MAC-APPS.md 第六~十节
- CDP 三档与 Chrome 通道：flow/CDP-READINESS.md、docs/MAC-APPS.md 第八节
- AX 覆盖率：flow/COVERAGE.md
- AppleScript 通道：reports/applescript-channel-*.json
- 适配实测工具：core/tasks/adapter-demo.mjs（用法见 5.2）
- 前台风险名单：npm run front:risk（~/.desktop-agent/front-risk.json，30 天过期）

> 本版所有 S 级结论都能指到本文件内的实测段落或上列报告；P 级需要等用户离开窗口补实测才能升级；X 级不要再按预判重试。
