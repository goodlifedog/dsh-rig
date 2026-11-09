# Changelog

## 0.8.0（未发布）

- **摘掉特定站点能力**：删除 6 个站点专用任务、4 份站点文档、2 个探针脚本（合计 12 个文件、2556 行），并把 form-fill 重写成通用「当前标签页表单填充」（按无障碍 role 找文本栏→写值→读回→恢复），验收里的旧扫描任务换成通用网页点击示例；README/CAPABILITIES/ARCHITECTURE/USAGE 的站点业务叙事全部改成通用后台操作表述，遗留的岗位打分 / 薪资解析两个模块连同单测一并删除。
- **克隆即用（内置 ocu）**：`open-computer-use` 变成 npm 依赖，`resolveOcu` 按 OCU_BIN → node_modules → third_party → 全局的顺序查找；打包只从 node_modules 拷 ocu 运行时与 LICENSE / NOTICE / THIRD_PARTY_NOTICES（不整包打 node_modules）；README/THIRD-PARTY 注明「底层能力来自 open-computer-use（MIT），未修改其源码」。
- **通用网页点击示例**：新增 `examples/web-click`——headless Chrome + CDP，任意页面按可见文字找按钮 → 后台点击 → 读回结果 → 断言，全程不抢前台；已接进验收替代旧的站点扫描步骤（8 条单测）。
- **适配工具与本轮实测**：新增 `core/tasks/adapter-demo.mjs`（读界面树 / 按文字点击 / 键入 / 小窗回显证据，带锁屏/用户活跃/front-risk/运行门禁、临时样例副本与清理）；Safari 端到端 S 级实测通过（读 105 节点/40 按钮 → 点「显示边栏」节点 105→112 → 回显 → 前台不变 → 点「隐藏边栏」还原）；front-unchanged 加了系统浮层忽略与基线稳定校验（通知横幅不再造成假失败/假通过）。随后计算器（点「7」显示 0→77、点「清除」还原 0）、访达（点「下载」标题 文稿→下载、节点 87→77，点回「文稿」还原）、备忘录（点「新建备忘录」节点 48→55，键入 `[AGENT-TEST]` 读回后 cleanup 0 残留）也完成「读 + 点击/键入 + 读回」，连同 Chrome 的独立 profile CDP 通道，共 5 个应用达到 S；证据与可复制命令见 `docs/ADAPTERS.md` 3.1/3.2/4.1。
- **小窗 UI 精简**：删掉红色「停止任务」按钮（AI 自动化不需要），放大按钮从右上角移到窗口中央、改成浏览器全屏按钮样式（hover 才出现，隐藏时不挡点击），主进程点击穿透热区同步改成中央区域并去掉停止按钮旧热区；✕/Esc 关闭保留。README 首屏两张小窗截图已按新界面重拍（收起态 / 放大态，底图为示例页面，不含个人数据）。
- **仓库目录/导出产物改名**：本地仓库目录 `desktop-agent/` → `dsh-rig/`，导出脚本产物 `dist/dsh-rig-<version>.tar.gz`；launchd 服务已按新路径重装（数据目录仍是 `~/.desktop-agent`，不迁移不丢数据）。
- **首屏 demo 动图**：用真实 `headless-demo` 实跑 + 按小窗窗口抓帧，生成 `docs/assets/demo.gif`（480×304、20 帧、约 0.6MB，只含小窗与示例页面，无个人数据），README 首屏不再是 GIF 占位。
- **发布彩排脚本**：新增 `scripts/release-rehearsal.mjs`——干净副本六步（archive → install → test → pack 校验 ocu 许可 → 临时 prefix 全局安装 + doctor → publish dry-run），支持 --dry-run/--quick/--keep；真实跑通 6 PASS / 0 SKIP / 0 FAIL，不污染本机环境。
- **服务迁移实测**：`service:uninstall` → `service:install` 后只剩 `com.goodlifedog.dsh-rig.daemon/overlay` 两套（单 daemon、单 overlay、单实例占 7789/7788），旧 `com.desktop-agent.*` 标签与 plist 被清理。

- **改名：Desktop Agent → DSH Rig。** npm 包名 `dsh-rig`、CLI 命令 `dsh-rig`、App 显示名 `DSH Rig`；
  打包配置 `appId` 改为 `com.goodlifedog.dsh-rig`、`productName` 改为 `DSH Rig`、DMG 标题同步；
  overlay 子包改名 `dsh-rig-overlay`，与主包版本一起升到 0.8.0（`npm run repo:check` 会校验两者一致）。
- **launchd 标签换前缀**：`com.desktop-agent.daemon` / `com.desktop-agent.overlay`
  → `com.goodlifedog.dsh-rig.daemon` / `com.goodlifedog.dsh-rig.overlay`。
  `service install` 会先 bootout 旧标签、删掉旧 plist，再装新的；`service uninstall` 也顺带清理旧标签残留。
  不这么做的话，新旧两套 launchd 服务会同时跑、同时抢 7788/7789（表现为 daemon 起不来 / 端口被占）。
  `service status` 新增一行「检测到旧版本服务仍在运行」的提示。Windows 计划任务同步从
  `desktop-agent-daemon` / `desktop-agent-overlay` 改为 `dsh-rig-daemon` / `dsh-rig-overlay`，
  安装与卸载时都会删掉旧任务名。
- **升级步骤（一次性）**：`npm run service:uninstall` → `npm run service:install` → `npm run service:status`，
  确认只剩新标签在跑。只装不卸会留下旧服务。
- **刻意保持不变**：数据目录仍是 `~/.desktop-agent`（token、Chrome profile、报告都在里面，升级不丢数据）；
  控制面端口仍是 7789、小窗端口 7788；本机仓库目录名从 `desktop-agent/` 改为 `dsh-rig/`（只是本地路径，数据目录 `~/.desktop-agent` 保持不变）。


- 隐私清理（用户要求）：项目里不再出现真实姓名与机器名——LICENSE/package.json/overlay 配置/发布文档统一改成 GitHub 虚拟身份 `goodlifedog`（打包 appId `com.goodlifedog.dsh-rig`，npm 包占位符 `@goodlifedog/*`）；测试 fixture 与本机路径改成 `tester` / `~/…`；本地 git 历史作者/提交者也统一重写为 `goodlifedog <goodlifedog@users.noreply.github.com>`（旧对象已 gc 清理）。`npm run repo:check` 新增动态隐私规则：用当前机器的用户名/主机名扫描所有 tracked 文本文件，出现即报错（不把真实姓名写进检查代码），并覆盖 yml/diff/plist/txt。旧的构建产物 `dist-app/`（gitignored，v0.5.0，含旧署名）已删除，需要时在 `overlay/` 里 `npm run dist` 重新打包。

- ocu 调用审计（过程记录已归档）的 11 处高危调用点全部加上运行门禁并补单测：以前这些任务对**没在运行**的应用直接调 ocu 读取/输入（`snapshot/get_app_state/state/find/readSafe/typeText`），ocu 会把应用启动并可能顶到前台——等于「验证不打扰」的任务自己先打扰了用户。现在统一走 `core/app-presence.mjs`（纯函数 `decideAppPresence` + 注入 `isAppRunning` 的 `requireAppRunning`/`reportAppPresence`，判错一律按没运行处理），未运行即环境跳过（exit 0、不算失败、不启动/不关闭/不改用户应用）；覆盖 user-active-demo / terminal-control / drive-agent / drive-agent-cli / form-fill / mcp-demo / platform-demo / background-control（文本编辑步骤）/ parallel-real-demo，脚本层 `bench-ocu` 也门禁（要测冷读必须显式 `--allow-launch`）。新增 4 个测试文件，全量 903 项 / 902 过 / 1 跳过 / 0 失败。
- 把「对具体应用调 ocu 前必须有运行门禁」做成常驻静态检查（P4）：`npm run safety:audit` 新增规则 5，同一文件里没有 `isAppRunning/ensureAppRunning/ensureAppWindow/requireAppRunning` 又直接 `ocu.snapshot/readSafe/state/find/typeText/cua.getApp` 等就报错，逐点可用 `// audit-ok: <理由>` 豁免；根因封装层、CDP/AppleScript 通道、内嵌 JXA 脚本共 14 条文件级白名单（每条写理由，另有「白名单防腐烂」单测）。扫描范围扩到 `core/*.mjs`：120 个文件 / 103 处调用点 / 0 违规；同时修掉 open 规则把 CDP 状态字符串 `'open'` 误判成启动应用的问题，并把「打开系统设置隐私面板」列为必须可见的显式例外。
- 适配第一批落地（按 「适配候选计划（过程记录已归档）」 候选）：新门类预设的 `name` 用**本地化显示名**（邮件/日历/提醒事项/预览/音乐/照片）——CGWindowList 的窗口 owner 是中文（实测 备忘录/文本编辑/Safari浏览器），用英文名匹配不到窗口，会把可读的应用误判成「找不到窗口」。bundle/process 保持 Info.plist 的英文值。
- 适配第一批落地（按 「适配候选计划（过程记录已归档）」 候选）：`core/app-presets.mjs` 新增 `mail`(Mail) / `calendar`(Calendar+Reminders) / `reading`(Preview) / `photos`(Photos) 四个门类，`media` 补 Music——bundle/process 全部取自 Info.plist；清点从 32 个应用变 38 个，新增 6 个按门类落「未测」桶。每个门类注释写明首启引导风险（登录/iCloud/通知/媒体库），矩阵只读不点按钮、不删数据、不发信。
- 清点口径修正：从「未测」里细分出「部分验证（通道测过、矩阵未读）」——CDP `cdp-ok` 或 AppleScript 只读通过但没跑 app-matrix 的应用不再被误读成「完全没测」（目前是 ChatGPT）；顺带修 `isCdpOk` 只认 `ok`、对真实报告的 `cdp-ok` 永不生效的口径分裂。新增 `applescriptStatus/channelVerified/matrixTested` 字段（向后兼容），报告/汇总/补测命令都包含新状态。
- 权限闸门覆盖面补齐：AX 判定现在同时认 `UI_ACTION_RE`、`OCU_APP_CALL_RE`（MCP `callTool` 界面工具、内层 `cua.getApp`）和 `execFile(OCU, ['js'])` 外层写法——修掉 mcp-demo / drive-agent 缺权限时不被闸门跳过的漏判；dry-run 需要 AX 的任务 16→19，CDP/headless 任务 0 误判。
- 前台读取的锁屏语义修正：实测锁屏时 ObjC 的 `NSWorkspace.frontmostApplication` 返回 `loginwindow`，而老实现（System Events）返回「登录后仍是前台的应用」——对前台保护来说后者才对，否则任务跑到一半锁屏会把 front 翻成 `loginwindow`，guard/还原/验收基线可能误判。现在 auto 模式遇到占位名回退老实现（`fallbackReason=locked-front`），`mode=objc` 保留原值排障；实机 20 次采样 auto 与老实现 20/20 一致。
- 入口守卫统一：新增 `core/direct-run.mjs` 的 `isDirectRun()`（两边 realpath 归一），19 个任务入口改用它——以前手写 `path.resolve(argv[1]) === fileURLToPath(import.meta.url)`，仓库/任务目录经符号链接访问时守卫会判 false，任务不执行 main 却退出 0（静默假成功）。剩 6 处 CLI/脚本入口也在同一批收口。
- `away:maintain` 安全边界加固（独立复核 2 高危 + 6 中危）：非法环境变量不再击穿门槛（parseEnvMs 校验并回退默认）；父进程被 Ctrl-C/SIGTERM 停掉时会同步收掉 detached 子进程组；新增 `reports/.away.lock` 互斥与每步复查；超时/收不到 close 有兜底结算；轮询 in-flight 保护、kill 只发一次、结算前做组存活确认并补 SIGKILL；服务重启后用 `service:status` 复核「没有落后」；日志文件名不许 `../` 逃出目录；未执行步骤记 skipped。新增 9 条 runStep 行为测试。
- `npm run apps:probe` 现在认预设显示名：以前 `-- 邮件` 会报「没找到这些应用」（安装清单里是英文 Mail），而中文系统里矩阵必须用中文名才能匹配到窗口 owner。新增纯函数 `resolveProbeNames`：英文名 / 预设中文显示名 / bundle id / 进程名都能解析，命中预设时返回「中文显示名 + 实际 bundle/process」；17 条探测计划单测。
- 独立复核（两个子 agent 只读审今天全部改动）查出并修掉：**daemon 权限预检窗口的两个高危**（预检 await 期间第二个 /run 能并发起任务；预检期间 /stop 丢失）、失败轮次不归类环境跳过（与验收口径打架）、停止标记残留影响下一任务；权限探测 fail-closed（doctor 字段缺失/非布尔不再当已授权）、doctor 超时 15s→5s、权限缺失不再自动重试；录屏需求判定先剥注释（注释里的 screencapture 不再误判）；前台读取加 objc 失败熔断（连续 3 次失败 → 60s 直接走老实现，避免每次白等 400ms）；Chrome 没运行不发 AppleEvent、osascript -1743/-1744 归环境跳过而不是判 FAIL；清理跳过在报告里可见（note-skipped/textedit-skipped/chrome-skipped + 顶层 envSkip）、验收收尾解析清理结果并用非 AppleEvent 读终态前台；AppleEvent 预检缓存分级（granted 5s / denied 2s / unknown 1s）。新增/补 20+ 条单测，全量 1145 项 / 1143 过 / 2 跳过 / 0 失败。
- H2 已知缺口清零：10 个裸 AppleEvent 入口全部收口——6 个任务的本地 `front()`（browser-background / drive-agent / drive-agent-cli / parallel-demo / parallel-real-demo / form-fill-local）改用共享 `frontName()`（ObjC，不发 AppleEvent，失败语义保持）；form-fill / app-matrix 的前台还原走 `runAppleEventGuarded`（granted 时脚本逐字不变、denied 时 0 次 osascript 并给安全兜底、unknown 仍尝试）；cleanup-test-data 的 TextEdit/Chrome AppleEvent 接 `createAppleEventPreflight`（未授权不读不删不关、deleted=0 并报环境跳过）。`AUTOMATION_PREFLIGHT_KNOWN_GAPS` 清零，安全自查规则 6 对 123 个文件不再有豁免；新增 4 个测试文件 33 条。
- 权限安全按审计（「权限安全审计（过程记录已归档）」）收口（子 agent 执行、Lead 核验提交）：
  ① **任务前权限闸门**：新增 `core/permission-gate.mjs`，runner/daemon 在 spawn 前静态判断任务要不要辅助功能/屏幕录制，明确没授权就**环境跳过**（exit 0、`code=0 envSkip=true`、不进重试/失败统计、提示直接给设置页深链），探测不出来只 warning 放行，`AGENT_ALLOW_MISSING_PERMISSION=1` 可强制继续；
  ② **前台读取不再发 AppleEvent**：`frontName()` 改成 `osascript -l JavaScript` + ObjC（`NSWorkspace`）读进程名，400ms 超时回退老实现（`AGENT_FRONT_READ=objc|applescript|auto`），新机器不再弹「自动化」授权框、耗时 120ms→49ms；名字语义保持进程名（`Finder` 而不是 `访达`），否则前台保护会悄悄失效；
  ③ **Safari JS 探针**先 `isAppRunning` + 静默自动化预检，未运行/未授权绝不 `tell Safari`（不再为了探针把 Safari 拉起来）；
  ④ **note-cleanup / sync-quit / cold-launch** 发 AppleEvent 前预检自动化授权，sync-quit 预检 300ms 硬超时、绝不阻塞退出；
  ⑤ **自检与归类**：`/selftest` 拆成辅助功能/自动化/屏幕录制三项分开报（hint 不再指错设置页），`run-classify` 认得权限缺失文案（中英文 + -1743/-1744）并归环境跳过，真失败优先不变；
  ⑥ **剩余的裸 AppleEvent 入口全部接上静默预检**：新增 `core/appleevent-preflight.mjs`（`askUserIfNeeded=false`、800ms 硬超时、granted/denied 短缓存），验收的 5 处入口（激活宿主/还原前台/读前台名与 bundle）以及浏览器引导、headless 演示的前台与窗口查询都改成「先查授权再发事件」：已授权时脚本/参数/timeout 与旧实现逐字一致，只有明确未授权才跳过（0 次 osascript）并写进报告告警，探测失败/超时按未知仍尝试；
  ⑦ **静态防回归**：`npm run safety:audit` 新增规则 6 —— 对别的应用发 AppleEvent 前必须有自动化预检（`checkAutomationPermission/createAppleEventPreflight/preflightAppleEvent/runAppleEventGuarded/decideAutomationAllow` 之一，或 `// audit-ok: <理由>`），ObjC/JXA（无 `tell application`）不算；12 条结构性白名单每条写理由，另有 10 个任务级已知缺口单独登记（补完即删，单测限制缺口数量上限）；
  ⑧ **小窗抓图前静默屏幕录制预检**（`CGPreflightScreenCaptureAccess`，不弹框），未授权不截图、小窗显示「缺少屏幕录制权限」+ 打开设置；窗口标题全空时单独报「可能缺少屏幕录制权限」而不是窗口失效。
  新增/补充 8 个测试文件，全量 1012 项 / 1010 过 / 2 跳过 / 0 失败。
- 根因层留统一收口点（P1）：`core/background.mjs` 的 `state/find/click/setValue/typeText/readSafe/findSafe` 末尾支持 `{ requireRunning: true }`，开启后先判 `isAppRunning`（复用 `core/app-presence.mjs`），未运行返回结构化 `skipped:'not-running'` 且不进入底层 MCP——避免 ocu 把没运行的应用拉起来。默认 `false` 保持历史行为（9 条单测证明默认路径逐字节不变 + 开启后拦截，全部用假 mcp/假探测，不碰真实应用）。

- 完整验收抓出并修复两个「前台污染」真 bug（子 agent 执行、Lead 核验提交）：
  ① multi-app 对未运行的应用直接 ocu.snapshot，会把应用拉起来并顶到前台（实测计算器被拉起、任务结束不关）；现在只探测正在运行的应用，未运行环境跳过，probe 前后前台变化会还原，并兜底收掉「跑前没运行、跑后却在运行」的应用（task-34）；
  ② app-matrix 收尾还原用「计算器」比对前台「Calculator」大小写/命名不一致，判 leave-user 没还回去；现在 front-restore 大小写/分隔符/别名不敏感，矩阵补 process 名、autoQuit 后立即还原（task-35）；
  ③ acceptance 增加通用兜底：开局采样测试应用基线，每个任务后只收「相对基线新出现」的应用（quitAppSync 优雅退出）再还原前台，失败/中止收尾再采一次（task-36）。
  全量回归 799 项 / 798 过 / 1 跳过 / 0 失败。