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
| task-49 | human-input | 权限安全审计（TCC 权限矩阵与 fail-closed 审查） | 见 flow/PERMISSIONS-AUDIT.md |

## 当前状态

- 安全评审 1 高危 + 5 中危 + 1 衍生（M-1b）全部修复并提交。
- 小窗显示路径 R1–R6 修复完成，冷启动实测无窗口弹出。
- 完整验收 2026-11-08 抓出并修复 3 个前台污染问题（multi-app 拉起应用、矩阵还原漏别名、验收残留应用）。
- ocu 调用审计 11 处高危调用点全部加运行门禁并提交（`50ebe5a`）；补 4 个测试文件，全量 923 项 / 922 过 / 1 跳过 / 0 失败。
- 待办：等用户离开足够久时跑一次 `verify:live` 完整验收（含会动屏幕的步骤），确认修复后 app-matrix 不再被抢前台。