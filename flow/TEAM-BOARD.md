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

## 当前状态

- 安全评审 1 高危 + 5 中危 + 1 衍生（M-1b）全部修复并提交；全量 743 项测试通过。
- 小窗显示路径 R1–R6 修复完成，冷启动实测无窗口弹出。
- 待办：等用户离开足够久时跑一次 `verify:live` 完整验收（含会动屏幕的步骤）。