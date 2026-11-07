# 任务清单

> `npm run run <名字>` 就能跑；`desktop-agent tasks` 只列名字，用途看这里。
> 本文件由 `npm run tasks:doc` 生成（扫描 `core/tasks/*.mjs` 的文件头注释），不要手改。
> 标 ⚠️ 的会在真实应用里写东西（会尽量恢复原值，但别在用户正在编辑时跑）。

| 任务 | 做什么 |
| --- | --- |
| `app-matrix` | 应用能力矩阵：逐个真实应用探明后台能力，全程检查前台有没有被抢占 |
| `applescript-channel` | AppleScript 通道验证：查授权状态（静默、不弹框），对已授权的应用发只读命令 |
| `background-control` | ⚠️ 后台控制验收：启动软件、点击、写入，全程不抢前台，并把真实窗口回显到小窗 |
| `background-stability` | 后台操作稳定性：连续多轮在多个应用上做读/点，每轮都检查前台有没有被抢 |
| `boss-candidates` | （文件头没写用途说明） |
| `boss-greet` | ⚠️ （文件头没写用途说明） |
| `boss-scan-dedicated` | BOSS 扫描（专用浏览器版） |
| `boss-scan` | （文件头没写用途说明） |
| `browser-background` | 浏览器后台控制：独立实例 + CDP，全程不碰用户前台 |
| `browser-demo` | 专用浏览器自证：离屏 Chrome 实例 + CDP，全程不碰用户窗口 |
| `cdp-channel` | CDP 通道端到端验证：自己起一个 Chromium 实例，验证"读页面 / 按文字点 / 往输入框写"这三件事 |
| `cdp-driver` | CDP 通道验证：对 Electron / Chromium 系应用开调试端口，看能不能连进去读页面 |
| `cold-launch` | 冷启动验收：把应用彻底退掉，再用后台方式拉起，检查前台有没有跳转 |
| `coverage-probe` | （文件头没写用途说明） |
| `drive-agent-cli` | ⚠️ 通过后台终端驱动 agent CLI（opencode / codex / claude 等），并把结果读回来 |
| `drive-agent` | ⚠️ 驱动另一个 agent 工具：把一个提示词送进桌面 agent 应用，等它回复，再读回来 |
| `electron-demo` | 任务层示例：用「临时 Electron 实例 + CDP」自证读写能力 |
| `form-fill-local` | ⚠️ 本地对照：起一个最小 HTML 表单页（file:// + Electron accessory 窗口，不抢焦点）， |
| `form-fill` | ⚠️ （文件头没写用途说明） |
| `greet-inner` | ⚠️ （文件头没写用途说明） |
| `greet-verify` | ⚠️ 读消息列表。返回 [{ raw, time, body, who }] |
| `headless-demo` | 当前前台：应用名（读 ocu list_apps 的 [frontmost] 行）+ 前台进程 pid |
| `human-demo` | （文件头没写用途说明） |
| `mcp-demo` | （文件头没写用途说明） |
| `multi-app` | （文件头没写用途说明） |
| `parallel-demo` | 并行演示：同时驱动两个独立后台浏览器，各自把画面推到自己那一路小窗 |
| `parallel-real-demo` | 双应用并行回显：同时操作两个真实软件，并把它们各自的窗口实时回显到两个小窗 |
| `platform-demo` | （文件头没写用途说明） |
| `terminal-control` | ⚠️ 终端类后台控制验收：在 Ghostty 里敲一条无害命令，确认输出出现、前台未变 |
| `user-active-demo` | 「你在用 A，我在后台控 B」场景验证 |
| `user-chrome-demo` | ⚠️ （文件头没写用途说明） |
