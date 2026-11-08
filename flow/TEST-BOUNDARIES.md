# 测试边界：哪些结论由谁证明、哪些证明不了

> 维护者：Lead。目的：用户反复强调「注意测试的边界、不能留致命漏洞」——
> 这份文档把每条安全结论对应的**证据层**写清楚，同时明确说出**测试证明不了什么**，
> 避免把「单测绿」当成「实机安全」，也避免拿环境跳过当通过。

## 1. 四层测试（从便宜到贵）

| 层 | 命令 | 证明什么 | 证明不了什么 | 前提 |
| --- | --- | --- | --- | --- |
| L0 静态 | `npm run check` / `repo:check` / `safety:audit` / `env:doc --check` / `tasks:doc` | 语法、文档引用、环境变量同步、危险写法（启动不收尾/强杀/open 不带 -g/界面任务没护栏/raw ocu 没运行门禁） | 运行时行为、竞态、真实权限 | 无（纯文件扫描） |
| L1 单测 | `npm test`（900+ 项） | 纯逻辑与判定分支：分类、门禁、清理策略、还原判定、权限文案、静态规则本身 | 真实应用的行为、真实 TCC、真实前台变化 | 无（必须注入假依赖） |
| L2 无屏幕验收 | `npm run verify:safe`（9 项） | 语法/安全自查/健康/平台/清点/CDP headless/AppleScript 只读/后台稳定性 15 轮/并发验证 —— 不产生可见窗口 | 会切屏或需要用户离开的那部分（验收矩阵、小窗回归、帧率） | 屏幕可锁可不锁；不碰用户应用 |
| L3 完整验收 | `npm run verify:live`（5 步） | 端到端验收（含矩阵/多应用）、后台控制验收、小窗回归、会话隔离、帧率压测 | 长期稳定性；跨设备/跨系统版本差异 | 屏幕解锁 + 键鼠空闲 ≥15 分钟（`LIVE_MIN_IDLE_SEC`）；一碰键鼠立即终止当前步骤 |
| L4 并发实证 | `npm run demo:concurrent` | 「AI 后台干活」和「用户前台操作」同时进行：前台采样一次没被抢、屏幕上没有新窗口 | 覆盖所有应用；长时间并发 | 用户可以在场（这正是它的目的） |

## 2. 关键安全属性 → 证据

| 属性 | 主要证据 | 还靠什么兜底 | 明确证明不了 |
| --- | --- | --- | --- |
| 不把没运行的应用拉起来 | 单测 `test/app-presence.test.mjs`、`test/task-app-presence-gate.test.mjs`；静态规则 5（`raw-ocu-without-presence-gate`） | 任务入口 `requireAppRunning` 失败即环境跳过；实测脚本确认前后运行应用数不变（108→108） | 第三方 ocu 内部路径、未纳入 `core/tasks` 的新脚本 |
| 不抢用户前台 | `verify:live` 的验收/后台控制步骤；`demo:concurrent` 前台采样 | `frontRiskGate` 风险名单默认跳过 + 被抢立即还原；矩阵收尾别名归一 | 所有应用/所有 Space；macOS 版本差异 |
| 不代点权限弹窗 / 不擅自弹授权框 | `dialog-guard` 单测（权限弹窗绝不代点）；自动化预检 `AEDeterminePermissionToAutomateTarget(askUserIfNeeded=false)` | 权限审计（`flow/PERMISSIONS-AUDIT.md`）逐条列出裸 AppleEvent 位置 | 首次授权弹框的时序（需要真机首次运行，不能自动化测） |
| 不做不可逆写入 | `decideNoteWrite`、`isDisposableTestDocument` 等判定单测；写类任务入口的用户活跃让路 | `cleanup:test` 默认只报告，`--force` 只碰 `[AGENT-TEST]` 标记 | 第三方应用内部的真实语义（发送/提交是否真的送达） |
| 清理不杀用户应用 | `test/acceptance-cleanup*.test.mjs`；验收基线采样 + 只关「相对基线新出现」的应用 | 基线不可信时**跳过清理并写进报告**（fail-closed） | 基线采样失败时到底有没有残留（宁可留着也不误杀） |
| 权限缺失要 fail-closed | 权限审计（`flow/PERMISSIONS-AUDIT.md` 第 7 节）+ `test/permission-gate.test.mjs`（17 条：need × perms × override 全组合）+ `test/run-classify.test.mjs`（权限文案归类，真失败优先）+ `test/overlay-permission-gate.test.mjs`（抓图前 `CGPreflightScreenCaptureAccess` 静默预检） | 探测不出来时不卡任务但要 warning；缺权限按环境跳过（`AGENT_ALLOW_MISSING_PERMISSION=1` 可强制继续）；前台读取改成 ObjC（不发 AppleEvent）并有回退开关 | `ocu` 首次截图是否会弹屏幕录制授权框；干净 TCC 环境下的首次授权弹框时序 |
| 控制面鉴权 | 健康检查实测：无票 401 / Host=evil 403 / 远程图片 400 | token 只随回环地址发送；验收锁 fail-closed | 非回环部署（需显式 `AGENT_ALLOW_REMOTE_TOKEN=1`） |
| 中止/超时不留残窗 | `task-emergency-cleanup` + `quitAppSync` + 进程组 kill 的单测；验收中止实测 | 外层 6s / 任务 2500ms 清理预算；删顶部硬上限 5 | 用户手动 `kill -9` 整个进程组 |

## 3. 测试自身的边界（硬规则）

1. **单测不许碰真实世界**：不启动/不读取真实应用、不截图、不发 AppleEvent、不访问真实控制面端口；一律注入假依赖（假 mcp / 假 isAppRunning / 假时钟）。
2. **环境跳过必须 `exit 0` 且留一行可审计日志**（`环境跳过：<原因>`），不能算 FAIL，也不能静默 return。
3. **真失败优先**：日志里一旦出现 `❌` / `FAIL` / `未送达` / `存在失败项`，不许被「环境跳过」文案豁免（`core/run-classify.mjs`、`core/live-verify.mjs` 同一规则）。
4. **fail-closed 方向**：探测失败按「不要碰用户应用」处理（例如 `isAppRunning` 抛错 = 没在运行）；权限未知不等于已授权；基线不可信就不清理。
5. **不许为了通过测试动用户的东西**：不为绿灯启动应用、不写用户文档、不关用户应用、不改前台。
6. **写/删类测试只在临时目录 + `[AGENT-TEST]` 标记**：默认 dry-run，`--force` 才真删，且只删自己生成的。
7. **会动屏幕的测试只能进 `verify:live`**：15 分钟空闲门槛、键鼠一碰就停、中止时收干净小窗；不许手动绕过门槛跑矩阵。
8. **豁免必须可审计**：静态检查例外用 `// audit-ok: <理由>`；白名单每条写理由并有「防腐烂」测试；跳过的任务必须打印原因。

### 3.1 实测：单测确实不碰真实世界

2026-11-08 19:5x 在用户正在用电脑时跑了一次全量 `npm test`（1012 项），前后各采样一次：

- 前台应用：跑前 `DeepSeek Harness`、跑后 `DeepSeek Harness`（读取走 ObjC 路径，mode=auto、无回退）。
- 在运行的应用名单（`lsappinfo list`）：跑前跑后**完全一致**，没有新应用出现/消失。
- 复核方式：`grep` 了 test/ 里出现 `osascript` / `screencapture` / `/usr/bin/open` / `ensureAppRunning(` / `quitApp(` 的文件，
  逐项确认都是「注入的假 exec」「断言里的字符串」「注释」，没有一处真的执行系统命令。

## 4. 失败分类边界（PASS / FAIL / 环境跳过）

| 现象 | 归类 | 依据 |
| --- | --- | --- |
| 目标应用没在运行 / 屏幕锁 / 用户回来 / 缺系统权限 | 环境跳过（不算失败） | `core/run-classify.mjs` 环境规则 + 权限文案（中英文） |
| 真断言失败、页面结构变了、改不成关键词、脚本缺失、依赖缺失 | 真失败 | 硬信号优先，不许豁免 |
| 「部分子项环境跳过 + 通过 N 项」 | PASS（带说明） | `core/live-verify.mjs` `classifyLiveStep` |
| 超时 | FAIL（注明超时上限） | 同上 |
| 清理/删除被策略拒绝 | 不失败，写进报告 | 清理策略 fail-closed |

## 5. 环境前提（不满足就只该跑对应层）

| 前提 | 影响 | 检查方式 |
| --- | --- | --- |
| 屏幕解锁 | L3 全部步骤；加锁时任务按环境跳过 | `ioreg CGSSessionScreenIsLocked` |
| 键鼠空闲 ≥15 分钟 | `verify:live` 启动门槛；中途 <20 秒即中止 | `ioreg HIDIdleTime` |
| 辅助功能授权 | AX 读树/点击/键入；缺了 ocu 直接报错 | `ocu doctor --json` / 权限闸门 |
| 屏幕录制授权 | 截图/窗口标题/画面；缺了窗口标题会静默为空 | 抓帧预检 + 标题空检测 |
| 自动化授权（按「发起方→目标 app」） | AppleScript 通道；缺了 -1743/-1744 | `checkAutomationPermission`（不弹框） |
| 目标应用在运行 | 依赖具体应用的任务（Chrome/BOSS/Ghostty…）；未运行一律跳过 | `isAppRunning`（含别名补全） |
| 7778/7789 端口与票据 | 小窗/daemon 相关步骤 | `npm run health` |

## 6. 已知盲区（不做无根据的保证）

- **Windows / UIA 后端**：没有实机验证，只有静态与文档（`flow/WINDOWS-TESTING.md`）。
- **第三方 ocu 内部**：默认应用、首次截图是否申请屏幕录制授权、CDP 端口实现细节等，来自二进制字符串与实测行为，不是我们能改的代码。
- **首次授权弹框时序**：需要真机「从未授权」状态，自动化测不了；只能靠预检避免触发。
- **多 Space / 多显示器 / 睡眠唤醒**：部分场景已修（不跟随 Space），但没做穷举实机验证。
- **长时间 soak**：24h 级别的稳定性只有历史巡检数据，不是每次收尾都跑。
- **写/投递类任务的真实副作用**：只做「门禁 + 判定单测」，不真的发消息/提交表单。

## 7. 每次收尾的固定验证串

~~~bash
npm test && npm run check && npm run repo:check && npm run safety:audit && npm run env:doc -- --check
npm run verify:safe        # 用户在场也能跑（不产生可见窗口）
npm run verify:live        # 只在屏幕解锁 + 空闲 ≥15 分钟时跑
~~~

> 任何一层失败都要定位到具体规则/用例再改；不许用 `--force` / 环境变量绕过门槛来「跑绿」。
