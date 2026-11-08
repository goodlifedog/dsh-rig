# 应用适配广度：下一批候选与最小可行方案（只读调研）

> 生成时间：2026-11-08 · 只读调研产出，**没有任何实测结论**
> 硬约束：全程没有启动/激活任何应用、没跑矩阵/探测/验收、没改代码、没提交。
> 数据来源：① `reports/app-inventory-2026-11-08T08-32-06-234Z.md`（本机 32 个应用清点）；
> ② `core/app-presets.mjs`（6 个门类预设）、`core/app-runtime.mjs`（运行时→通道链）、
> `core/app-strategy.mjs`（探测结果→建议控法）；③ `flow/CDP-READINESS.md`（Electron/Chromium 逐个只读分析）、
> `flow/COVERAGE.md`（12 个应用的 AX 覆盖率）、`docs/MAC-APPS.md` 第六/七节；
> ④ 本机 `/Applications`、`/System/Applications` 的只读 `ls` + Info.plist/sdef 检查（不启动应用）。

> **落地状态（2026-11-08 晚）**：P2/P3/P4/P5 的预设部分已完成——Preview / Mail / Calendar / Reminders / Music / Photos 已进 `core/app-presets.mjs`（新增 mail/calendar/reading/photos 四个门类，media 补 Music），清点从 32 → 38 个应用；矩阵实测仍待 verify:live 窗口（会启动应用）。ChatGPT 在清点里已单列为「部分验证（CDP cdp-ok、矩阵未读）」。

## 0. 一句话结论

**最大的空白不是某个门类，而是 electron 运行时族：装了 5 个、适配 0 个。**
门类层面，邮件（Mail）、日程/任务（Calendar/Reminders）、播放器（Music）、阅读（Preview）、图片管理（Photos）
这 5 类完全没进预设，而它们全是系统自带、每台 Mac 都有、AX 预期最完整的应用——性价比最高。

建议第一批做 **ChatGPT（electron+CDP）+ Preview + Mail**，第二批做 **Calendar+Reminders、Music、QQ**，Photos 只做只读。

---

## 1. 现状盘点

### 1.1 按运行时族（决定走哪条通道链）

来自最新清点报告（32 个应用）：

| 运行时族 | 装了 | 已适配 | 只能画面 | 专用方案 | 限制 | 不动 | 未测 | 默认通道链 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| native | 23 | 18 | 2 | 0 | 0 | 2 | 1 | ax → applescript → visual |
| **electron** | **5** | **0** | 0 | 0 | 2 | 1 | 2 | ax → cdp → applescript → visual |
| chromium | 3 | 2 | 0 | 1 | 0 | 0 | 0 | cdp → ax → applescript → visual |
| qt | 1 | 1 | 0 | 0 | 0 | 0 | 0 | ax → applescript → visual |

**读法**：native / chromium / qt 三族都至少有一个跑通的样本，electron 族是唯一"装了 5 个、一个都没跑通"的族。
electron 族里：2 个应用侧限制（Antigravity、抖音）、1 个不接管（宿主 DeepSeek Harness）、2 个未测（ChatGPT、OpenCode）。
也就是说 **electron 族的通道链（ax → cdp）一次都没有被端到端验证过**。

### 1.2 按门类（预设里有 6 类，空白 5+ 类）

| 门类 | 预设中的应用 | 覆盖状态 | 空白点 |
| --- | --- | --- | --- |
| office 办公文档 | Pages / Keynote / Numbers / WPS / 文本编辑 | 基本可用 | Keynote / Numbers 只能画面（首启引导不能代点） |
| im 聊天会议 | QQ / 微信 / Telegram / Gemini / ChatGPT / 腾讯会议 | 有样本但都不稳 | 4 个在"读取会抢前台"名单；ChatGPT 实际未测；原生 iMessage 没进预设 |
| dev 开发 | Ghostty / OrbStack / OpenCode / Antigravity / Steam | 一半限制 | 没有编辑器/IDE 类（本机也没装 VS Code / Cursor / Xcode） |
| system 系统 | 备忘录 / 计算器 / 访达 / 系统设置 / Safari / Clash | 好 | 只有这 6 个；`/System/Applications` 里另外 40+ 个全没进清点 |
| media 音视频 | iMovie / GarageBand | 窄 | **只有创作类，没有播放器**（Music / QuickTime / Podcasts / TV） |
| tools 效率 | FastZip / State / iRightMouse / UURemote | 好 | 菜单栏工具为主，够用 |
| **邮件** | — | **空** | Mail 未进预设 |
| **日程 / 任务** | — | **空** | Calendar、Reminders 未进预设 |
| **阅读（PDF/图片）** | — | **空** | Preview 未进预设 |
| **图片管理** | — | **空** | Photos 未进预设 |
| **系统原生 IM** | — | **空** | Messages 未进预设（但见第 4 节：不建议） |

> 为什么系统应用值得做：`core/app-scan.mjs` 的 `SYSTEM_APP_DIRS` 已经包含 `/System/Applications` 与 `Utilities`，
> 但 `scripts/app-inventory.mjs` 有意**只统计预设里提到的系统应用**（注释：「否则报告会被几十个系统小工具淹掉」）。
> 所以"没进预设"= 完全不可见，加一条 `app-presets.mjs` 条目就会自动出现在清点里。

---

## 2. 候选清单（7 个，按优先级）

排序依据：**门类空白程度 × 用户日常频率 ÷ 风险**。分数越高越先做。

| # | 应用（bundle） | 门类 | 运行时（预判） | 首选通道 | 需要的权限 | 主要风险 | 验收模板 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| P1 | ChatGPT（com.openai.codex） | im / AI | electron | **cdp** → ax 兜底 | 无（CDP 端口无鉴权） | 必须退出重启；启动抢一次前台；已在风险名单 | `npm run cdp:apps` + app-matrix |
| P2 | Preview 预览（com.apple.Preview） | 阅读 | native | ax | 辅助功能 | 打开文档会改窗口状态；大 PDF 树大 | `apps:probe` + coverage-probe |
| P3 | Mail 邮件（com.apple.mail） | 邮件 | native（有 .sdef） | ax → applescript | 辅助功能 + **自动化（首次弹框）** | 发信/删除不可逆；`tell` 未运行会启动应用 | app-matrix + `as:channel` |
| P4 | Calendar + Reminders（com.apple.iCal / com.apple.reminders） | 日程/任务 | native（都有 .sdef） | ax | 辅助功能（AS 需自动化） | 新建/删除是写操作；iCloud 同步提示 | app-matrix + 只读任务 |
| P5 | Music 音乐（com.apple.Music） | 播放器 | native（有 .sdef） | ax → applescript | 辅助功能 + 自动化 | **播放会出声**；改资料库不可逆 | app-matrix + AS 只读查询 |
| P6 | QQ（com.tencent.qq） | im | electron/chromium（QQNT 框架） | ax（CDP 备选，未测） | 辅助功能 | 登录态/未发送草稿；风险名单；CDP 可能起不来 | app-matrix + 一次 CDP 实测 |
| P7 | Photos 照片（com.apple.Photos） | 图片管理 | native（有 .sdef） | ax（**只读**） | 辅助功能 | 图库巨大、加载慢；删/编辑不可逆 → 只做只读 | app-matrix（只读项） |

### P1 ChatGPT — 补上 electron 族的零适配

- **为什么最值得**：全仓唯一一个 CDP **实测 cdp-ok** 的第三方 Electron 应用（`flow/CDP-READINESS.md`：10 次运行里 2 次成功、5 次 read-failed、1 次 attach-failed、1 次端口没起）；
  同时它的 AX 读数在不同 reports 之间差 10 倍（13 ~ 132 节点）——说明 AX 本身不稳，CDP 才是它真正的解法。
  做完这一个，等于把 electron 族的整条通道链跑通一次，后面同类应用（OpenCode / Antigravity / 抖音）就有了对照基线。
- **预判 runtime**：electron（Codex Framework 157.0.8103.39，非 app-sandbox）。
- **首选通道**：cdp；AX 仅作对照。
- **权限**：不需要系统授权（调试端口无鉴权、只绑回环）；代价是**必须退出应用再带参数启动**。
- **风险**：单实例锁 → 第二个实例会把参数转交后自己退出（本仓库在 overlay 上实测过）；启动会抢一次前台（历史 frontStolen 多次，风险名单 count=5）；登录态在 userData 一般保留；端口对本机任意进程开放。
- **验收模板**：`core/tasks/cdp-driver.mjs`（已内置 ChatGPT 条目：带端口重启 → 连 /json/version → 读 title/url → 自动退出）；AX 对照用 app-matrix。

**最小可行步骤**

1. `npm run front:risk -- --clear "ChatGPT"`（它在风险名单里，不清掉探测会被默认跳过）
2. 确认用户离开（键鼠空闲），再 `npm run apps:probe -- ChatGPT`（**会启动应用、会动屏幕**）
3. `npm run cdp:apps`（只读页面：title / url / 按钮数；应用已在跑时跳过、不硬重启）
4. 判定：`cdp-ok` 且读到 title/url → 记「专用通道」；只有 ax 可读 → 记「元素级驱动」；两者都不行 → 「限制」
5. 把结论写回 `docs/MAC-APPS.md` 与清点报告（`npm run apps:inventory` 刷新）

### P2 Preview 预览 — 阅读门类从 0 到 1

- **为什么值得**：macOS 上最高频的只读应用之一（看 PDF / 图片 / 截图）。阅读类完全空白，而只读适配天然安全、副作用最小，适合当"新门类样板"。
- **预判 runtime**：native → ax（Apple 原生 AppKit，预期树完整）。
- **权限**：辅助功能（已有）。
- **风险**：打开文档会改变窗口状态（需要显式传文件路径，不能猜用户在看什么）；大 PDF 树可能超节点预算；打印/批注/导出属于写操作，不碰。
- **验收模板**：`core/tasks/coverage-probe.mjs`（只读：窗口标题 + 节点数 + 可交互数）+ app-matrix。

**最小可行步骤**

1. `core/app-presets.mjs` 的 `system` 门类加一条：`{ name: '预览', bundle: 'com.apple.Preview', process: 'Preview' }`
2. `npm run apps:inventory`（纯扫描，不动屏幕）→ 看它进清点、runtime 判成 native
3. `npm run app:resolve -- 预览`（只读通道协商：不启动应用）
4. 用户离开后 `npm run apps:probe -- 预览`
5. 判定口径：节点 ≥ 60 且可交互 ≥ 10 → 「元素级驱动」；只有画面 → 「画面+坐标」；启动即退 → 「应用侧限制」
6. 可选：写一个只读任务（读窗口标题 / 页数），复用 `background-control` 的只读断言风格

### P3 Mail 邮件 — 邮件门类 + 验证 AppleScript 通道

- **为什么值得**：系统自带、必装；有 `.sdef` 脚本字典（本机实测 1 个 sdef 文件），是目前少数能**验证 applescript 通道**的候选
  （AS 通道目前只实测过 Finder / Chrome / Safari）。只读价值明确：未读数、主题列表、按条件筛信。
- **预判 runtime**：native → ax；有字典时通道链会自动多排一条 applescript（`chooseDriverChain` 按 sdef 命令数决定）。
- **权限**：辅助功能 + **自动化权限**（首次发 AppleEvent 会弹系统授权框）。
- **风险**：
  1. `tell application "Mail"` 在 Mail 未运行时会**把它启动**——与 `flow/OCU-CALL-AUDIT.md` 那 11 处同类，必须先 `isAppRunning`；
  2. 首次未授权会弹框 → 必须先 `checkAutomationPermission`（`askUserIfNeeded=false`，静默）预检，未授权按环境跳过；
  3. 发信 / 删除 / 标已读是写操作，**绝对不碰**；账户没配置时窗口是引导页，读不到邮件。
- **验收模板**：app-matrix（读树）+ `core/tasks/applescript-channel.mjs`（只报命令数与授权状态）。

**最小可行步骤**

1. 新增门类 `mail`（或先放进 `system`）并加 Mail 条目
2. `npm run apps:inventory` → `npm run app:resolve -- Mail`（会报 sdef 命令数 + 是否需要授权）
3. 用户离开后 `npm run apps:probe -- Mail`（会启动 Mail——刻意启动器要 ensureAppRunning + 登记 launchedByUs + 结束 quitApp）
4. `npm run as:channel` 看 AS 通道是否把 Mail 纳入（只读，不跑业务命令）
5. 判定：未授权 → 「环境跳过：未授权自动化」；未运行 → 「环境跳过：没在运行」；有树 → 「元素级驱动」

### P4 Calendar + Reminders — 日程/任务门类（两个一起做）

- **为什么值得**：同一套界面范式（左侧列表 / 右侧详情 / 新建按钮），一次适配覆盖两个常用应用；都有 `.sdef`；
  日程与提醒是"后台读一下就能给用户价值"的典型（今天有什么会、还有哪些没做）。
- **预判 runtime**：native → ax（AS 可选）。
- **权限**：辅助功能（若走 AS 需自动化）。
- **风险**：新建/删除是写操作（只读为主）；首次打开可能弹 iCloud 同步或"允许访问日历"的应用内提示；日历视图有大列表，注意节点预算。
- **验收模板**：app-matrix（一次跑两个）+ 只读任务（读"今天日程标题" / "未完成提醒数"）。

**最小可行步骤**

1. `system` 门类加两条（bundle：`com.apple.iCal` / `com.apple.reminders`）
2. `npm run apps:inventory` → 用户离开后 `npm run apps:probe -- 日历,提醒事项`（批探测，会自动关自己拉起的实例）
3. 判定同 P2；两个都读出树才算门类打通
4. 复用 `background-control` 的"读回校验"模式写只读断言（不许点新建）

### P5 Music 音乐 — 补上"播放器"这一类

- **为什么值得**：media 门类现在只有 iMovie / GarageBand（都是创作类），没有播放器；Music 有 `.sdef`，
  而 `tell application "Music" to get player state` 是**不发声的只读查询**——这是验证 AS 通道的干净样本。
- **预判 runtime**：native → ax → applescript。
- **权限**：辅助功能 + 自动化。
- **风险**：**播放会出声**（用户在场绝对不跑，尤其不能点播放/下一首）；改资料库（评分/喜欢/删除/同步）不可逆；Apple Music 登录态。
- **验收模板**：app-matrix + AS 只读（player state / 当前曲目名，不执行播放）。

**最小可行步骤**

1. `media` 门类加 `{ name: '音乐', bundle: 'com.apple.Music', process: 'Music' }`
2. `npm run apps:inventory` → `npm run app:resolve -- 音乐`
3. 用户离开后 `npm run apps:probe -- 音乐`（探测只读树/画面，不点播放）
4. 若探 AS：只发查询命令，禁止 play/pause/next
5. 判定：树可读 + 有按钮 → 元素级驱动（但文档里要明确"点播放=会出声"这一副作用）

### P6 QQ — electron 内核但 AX 够用（第二个 electron 样本）

- **为什么值得**：QQ 是 Electron 内核（QQNT.framework / Electron 40），但 AX 实测 125 节点 / 20 按钮**已经够用**，
  与"electron 族必须靠 CDP"的直觉相反。补它能把"electron 族的第四条路（AX 仍然有效）"记录成证据，
  同时 CDP 是否可通也顺手验一次（理论支持，未实测：二进制里有 remote-debugging-port，但没搜到 DevToolsActivePort）。
- **预判 runtime**：chromium/electron（按 CDP-READINESS 的判据）。
- **首选通道**：ax（已可读）；CDP 作备选。
- **权限**：辅助功能；CDP 需重启应用，且 App Store 沙盒版可能限制端口。
- **风险**：登录态 / 未发送草稿；启动抢前台（风险名单 count=1）；沙盒下端口大概率起不来，起不来就如实记「CDP 不可用」而不是「适配失败」。
- **验收模板**：app-matrix（已有历史读数）+ `npm run cdp:apps` 加一条 QQ 实测。

**最小可行步骤**

1. 清风险名单（`npm run front:risk -- --clear "QQ"`）→ `npm run apps:probe -- QQ`
2. 在 `core/tasks/cdp-driver.mjs` 的 APPS 里加 QQ 条目，跑一次 `npm run cdp:apps` 拿 CDP 结论
3. 判定：AX 可用 → 元素级驱动；CDP 通 → 记"更稳的备选"；CDP 不通 → 只写"CDP 不可用（沙盒/端口）"

### P7 Photos 照片 — 只读适配（图片管理门类）

- **为什么值得**：图片管理完全空白；系统自带；只读场景（最近照片、相册列表）明确。
- **预判 runtime**：native → ax；有 `.sdef`。
- **权限**：辅助功能。
- **风险**：图库可能非常大（加载慢、AX 树巨大）；删除/编辑/共享不可逆 → **只做只读**，任何写操作不实现。
- **验收模板**：app-matrix 只读项。

**最小可行步骤**

1. `system` 门类加 `{ name: '照片', bundle: 'com.apple.Photos', process: 'Photos' }`
2. `npm run apps:inventory` → 用户离开后 `npm run apps:probe -- 照片`（首次可能弹图库初始化，不代点）
3. 判定：有树 → 只读通道；无树但有画面 → 画面+坐标（也不实现写）

---

## 3. 次选（本批不做，但记录在案）

| 应用 | 门类 | 为什么先不做 |
| --- | --- | --- |
| QuickTime Player（com.apple.QuickTimePlayerX） | 播放器 | 有 sdef，但能力与 Music/Preview 高度重叠；播放状态查询用 AS 已验证过就不必再来一遍 |
| Books（com.apple.iBooksX） | 阅读 | 无 sdef；读书进度属个人隐私，只读价值低 |
| Freeform（com.apple.freeform） | 白板 | 无 sdef；画布是自绘界面，AX 预期很薄，需要坐标兜底，性价比低 |
| Dictionary / Maps / Contacts / Journal / Stickies / Font Book | 系统小工具 | 单点价值低，等"系统应用批量适配"时一起扫 |
| Podcasts / TV | 音视频 | 与 Music 同族，先让 Music 跑通再扩 |
| Messages（com.apple.MobileSMS） | IM | 见第 4 节：隐私 + 发消息不可逆，明确不排期 |

---

## 4. 不建议适配（名单与理由）

| 应用 | 理由 |
| --- | --- |
| Passwords / 钥匙串访问 | 自动化密码库 = 批量导出凭据；且 TCC 授权框属于「绝不代点」红线（`core/dialog-guard.mjs`） |
| App Store | 安装/购买不可逆，需要 Apple ID 密码与系统授权；自动化价值低、风险高 |
| System Settings 的「隐私与安全性」页 | 项目红线：不替用户点授权（`SECURITY.md` 第二节）；这类页面必须人点 |
| Clash Verge / 奇游加速器 | 用户的代理与游戏加速器，已在「不动」名单：只读状态、永不退出、不点按钮 |
| DeepSeek Harness（宿主自身） | 本工具就跑在它里面，控制自己 = 中断当前会话（也是 CDP 实验禁区） |
| 抖音 | Electron 但 CDP 实测 10/10 失败 + App Store 沙盒 + 短视频写操作与登录态；两条路都断 |
| Antigravity / OpenCode | CDP 起不来（前者零历史实测、后者 10/10 ECONNREFUSED），且都是 IDE：重启会丢工作区/终端；只值得"只读排查"，不值得排适配 |
| Messages（iMessage） | 读=看他人私信（隐私）、写=不可撤回的消息；且没有"后台只读"的正当用途 |
| Dome Keeper / Escape From Duckov | `~/Applications` 里的 Steam 快捷方式壳（只有 run.sh、没有 bundle id），不是可接管的独立应用 |
| Keynote / Numbers Creator Studio 的深控 | 已判定「可只用画面」；首启引导不能代点（边界已有，别再投入） |

---

## 5. 风险与边界（做这批事之前先读）

1. **本计划只是候选，不是结论**：所有"预判 runtime / 通道"来自只读包结构检查与历史 reports，必须在真机上探测过一次才算数。
2. **实测必须等用户离开**：`verify:live` 要求键鼠空闲 ≥ 15 分钟才开跑；单应用探测走 `npm run apps:probe`，同样会启动应用、动屏幕。
   用户在电脑前时只允许跑：`npm run apps:inventory`、`npm run app:resolve -- <App>`、`npm run verify:safe`（这组不抢前台）。
3. **适配新应用必然启动应用** → 必须遵守 `flow/OCU-CALL-AUDIT.md` 的口径：
   读之前 `isAppRunning` / `requireAppRunning`；刻意启动器要 `ensureAppRunning` → 登记 `launchedByUs` → `installEmergencyAppCleanup` → 结束 `quitApp`；
   **不许为了演示/为了跑通去启动用户应用**。
4. **首次自动化授权必须用户自己点**：`checkAutomationPermission`（`askUserIfNeeded=false`）只允许静默查询，未授权一律环境跳过（exit 0、不算失败）。
5. **不许绕过前台门禁**：读取会让应用抢前台的，先清风险名单再测，测完把结论写回（`npm run front:risk`）；不许为了拿数据反复闪屏。
6. **环境跳过 ≠ 失败**：未运行 / 未授权 / 锁屏都按环境跳过记，别为了"看起来全绿"去掉门禁。
7. **门类扩展要同步单测**：`core/app-presets.mjs` 改动后跑 `npm test`（预设字段与重复条目有断言），并刷新 `npm run apps:inventory`。
8. **写操作一律不实现**：本批候选的"最小可行"全部只做只读（读标题/列表/计数）；发信、删除、播放、新建日程等写操作不在范围内。

---

## 6. 附：发现的一处口径差异（建议顺手统一）

- `docs/MAC-APPS.md` 第六节写「已适配 23」，最新清点报告写「已适配 21 / 未测 3」。
- 差异主要来自 **ChatGPT**：文档把它算「已适配」（依据是历史 CDP 实测），清点报告因为**没有 app-matrix 读数**把它记「未测」。
  两者其实不矛盾——它是「CDP 可用、AX 未测」，但现在的两种口径会让读者以为数据打架。
- 建议：清点报告里给 ChatGPT 这种「通道实测过、矩阵没测过」的情况单独标注（例如状态写「CDP 已实测 / AX 未测」），
  或统一以清点报告为准、在 MAC-APPS 里说明统计口径。

## 8. 新门类实测执行清单（等 verify 窗口，Lead 执行）

> 前提：**屏幕解锁 + 键鼠空闲 ≥15 分钟 + 用户已离开**；辅助功能/屏幕录制/自动化均已授权。
> 矩阵与 probe 都会**启动并关闭应用**，属于刻意启动器：必须走 ensureAppRunning → 登记 launchedByUs → 结束 quitApp，
> 用户在场时绝不许跑（这条由 `flow/TEST-BOUNDARIES.md` 与 `npm run safety:audit` 兜着）。

### 8.1 先决条件：首启引导（否则会被误判成「限制」）

Mail / Calendar / Reminders / Music / Photos / Preview 首次打开可能弹：

- 登录账号 / 新建邮箱向导（Mail）、iCloud 同步与通知权限（Calendar/Reminders/Photos/Music）、
  媒体库选择（Music）、空壳窗口（Preview 没有文档时不建窗口）。

矩阵**只读、绝不代点**这些引导，所以首启状态下的读数会是 `nodes=0`，容易被误记成「应用侧限制」。
处理顺序二选一：

1. 用户在场时由用户自己点完一次引导（最干净）；
2. 或者接受首轮结果标成「待引导」，等用户过完引导后再跑一次矩阵覆盖结论。

### 8.2 命令（按门类逐个跑，每跑完一个看报告）

~~~bash
# 0) 环境门槛自检（锁屏/空闲不对就别跑）
npm run health | grep -E "锁屏|系统权限"

# 1) 单门类矩阵（会启动该门类的应用、读界面树、结束后关掉自己拉起的）
MATRIX_PRESET=reading  npm run matrix   # Preview
MATRIX_PRESET=mail     npm run matrix   # Mail
MATRIX_PRESET=calendar npm run matrix   # Calendar + Reminders
MATRIX_PRESET=photos   npm run matrix   # Photos
MATRIX_PRESET=media    npm run matrix   # iMovie / GarageBand / Music

# 2) 重新清点，确认状态从「未测」变成 已适配 / 部分验证 / 可只用画面 / 限制
npm run apps:inventory

# 3) 单应用探测（想单独看某个应用时）
npm run apps:probe -- Mail
npm run app:resolve -- Mail     # 看通道协商结论（ax/cdp/applescript）
~~~

### 8.3 判定口径（与 `flow/TASK-OUTPUT.md` 一致）

| 矩阵结果 | 归类 | 后续动作 |
| --- | --- | --- |
| 读到界面树（nodes > 0） | 已适配 | 更新 `docs/MAC-APPS.md` 覆盖表与数字 |
| 读不到树但画面能回显 | 可只用画面 | 记录「只能坐标/快捷键」，不要硬等元素 |
| 读不到树、也抓不到画面、或启动即退 | 限制 | 写清是应用侧限制还是首启引导未过 |
| 应用没在运行 / 锁屏 / 缺权限 | 环境跳过 | **不算失败**，等条件具备再跑 |
| CDP `cdp-ok` 但矩阵没读界面 | 部分验证 | 单独标注，不要写成已适配 |

### 8.4 跑完要落的账

1. `docs/MAC-APPS.md` 第六节：状态、数字、每个新门类的实机结论（读/点/画面/前台影响）。
2. 根目录 `CHANGELOG.md`：适配结论与实测时间；若某应用首启引导没过，写明「待用户过引导」。
3. `flow/COVERAGE.md`：把新应用加进覆盖率表（如果有读数）。
4. 若矩阵发现新应用会抢前台：确认 `front-risk` 名单已记录（`npm run front:risk` 可看）。
5. 清理：确认没有残留应用（`MATRIX_QUIT=1` 默认会关自己拉起的；验收收尾还有基线兜底）。
