# Changelog

## 未发布

- 安全边界硬化：overlay（7788）与 daemon（7789）都拒绝带 Origin 的浏览器请求（403）、拒绝跨域预检、POST 强制 `Content-Type: application/json`（415），堵掉"网页读窗口标题/往浮窗塞图/让守护进程跑任务"这条路；客户端代码零改动
- 新增 `docs/SECURITY.md`：已堵的 9 类攻击面（注入、授权弹窗、CDP 端口劫持、pid 复用、预置可执行文件、未保存数据、目录穿越、队列上限、浏览器来源）、刻意不做的 4 条、还没堵的 4 条、测试边界说明
- 新增安全单测：`test/security-boundaries.test.mjs`（13 项，注入/端口主人/pid 复核/helper 信任/目录不可信 fail closed），overlay 与 daemon 各补浏览器来源与非 JSON 提交用例
- 通道协商落地：新增 `core/driver-resolution.mjs` 与 `npm run app:resolve`（--all-user 可批量）：只读探测应用是否在跑、AX 树有无内容、CDP 端口开没开、AppleScript 授没授权、窗口在不在，输出每条通道可用性与实际降级顺序；10 项单测
- 修 Finder 这类"有窗口但 AX 窗口数为 0"的误判：窗口可用性补一次系统窗口层（CGWindowList）证据；overlay 的窗口列表新增 `pid` 字段，按 pid 匹配本地化 owner（Finder → 访达），按名字匹配会漏
- 抽出 `core/app-profile.mjs`（框架/otool/asar/JVM/.sdef 采集），`app:runtime` 与 `app:resolve` 共用，去掉一份重复实现
- AppleScript 通道落地：新增 `core/applescript-driver.mjs`（bundle 内 .sdef 命令统计、`AEDeterminePermissionToAutomateTarget` 静默查授权、按授权门禁执行脚本、报错分类、URL 脱敏）与 `npm run as:channel` 自检；Finder/Chrome 已授权实测通过，Safari 未运行如实跳过
- 防授权弹窗：没授权（needs-consent / denied）时**不发 Apple 事件**，避免打断用户；权限查询程序首次使用时用系统 clang 编译并缓存到 `~/.desktop-agent/bin/ae-permission`
- 修「应用是否在运行」误判：原 `pgrep -f bundleId` 会命中 SafariPlatformSupport 等辅助进程，把没运行的 Safari 当成在跑；改用 LaunchServices 判断，拿不到明确答案才退回进程名（且要求 /Contents/MacOS/ 路径）
- CDP 通道落地：新增 `core/cdp-driver.mjs`（稳定端口分配、带调试端口后台启动、页面 target 打分挑选、读页面/按文字点/往输入框写）与 `npm run cdp:channel` 自检；自建 Chromium 实例 4/4 通过
- 新增 `npm run cdp:apps`：实测本机 Electron 应用能否走 CDP——ChatGPT 端口开放、连上后约 1.2 秒被应用主动断开（1006），OpenCode/抖音 不认调试开关；已如实写进架构文档，这类情况下按设计降级到 AX/画面，不改代码
- 页面 target 打分：优先主界面（index.html），把 detached 空窗口、devtools、扩展页排在后面；连上就断的目标自动换下一个
- 收尾 TERM 等待从 3 秒放宽到 6 秒（ChatGPT 实测 TERM 后 3 秒还没退完，会误报 still-running）
- 支持方式改为按运行时族设计：新增 `core/app-runtime.mjs`（识别 electron/chromium/qt/flutter/java/native + 通道定义 + 驱动链，13 项单测）和 `core/app-runtime.mjs` 命令行 `npm run app:runtime`（不启动应用即可画像，支持 --all/--user/--json）
- 修两处运行时误判：链接系统 WebKit 不等于 Web 应用（GarageBand 被误判过）；微信/QQ 这类自研 Chromium 壳（mojo、Renderer Helper）原先被当成原生，现归入 chromium 族并优先走 CDP
- 修扫描漏掉符号链接应用：`/Applications/Safari.app` 指向 Cryptex，原来清点与探测都扫不到 Safari；`core/app-scan.mjs` 现把符号链接也当候选
- 矩阵匹配窗口时带上本地化显示名（GarageBand → 库乐队），不再只按英文名匹配
- 新增 `docs/APP-SUPPORT-ARCHITECTURE.md`：三层结构（识别/通道/驱动）、运行时→通道链矩阵、本机 27 个应用的归类结果、怎么加新运行时、类型级限制
- 本机 27 个应用归类结果：electron 5、chromium 2、qt 1、native 19；6 个自带 AppleScript 字典（Safari 10 条、Chrome 23、Keynote 28、Numbers 16、Pages 10、Ghostty 19）

- 新增 `docs/MAC-APPS.md`：macOS 应用适配手册（9 类应用的控法、8 个坑与对策、21 个应用实测记录、已知边界），数据全部来自 reports 里的实测报告
- 矩阵探测会自己收尾：默认只关掉本轮 `launched` 的应用（`MATRIX_QUIT=0` 可关掉），不再把所有测试窗口留在桌面上；用户本来就在跑的应用不碰
- 新增 `waitForWindow()`：应用启动后窗口要几百毫秒到十几秒才建好，立刻采集会得到「没有窗口」的假结论；改为轮询 System Events 窗口数（Steam 实测 677ms 就绪）
- 新增 `dialogs()` / `dismissOnboarding()`：首启欢迎弹窗是 app-modal，会把 Apple 事件整个卡住（Pages Creator Studio 连 count documents 都超时 -1712），但 System Events 仍能读到结构；只点「继续/开始使用/知道了」白名单按钮，见到「存储/删除/取消」一律不点
- 新增 `quitApp()`：先优雅退出，退不掉（被弹窗卡住）再按进程 TERM，如实回报 quit/term/already-stopped
- 新增 `windowCount()`、`parseDialogDump()`、`pickOnboardingButton()` 纯函数 + 10 项单测（窗口迟到、一直没窗口、-1 不当成功、坏行解析、破坏性按钮不点）
- 清点报告加「状态 vs 建议控法」一致性交叉校验：两套判定分开写，规则改了容易自相矛盾（如状态已适配、策略却说只能画面操作），现在报告会直接指出；3 项单测（一致不报、矛盾要点名、报告里写出结论）
- 修显示名/进程名不一致导致的漏判：`windowCount/waitForWindow/dismissOnboarding/quitApp` 支持候选名（`altNames`），矩阵自动带上进程名；关键影响是退出保护——只按显示名查不到「要存储吗」弹窗时会错误强杀、丢未保存内容；4 项新单测（窗口数兜底、候选全失败才算 -1、按进程名查到保存弹窗后不强杀）
- 文档补「给一个新应用做适配的步骤」：清点 → 探测 → 读建议控法 → 补预设 → 复核状态
- 新增 `npm run apps:probe`：按应用名或门类预设一条命令探测一批应用（名字自动解析 bundle/进程名），跑完自动刷新清点；支持 --dry/--keep/--no-refresh；12 项单测覆盖参数解析、按名字匹配、扫描目录
- 清点与探测共用 `core/app-scan.mjs` 扫描逻辑（原来清点脚本里自己写了一份），少一份会漂移的重复代码
- 清点报告末尾自动生成「下一步补测」命令：把未测应用拼成 MATRIX_APPS_JSON，复制即可跑（3 项单测）
- 新增 `core/app-strategy.mjs` 操控策略判定：按探测结果自动给「元素级驱动 / 只读状态 / 画面+坐标 / 专用通道 / 不接管 / 应用侧限制」，不用人肉看报告；清点和矩阵报告都多出「建议控法」一列；9 项单测
- 修自动收尾的数据安全风险：`quitApp()` 优雅退出失败时先检查有没有「保存/删除」类弹窗，有就返回 `needs-confirm` 且绝不发 TERM（强杀会丢用户未保存的内容，文本编辑实测会弹这个）；3 项单测覆盖（有弹窗不强杀、没弹窗走 TERM、TERM 后仍在跑如实报）
- 新增 `npm run apps:inventory` 应用清点：扫描 /Applications 与系统应用目录，对照预设和**全部历史**矩阵报告，输出每个应用的适配状态（已适配/可只用画面/专用方案/不动/限制/未测/未安装）；包名过期按名字兜底并标注，特殊应用（Clash/奇游/宿主/Chrome）不挂在「未测」
- 修预设里 5 个过期包名（Clash Verge/Gemini/Telegram/OrbStack/Pages Creator Studio），清点跑出来才发现的
- 新增 `core/app-presets.mjs` 分门类预设（office/im/dev/system/media/tools）与 `MATRIX_PRESET` 环境变量：一条命令按门类批量探测，条目缺字段/bundle 写错/重复会被 5 项单测拦住
- 文档补「本机已安装应用覆盖情况」：已适配 15 类、限制 5 类、明确不动的代理/加速器 2 个、待测 4 个
- 应用启动判定放宽：`ensureAppRunning()` 默认等 8 秒（矩阵 15 秒，`waitMs` 可调），Keynote Creator Studio / 腾讯会议这类 5 秒以上才起来的应用不再被误判「启动后仍检测不到进程」
- 窗口就绪判定加 CGWindow 兜底：AX 窗口数为 0 但系统窗口层有窗口的应用（菜单栏工具 State、腾讯会议、Keynote/Numbers Creator Studio）不再被误判「没有窗口」；报告新增「窗口就绪来源」（ax/cgwindow）
- 实测第三批门类：FastZip（51 节点/7 按钮/live，窗口 761ms）、State（菜单栏工具，62 节点，AX 窗口数恒 0）、腾讯会议（AX 时有时无、画面抓不到）、Keynote/Numbers Creator Studio（AX 0 节点但画面可回显，读取瞬间抢前台已还原）；五个应用全部自动收尾、前台未变
- 实测补两个门类：Steam（Chromium 应用，窗口 677ms、9 节点、0 按钮、画面 live，退出需 TERM）、iMovie（读取瞬间会抢前台，settleFront 还原成功）
- 如实记录应用侧限制：抖音（App Store 版 8.1.1）与 Antigravity 启动后自行退出（抖音存活 <1s，Antigravity 退出码 0），不是控制层能解决的问题
- bg:verify 汇总里标注「锁屏：前台断言跳过」，避免把部分验证当成全部通过
- 修封装层「假成功」：perform_secondary_action/scroll/select_text 失败时 isError=false、错误只写在正文（如索引过期），原封装会误判成功；新增 toolFailureText() 扫正文识别（3 项单测）
- 清理备忘录里 4 条测试笔记（用次要动作删除，前台未变），记录两个实机坑：索引必须来自新鲜 query、首次删除有一次性提示
- 锁屏判定抽成纯函数并支持 plist 格式；core 与 overlay 两份实现加了「行为一致」单测（9 种输出 × 3 类断言），避免以后两边逻辑漂移
- 自审修验收脚本可能被卡死：bg:verify 每项加独立超时（矩阵 240s / 冷启动 90s / 稳定性 90s / 浏览器 120s / 用户在用时 90s / 终端 60s），超时终止并标 FAIL；实测 5s 超时能正确终止
- 外部推帧接管时重置降频计数，恢复本地抓帧不沿用旧的「连续不变」状态
- 自审修冷启动验收的数据安全风险：原先对所有应用强制结束（pkill），备忘录这类有未保存内容的应用会丢数据；现在只对计算器/系统设置强制，其余退不掉就标跳过（实测备忘录被正确跳过、整体仍通过）
- 自审修纯色帧误判：原来只看 JPEG 体积（<8KB 即判 offscreen），但纯黑/纯白的正常窗口同样很小；改为先解码抽样确认真是整块纯色（6 项单测）
- 自审修 daemon 看门狗竞态：看门狗异步创建，任务若在创建前结束，它会在任务结束后才启动并永久轮询；改用 taskSettled 标记 + 模块级引用兜底，实测任务结束后无残留 osascript 调用
- 自审修一个真实风险：输入校验把「内容没写进去」和「读不出来」混为一谈，后者会导致降级重输、内容重复；现在读不出时停在当前方式并返回 verified:null（3 项单测）
- 文档补「API 一览」（21 个后台函数逐个说明），仓库体检新增「后台能力都有文档」检查，加了能力忘写文档会被拦
- 补三类 AX 能力封装：`secondaryAction`（元素自带次要动作，如笔记行的「删除/置顶」）、`scrollElement`（滚动）、`selectTextIn`（选中文本），均带前台保护，6 项单测
- 矩阵支持「中途锁屏」：剩余应用标 SKIP，不再输出「全部不可读」的假结论
- 矩阵默认覆盖扩到 11 个门类（新增 Safari 原生浏览器、WPS Office 办公文档）；README 增「后台能控制哪些软件（实测）」表与已知边界
- 新增应用能力缓存 `core/capabilities.mjs` + `smartTypeWithCache()`：记住每个应用吃哪种输入方式（成功提前/失败押后），写 `~/.desktop-agent/capabilities.json`，9 项单测；后台控制验收改用它
- 终端后台控制验收：`npm run terminal:bg` 在 Ghostty 敲 echo + 回车，5 项全过且前台未变；已并入 bg:verify（现 6 项）
- 发现并修「读取抢前台」：Ghostty / ChatGPT 读界面树会把应用顶到前台（连不截图也发生）；
  新增 readSafe/findSafe（读前记前台、读后比对、变了立刻还原并如实标记），矩阵改用它，
  实测两应用读取后前台稳定在 DSH；扩了 5 项单测，矩阵默认覆盖加终端与 Electron 聊天两类
- 实测两条“菜单替代方案”都不可行：⌘N 快捷键会把目标应用顶到前台（并新建空笔记）；
  用 AppleScript 控制第三方应用会触发「自动化」权限弹窗并打开系统设置——都写进文档，不再尝试
- 菜单命令改为两步（先点开菜单栏项再点菜单项），但实测备忘录菜单栏节点不可查询（AXMenuBarItem/AXMenuItem 均为 0），当前工具链下后台点菜单走不通——已如实写入文档，不再当作通用能力
- 修复 user:active 的判定：用户应用是 DSH 宿主时跳过界面树比对（树会被本轮对话改动），只比对前台与目标应用
- 新增瞬时错误重试：`isTransientAxError()` / `withRetry()` / `clickByText()`（索引过期自动重查、完全匹配优先、断言类失败不重试），9 项单测；后台控制验收改用 clickByText
- 冷启动验收锁屏时也不再整项跳过：前台断言标注跳过，仍验证「退出→后台启动→进程就绪」；实测锁屏下三个应用全部启动成功
- 后台浏览器验收在锁屏时不再整项跳过：headless 浏览器不受锁屏影响，照跑并标注「前台断言跳过」；实测锁屏下启动 906ms、导航 1.6s、点击跳转 1.5s 全部成功
- 新增菜单命令与窗口按钮封装：`clickMenuItem()`（AXMenuItem 语义查找，完全匹配优先，找不到不乱点）、`windowControls()`；矩阵报告增加「菜单项」「窗口按钮」两列
- 新增 `smartType()` 输入降级链：AX 设值 → 后台键入，每步读回校验，全失败才报错（6 项单测，含「接口报成功但内容没进去」）；后台控制验收任务改用它
- 新增 `npm run bg:verify`：一次跑完后台控制全部验收（矩阵/冷启动/稳定性/浏览器/用户在用A时控B），输出 reports/bg-verify-*.md；锁屏时各项自动标环境跳过
- 新增 `npm run user:active`：验证「你在用 A、我后台控 B」时前台与 A 的界面都不受影响
- 新增 `npm run cold:launch`：退掉应用再用后台方式拉起，验证「退出/启动/就绪」三步前台都不变（计算器/系统设置/备忘录实测全过）
- 后台启动可靠性修正：`open -g -b <bundle id>` 在本机解析失败，改用 `open -g -a <本地化应用名>`；运行判定改用英文可执行名（pgrep -x）
- 矩阵与冷启动在锁屏时直接报「环境跳过」，避免把系统限制当成能力缺失
- 新增前台看门狗 `core/front-watch.mjs`：任务期间后台轮询前台，被抢就还原；同一应用被反复切走 3 次以上则认定用户意图、停止争抢（`FRONT_GUARD=0` 可关闭）
- 看门狗：5 项单测覆盖「单次抢占→还原」「同一应用反复切→认账」「还原抛错不崩」；DSH 全屏时其他应用顶不上来，真实抢占暂无法稳定复现（环境限制，已在文档注明）。健康面板新增「前台保护」一行
- 看门狗单测 5 项，含「还原调用抛错不能让轮询崩掉」这类边界（测试真抓到一个未捕获异常）
- 新增 `npm run browser:bg`：后台浏览器验收（独立 headless 实例 → 打开页面 → 拟人点击跳转 → 回显），实测全程前台未变
- 实测确认 Chrome 直接启动与 `open -g -n` 启动都会抢前台，浏览器后台控制必须走独立实例，已写入文档
- 新增 `npm run matrix` 应用能力矩阵：7 个门类应用逐个探明后台启动/读/点/设值/回显，结果写 reports/app-matrix-*.md
- 新增 `npm run stability` 焦点稳定性验证：12 轮后台操作 0 次抢前台、单轮约 900ms
- 后台启动改用「先判断是否在跑（AppleScript is running），只在没跑时 open -g」，避免把已在运行的应用唤起
- 矩阵每步都记录前台应用，万一被抢立刻还原并标记
- 后台控制层 `core/background.mjs`：后台启动（open -g 不激活）、AX 点击、AX 设值、后台键入，每步都记录前台是否被抢占
- 新增 `core/tasks/background-control.mjs` 验收任务：冷启动备忘录→新建→写正文→点击计算器→写入文本编辑，8 项全过、全程前台未变
- 窗口列表改为 CGWindowList 全量（原来只列当前桌面，别的桌面的窗口根本看不到，但系统其实允许抓图）
- 纯色帧识别：窗口在其它桌面且未渲染时返回一整块纯色（JPEG 仅几 KB），标记为 `offscreen` 并提示“仍可后台操作”，不再显示白屏
- 多会话平铺改用“当前存活会话顺序”编号，修掉开过很多会话后新窗口被压到底部的问题

- 切会话时小窗消失更快：宿主轮询从固定 1.2s 改成「可见 0.4s / 隐藏 1.5s」自适应，并把前台应用与窗口列表合并成一次系统调用（单轮 200ms+ → 82ms），切走会话约 0.4–0.5s 内收起（原来要 1.5s）
- `/status` 支持 `{"clear":true}` 复位成「待命」；截图/回归脚本收尾会清掉演示文案，不再把测试残影当成真任务
- `npm run health` 的「最近任务失败数」改成看得懂的说法（全成功时显示上一次任务与耗时，失败时给出任务名/退出码/时间）
- 小窗效果回归的两处断言改成有上限的等待，刚重启预热慢不再误报失败
- 推帧按需出图：新增 `GET /frame-target`（收起 600×380、放大 1920×1200），headless 任务从固定推 2560×1600 改为按小窗实际尺寸出图——单帧 160KB → 18KB，抓帧 90ms → 20ms
- 修抓帧竞态：解绑/切换窗口时，仍在途的那次抓帧失败会把「目标窗口已失效」写回已解绑的会话；现在按抓帧开始时的窗口 ID 校验，目标变了就丢弃结果
- 小窗新增「停止」按钮（任务运行中显示）：走 `POST /stop-task` 停掉后台任务并清空队列；daemon 区分「用户主动停止」与「失败」，前者不触发自动重试
- 小窗静止降频：连续相同的帧按 2 倍周期退避（下限 2fps），画面变化立刻回满帧率；实测静止窗口 6 秒抓帧 36 → 12 次
- 图片头解析/字节数/光标校验抽成 `overlay/image-meta.js`（6 项单测），顺带修 JPEG 扫描的边界 off-by-one（SOF 紧贴缓冲区末尾时读不到尺寸）
- AppleScript 兜底路径的进程名改为转义后再拼接（`overlay/quote.js`，4 项单测），与 PowerShell 侧同样的思路
- `parseJobs` / `countElements` 对 null/undefined 界面树不再抛错（ocu 读失败时任务不会因此崩）
- 任务队列加上限（默认 50，`AGENTD_MAX_QUEUE` 可调）：超过返回 429 并说明原因，队列不会被狂刷撑爆
- 修后台 `/run` 的目录穿越：任务名原来直接拼路径，`../` 可跳出任务目录执行任意脚本；现在按任务白名单校验并返回 400
- 真实窗口回显的瞬时失败不再飘红：`could not create image from window`（窗口长期被遮挡后系统要补画）
  连续失败 4 次才报错，期间 120ms 快速重试；实测 1–3 秒出首帧且无「画面暂时不可用」闪烁，
  失败原始报错会写进日志便于排查（OVERLAY_CAPTURE_FAIL_TOLERANCE 可调）
- 帧率口径按实测校准：真实窗口回显约 6fps / 150ms 一帧，离屏推帧约 13fps / 48ms；隐藏时暂停抓帧
- daemon 对外暴露 `pendingRetry`：失败到退避重跑之间不再显示「空闲」，健康面板显示「等待重试：任务（第 N 次，约 Xs 后）」
- 新增 daemon 集成测试（独立端口 + 临时任务目录）：验证队列串行、环境失败不重试、临时失败重试一次、/stats 计数正确
- 会话窗口自动回收：超过 30 分钟没活动（且没固定/没放大/没悬停）的会话窗口自动关闭，避免开久了堆窗口占内存；`OVERLAY_SESSION_TTL_MS` 可调（0 关闭），短 TTL 实测 14 秒内回收生效
- 仓库体检新增两项：文档里提到的 `npm run` 命令必须真实存在（75 处引用全部命中）、文档引用的图片必须存在，防文档漂移
- 新增 `GET /stats`：按任务聚合最近 200 条运行记录（次数、成功率、平均/最慢耗时、重试次数），health 与 `npm run status` 都会展示
- 临时性失败自动重试：daemon 按 `core/retry-policy.mjs` 判定，Chrome 启动超时/端口没起来这类重跑 1 次并退避（3s→6s），用户在用、锁屏、缺权限、页面改版不重试；`AGENTD_MAX_RETRIES` 可调。临时探针验证：临时失败跑 2 次、断言失败只跑 1 次
- `health --deep` 增加会话隔离检查（共 21 项）
- 语法检查从手写 6 个文件扩到全仓 71 个文件（新增 `scripts/syntax-check.mjs`）
- 补失败归类与 HTTP 接口单测（解绑、clear 复位、尺寸接口、会话白名单），单测 45 项
- 新增 `npm run monitor` 一键巡检：健康（含 14 项小窗回归）+ 会话隔离 + 帧率，输出到 reports/monitor-*.md
- 失败归类收敛成 `core/run-classify.mjs` 一份规则，健康面板与端到端验收共用，环境跳过不再被算成真失败（24h 真失败从 14 降到 3）
- 宿主不在前台时小窗不再"闪一下再藏"：显示前先判断前台应用
- 健康信息新增 `frontmost`（当前前台应用），用于解释"为什么藏起来"
- 小窗回归与会话隔离检查识别锁屏/前台状态，锁屏下按环境跳过而不是误报
- 修「任务结束后解绑不了窗口」：服务端把 `windowId: null` 当非法值返回 400，导致抓帧循环一直空转、旧错误一直挂着；现在 null 表示显式解绑
- daemon 收尾顺序改为「写日志 → 解绑窗口 → 落完成/失败状态」，结束后小窗回到干净空闲态（activity=idle、无残留错误）
- 新增 `GET /selftest`：在后台服务自己的身份下实测系统事件与 ocu 是否可用（launchd 起的进程权限和终端不同），health 直接展示结论与修复提示
- headless-demo 在拿不到窗口数（缺辅助功能权限）时标为「环境跳过」，不再误判成失败
- 状态看板把 `no-window/error` 这类内部枚举翻译成人话
- 新增 `npm run fps:check` 帧率压测：实测收起态 12.7fps（600px、43KB/帧、49ms/帧）、放大态 12.6fps（1920px、223KB/帧、57ms/帧），内存无明显增长
- 新增 `npm run soak` 稳定性巡检：连跑多轮任务，量耗时、内存增长、有无有效帧（6 轮实测 +1MB、6/6 成功）
- 非默认会话悬停时显示会话标题而不是内部 session id
- 健康信息新增 `hostPoll`（最近轮询时间、当前间隔、是否正在轮询）
- 修标题门控匹配 bug：`titleHint` 传完整窗口标题（带「— DeepSeek Harness」后缀）时永远匹配不上，小窗在该会话里也不出现
- `npm run scope:check`：把「小窗只出现在召唤它的会话里」做成可重复断言，并量出切走/切回耗时（实测切走 ≤1000ms、切回 ≤1500ms）
- 归属一变更就同步把状态标成不可见，消除健康信息「说可见其实已藏」的不一致
- 轮询改三档（可见 400ms / 被门控藏起且宿主在前台 700ms / 其余 1500ms），切走约 0.5s 收起、切回约 0.7s 重新出现；新增 `OVERLAY_ATTACH_MID_MS`

## 0.7.0 (2026-11-06)

- **headless 后台浏览器**：屏幕上零窗口，CDP 截图推帧到小窗（~10fps，带虚拟光标与点击波纹）；启动自愈（清理残留 profile 锁、失败重试）
- **拟人操作**：贝塞尔轨迹 + 变速 + 落点抖动；打字按码点分段、随机节奏、偶发打错并纠正；19 条单测
- **默认识别用户 Chrome**：点击走 element_index 语义路径，输入走 sky_key，不抬窗不切标签
- **安全护栏**：对用户应用禁止截图式坐标点击（实测截图会把窗口置前），并保留前后台比对兜底
- 小窗外部帧零解码、帧字节数改为真实值、点击波纹动画补齐

## 0.6.0 (2026-11-06)

- 控制层改为 MCP 常驻连接（`core/ocu-mcp.mjs`）：握手 41ms，单动作 40–140ms，元素索引可复用
- 新增 `mcp-demo` 任务验证长连接（11 个工具、连续调用无进程开销）
- 保留 `spawn ocu js` 老路径，便于对照与回退

## 0.5.0 (2026-11-06)

- 平台层：`overlay/platform.js`、`core/platform.mjs`，把 macOS 专属调用收敛为统一接口
- Windows 控制后端：`tools/uia-bridge.ps1` + `core/backends/uia.mjs`（UI Automation，未实机验证）
- Windows 抓图：`POST /window` 支持标题，按 MainWindowTitle 反查 HWND
- 服务管理：`core/service.mjs`，macOS 用 launchd、Windows 用 schtasks，支持 install/uninstall
- 环境自检：`npm run doctor`（控制后端、可执行文件、数据目录、两个服务）
- 验收：真失败与环境跳过分离，输出 6/6 通过 + 2 跳过
- 测试：`core/lib/salary.mjs`、`core/lib/score.mjs` 抽出为纯函数，11 个用例 + 三平台 CI
- 小窗启动改为 `overlay/start.mjs`，不再依赖 POSIX 的 `env -u`（Windows 可跑）
- 平台冒烟任务 `platform-demo`，接入验收

## 0.4.0 (2026-11-06)

- 小窗重写：多会话隔离、会话标题门控、点击穿透、1px 黑边、按画面比例放大
- 缩略图：分辨率随窗口宽度 ×2、质量 88、约 7fps
- 投递任务：改为「发一条、用消息列表验一条」，状态分 delivered/skipped/failed 桶
- 根因修正：弹窗「已发送」不是送达回执，之前 8 条误报

## 0.3.0 (2026-11-05)

- 小窗首次可用：贴 DSH 右上角、空闲自隐、虚拟光标、外部推帧
- daemon 常驻 + 串行任务队列 + 端到端验收

## 0.1.0 (2026-11-04)

- ocu 封装、离屏 Chrome、CDP 客户端、拟人鼠标轨迹