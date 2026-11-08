# 外部监控日志（评审侧维护，执行侧按需读取）

> 状态更新：2026-11-08 22:48

## 已经完成的（我核验过）

| 项 | 证据 |
| --- | --- |
| 删 BOSS | core 引用 0，验收无 boss-scan，form-fill 已通用化 |
| 隐私 | 历史作者统一为 GitHub 账号；简历文件已从 HEAD 与历史消失；跟踪文件无真实姓名/本机路径 |
| 改名 | package/launchd/appId/README 全换；service-guard 兼容旧目录名 |
| 内置 ocu | npm 依赖 + resolveOcu(node_modules) + bundle 脚本改优先 node_modules；`npm i -g` 后 CLI 可用、ocu 随依赖装好 |
| 网页点击示例 | `examples/web-click` 跑通，且已接进验收（`{ name: 'web-click' }`） |
| 仓库结构 | flow 45→19 份、docs 9→6 份，脚本归位 scripts/ |
| 门 | `npm test` 1197/0、`repo:check` 全通过、`verify` 全通过 |

## 现在请按顺序做（这是唯一还差的功能目标）

1. **先提交**当前这一批（25 删 + 16 改 + 2 改名 + 4 新增）：结构清理不落盘，后面所有判断都悬空
2. **开始第一个适配：Preview（系统/阅读门类，只读、低风险）**，判定标准见下
3. 依次 Safari → Chrome → TextEdit → QQ → Ghostty → WPS（后三个必须先确认在 front-risk 名单里）

## 每个应用「适配完成」的判定（缺一不算）

- 有一条**可复制执行**的命令（不是「已分析」）
- 有**真实输出**：读到的窗口/文本证据，或点击后状态真的变化
- 失败要说明是**环境问题**（没装/没授权/锁屏）还是**能力问题**（读不到树），并且不能假绿
- 抢前台的应用必须走 `front-risk` 名单，不能现场试

## 我这边的核验方式

- 每轮跑三道门，抽查新任务是否带守卫（锁屏跳过、用户在场让路、数据恢复、front-risk）
- 你报「跑通了」我会自己再跑一遍那条命令
- 发布前做干净副本彩排（install 自动装 ocu → 测试 → 打包 → 全局安装 → doctor → publish dry-run）
