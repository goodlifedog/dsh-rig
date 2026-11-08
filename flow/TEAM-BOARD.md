# 团队分工与监督规则（Lead 维护）

> 用户要求：**不再新增成员**，固定复用现有 8 个；Lead 负责拆任务、派单、监督、抽样核验与统一提交。

## 成员与负责方向（按最近实际派单）

| 成员 | 负责方向 | 已完成（2026-11-08） |
| --- | --- | --- |
| overlay-dev | 小窗显示/门控/审查 | task-18 显示路径审查、task-27 R1–R6 修复 |
| cdp-bridge | CDP 通道与端口安全 | task-19 CDP 可接入性盘点、task-25 M-4 端口主人 fail-closed |
| greet-engineer | 进程组/孤儿清理 | task-22 M-1、task-29 M-1b |
| overlay-multi | 中止清理预算 | task-23 M-2 |
| human-input | 验收锁/并发 | task-24 M-3 |
| headless-engineer | 安全评审/token | task-20 独立安全评审、task-26 M-5 |
| boss-researcher | 请求头收口 | task-28 M-5b |
| ocu-recipe | 数据安全/笔记清理 | task-21 H-1 |

## 派单与监督规则

1. Lead 用 `team_task_create` 拆任务：必须写清目标、验收标准、**写作用域**、安全约束。
2. 成员先 `team_task_get` 读全文、`claim` 后执行；只跑目标单测，不跑全量 `npm test`（多人并行会互相干扰）。
3. 成员**不改 docs/ 与 flow/**（文档由 Lead 统一改）、**不 git commit**；报告必须给文件:行号。
4. 用户在场时禁一切会动屏幕/启停应用/重启服务的命令；需要时由 Lead 统一做并立即验证。
5. Lead 收到报告后：跑对应单测 + 抽样看 diff + 核流行号；确认后由 Lead 统一提交（提交信息注明子 agent 与核验方式）。
6. 并行冲突：同一文件的改动串行化（先改的先报告「文件已写完」，Lead 再放行下一个）。
7. 新任务优先复用空闲成员，**不新增成员**。

## 已完成批次（2026-11-08 第二轮）

- headless-engineer：L1+L2（/tmp 私有目录、profile 权限）
- overlay-dev：L3（AppleScript 引用安全）
- ocu-recipe：L4（--force-all 上限）、L4b（清理默认只关自己启动的应用）
- 全部由 Lead 核验目标单测 + diff 后统一提交；全量回归见下。

## 已完成批次（2026-11-08 第三轮：ocu 调用审计收口）

| 任务 | 成员 | 交付 | Lead 核验 |
| --- | --- | --- | --- |
| task-42 | headless-engineer | 批次 A 预检（terminal-control / drive-agent / drive-agent-cli） | 目标单测 + diff，提交 `50ebe5a` |
| task-43 | human-input | 批次 B（boss-scan / form-fill / boss-greet / mcp-demo / platform-demo） | 同上 |
| task-44 | overlay-dev | 批次 C（user-active-demo / background-control 文本编辑 / user-chrome-demo） | 同上 |
| task-45 | ocu-recipe | 批次 D（parallel-real-demo 双应用预检） | 同上 |
| task-46 | boss-researcher | P6 文档硬约束（docs/SECURITY.md、docs/MAC-APPS.md 第 9 条） | `repo:check` 全绿后提交 `d9ea159` |
| task-47 | headless-engineer | P4 常驻静态检查（规则 5 + 14 条白名单 + fixture 单测） | `safety:audit` / 全量测试后提交 `ec6053d`；Lead 另把扫描范围扩到 `core/*.mjs` 并修 open 规则误判 |
| task-48 | cdp-bridge | P1 根因层可选运行门禁（background 读写入口 opt-in） | 9 条单测 + 默认路径回归，提交 `b573cc6` |
| task-49 | human-input | 权限安全审计（TCC 权限矩阵与 fail-closed 审查） | 见 flow/PERMISSIONS-AUDIT.md，Lead 抽样核验 H1/H4/H5 后提交 `6ba0ed6` |
| task-50 | headless-engineer | H1 任务前权限闸门（runner/daemon 接线 + 纯函数 + 17 条单测） | 核验后提交 `9202961` |
| task-51 | ocu-recipe | H4 权限文案归类 + H5 自检三项分开 | 核验后提交 `9202961` |
| task-52 | cdp-bridge | H3 Safari 探针先运行/授权预检 | 核验后提交 `d81dd6b` |
| task-53 | human-input | H2 最小批次：三个脚本发 AppleEvent 前预检（sync-quit 300ms 不阻塞） | 核验后提交 `d81dd6b` |
| task-54 | overlay-dev | M1/M2 屏幕录制静默预检 + 窗口标题全空权限提示 | 核验后提交 `2bd5f8a` |
| task-55 | greet-engineer | H2 核心：前台读取改 ObjC（不发 AppleEvent）+ 回退开关 | 核验后提交 `8bf2ba1`；实测两种实现 20 次采样 100% 一致 |
| task-56 | boss-researcher | （作废）H2 剩余入口只读计划：子 agent 失败未产出，Lead 改为直接派实现单 | 已删除 |
| task-57 | overlay-multi | H2：acceptance 五处 AppleEvent 入口接静默预检 + 新增公共 helper | 核验后提交 `0a52f69` |
| task-58 | ocu-recipe | H2：browser / headless-demo 的 AppleEvent 入口补预检 | 核验后提交 `32cd7a8` |
| task-59 | headless-engineer | 规则 6：发 AppleEvent 前必须有自动化预检（静态防回归 + 10 条已知缺口登记） | 核验后提交 `9eb3fce`；Lead 追加缺口数量上限断言 |
| task-60 | boss-researcher | 应用适配广度调研（7 个候选 + 10 条不建议 + 最小可行步骤） | 核验后提交 `385c369`；INDEX 收录 |
| task-61 | headless-engineer | 适配第一批：新增 mail/calendar/reading/photos 门类 + media 补 Music（预设+单测+清点） | 核验后提交 `dc4faca`；清点 32→38 |
| task-62 | cdp-bridge | 清点口径：细分「部分验证（通道测过、矩阵未读）」+ 修 cdp-ok 判定 | 核验后提交 `1753042` |
| task-63 | ocu-recipe | 权限闸门覆盖面：认 callTool 界面工具与 ocu js 外层调用 | 核验后提交 `09415a9`；需 AX 任务 16→19 |
| task-64 | human-input | H2 缺口 A：6 个任务的本地 front() 改共享 frontName（去掉 System Events AppleEvent） | 核验后合并提交 `bb6fecd` |
| task-65 | cdp-bridge | H2 缺口 B：Chrome 标签与 app-matrix 前台还原接静默预检 | 核验后合并提交 `bb6fecd` |
| task-66 | ocu-recipe | H2 缺口 C：cleanup-test-data 的 TextEdit/Chrome AppleEvent 接静默预检 | 核验后合并提交 `bb6fecd` |
| task-67 | overlay-multi | 独立复核（只读）：AppleEvent 预检批次是否改变授权正常时的语义 | 0 高危；5 中危 + 8 低危，均已分流修复或记录取舍；Lead 核验后提交 `9a3b0df` 等 |
| task-68 | ocu-recipe | 独立复核（只读）：权限闸门/前台读取/入口守卫的回归风险 | 2 高危（daemon 预检窗口并发与 /stop 丢失）+ 4 中危 + 4 低危；Lead 修 `6e2a1dd`，其余分流到 task-69/70 |
| task-69 | headless-engineer | 复核修复：doctor fail-closed、权限文本不重试、doctor 超时收敛 | 核验后提交 `129a8d1` |
| task-70 | ocu-recipe | 复核修复：录屏判定剥注释、前台读取失败熔断 | 核验后提交 `3fcd769` |
| task-71 | cdp-bridge | 复核修复：Chrome 没运行不发事件、-1743/-1744 归环境跳过、matrix 还原错误处理 | 核验后提交 `a1ec1be` |
| task-72 | overlay-multi | 复核修复：清理跳过可见、验收收尾查终态前台、预检缓存分级 | 核验后提交 `9a3b0df` |
| task-73 | headless-engineer | L1：入口守卫统一 isDirectRun（realpath 归一），19 个入口 + 15 条测试 | 核验后提交 `466dbdd` |
| task-74 | overlay-multi（原 cdp-bridge 子 agent 连续失败后转派） | 只读复核 away-maintenance：2 高危 + 6 中 + 7 低 | Lead 修 H1/H2/M1–M5/L1/L2/L4/L7，提交 `1db1337` |
| task-75 | headless-engineer | L1 收尾：剩下 6 处手写入口守卫统一 | 进行中 |

## 当前状态

- 安全评审 1 高危 + 5 中危 + 1 衍生（M-1b）全部修复并提交。
- 小窗显示路径 R1–R6 修复完成，冷启动实测无窗口弹出。
- 完整验收 2026-11-08 抓出并修复 3 个前台污染问题（multi-app 拉起应用、矩阵还原漏别名、验收残留应用）。
- ocu 调用审计 11 处高危调用点全部加运行门禁并提交（`50ebe5a`）；补 4 个测试文件，全量 923 项 / 922 过 / 1 跳过 / 0 失败。
- 权限安全审计的 H1/H3/H4/H5 + M1/M2 已修复并提交（全量 1012 项 / 1010 过 / 2 跳过 / 0 失败）；H2 核心（前台读取不发 AppleEvent）已落地，剩余 acceptance/browser/headless-demo 的裸 AppleEvent 入口记为待办。
- 静态防回归补齐：规则 5（raw ocu 运行门禁）+ 规则 6（AppleEvent 自动化预检），`npm run safety:audit` 现在扫 123 个文件；规则 6 的 10 个已知缺口已清零（无豁免清单）。全量 1087 项 / 1085 过 / 2 跳过 / 0 失败。
- 待办：等屏幕解锁 + 用户离开足够久（≥15 分钟）时跑一次 `verify:live` 完整验收（含会动屏幕的步骤），确认修复后 app-matrix 不再被抢前台、权限闸门不会把正常步骤误跳过。当前屏幕处于锁定状态，`verify:live` 无法在锁屏下跑（AX/截图不可用），后台 watcher 会等「已解锁 + 空闲 ≥15 分钟」自动开跑。
- 2026-11-08 20:48 已把 daemon/overlay 服务重启到当前代码（之前落后 70+ 分钟），健康检查全部正常、`/selftest` 三项权限实测正确；锁屏下 `platform-smoke` 与 `cdp-channel`（headless）也实测通过，说明今天的改动没破坏平台层与 CDP 通道。
- 2026-11-08 20:53 锁屏下跑 `npm run verify:safe`：**7 PASS / 2 SKIP / 0 FAIL**（跳过的两项是后台稳定性与并发验证，锁屏下本就该跳过）；顺带修掉「健康统计行里的『其中 1 次环境跳过』让健康检查整步变 SKIP」的分类误判。
- 2026-11-08 21:5x **屏幕已解锁**后跑 `npm run verify:safe`：**9 项全 PASS（0 环境跳过 / 0 失败）**——语法、安全自查、健康、平台、清点、CDP headless、AppleScript 只读，以及之前锁屏时只能跳过的「后台操作稳定性 15 轮」和「并发验证（隐藏应用 + headless 浏览器）」这次都真跑且通过，说明今天这批权限/守卫/清理改动没有破坏后台控制与并发不打扰。
- 2026-11-08 21:1x 两个子 agent 独立只读复核今天全部改动：共 2 高危 + 若干中低危，已全部修复或明确记录取舍（daemon 预检窗口并发/取消、doctor fail-open、权限缺失误重试、注释误判录屏、前台读取耗时熔断、Chrome 未运行仍发事件、清理跳过不可见、验收无终态前台检查等）。全量 1145 项 / 1143 过 / 2 跳过 / 0 失败。
- 遗留低风险（已记录、暂不改）：① `invokedDirectly` 在仓库路径是符号链接时可能判 false（当前无 symlink）；② `OCU_JS_CLI_RE` 是 6 行窗口启发式；③ daemon 预检期间 /status 显示 stage=preflight 但 UI 未展示；④ 权限文本里「已授权 + 连接被拒绝」同时出现时会被判缺权限（健康面板罕见场景）。