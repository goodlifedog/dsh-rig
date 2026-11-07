# 文档索引（按「想做什么」找）

> `flow/` 里文档多，先看这张表，最多十条。找不到再从 [README](../README.md) 的目录进。

| 我想… | 看这份 |
| --- | --- |
| 让它控制某个应用（能做什么、怎么控、有什么坑） | [BACKGROUND-CONTROL.md](BACKGROUND-CONTROL.md) + [../docs/MAC-APPS.md](../docs/MAC-APPS.md) |
| 知道它为什么能支持一大类软件（运行时/通道/驱动链） | [../docs/APP-SUPPORT-ARCHITECTURE.md](../docs/APP-SUPPORT-ARCHITECTURE.md) |
| 加一个新应用或新门类进适配 | [../docs/MAC-APPS.md](../docs/MAC-APPS.md) 第七节 + `core/app-presets.mjs` |
| 看它现在健康不健康、验收跑什么 | [MONITORING.md](MONITORING.md) + [COVERAGE.md](COVERAGE.md) |
| 查安全边界（能防什么、还差什么） | [../docs/SECURITY.md](../docs/SECURITY.md) |
| 搞 Chrome / 浏览器后台控制 | [CDP-FALLBACK.md](CDP-FALLBACK.md) |
| 看 ocu（底层能力）怎么接进来的 | [OCU-INTEGRATION.md](OCU-INTEGRATION.md) |
| 打包、发布、CI | [PACKAGING.md](PACKAGING.md) + [PUBLISH.md](PUBLISH.md) |
| Windows 上跑（未实机验证） | [WINDOWS-TESTING.md](WINDOWS-TESTING.md) + [CROSS-PLATFORM.md](CROSS-PLATFORM.md) |
| 写入/投递类任务的规则 | [WRITE.md](WRITE.md) + [BOSS-RULES.md](BOSS-RULES.md) |

## 发布与协作（新加的，放这里免得找不到）

| 我想… | 看这份 |
| --- | --- |
| 现在到底能不能发（Go/No-Go + 实测证据） | [PUBLISH-VERDICT.md](PUBLISH-VERDICT.md) |
| 把它公开出去（GitHub / npm）的步骤 | [PUBLISH-CHECKLIST.md](PUBLISH-CHECKLIST.md) |
| 外部评审留的补丁怎么打 | [PATCHES.md](PATCHES.md) |
| 把 BOSS 那部分从公开面摘掉 | [BOSS-EXTRACT.md](BOSS-EXTRACT.md) |
| 多会话 / 多 agent 一起用这个仓库 | [AGENT-COORDINATION.md](AGENT-COORDINATION.md) |
| 看外部评审提过什么、还剩什么 | [REVIEW-ACTIONS.md](REVIEW-ACTIONS.md) + [REVIEW-RETRO.md](REVIEW-RETRO.md) |

## 常用命令

```bash
npm run verify        # 语法检查 + 单测 + 仓库体检（提交前跑；不含端到端验收和打包检查）
npm run accept        # 端到端验收（含新通道；你在用电脑时会被拒绝，加 ACCEPT_FORCE=1 可强跑）
npm run apps:inventory   # 本机装的应用里哪些已适配、哪些没测
npm run app:resolve -- Finder   # 某个应用现在能用哪条通道
npm run cleanup:test  # 清测试数据（默认只报告；--force 只删 [AGENT-TEST] 标记的笔记；--force-all 才放开历史测试词与按条数删）
npm run prune         # 日志/报告轮转（默认演练，--apply 真删）
npm run service:status   # 服务是否由 launchd 管理、有没有游离进程占端口
```

## 维护约定

- 新增能力要同时更 [CHANGELOG.md](../CHANGELOG.md) 和对应文档；`npm run repo:check` 会检查后台 API 是否有文档。
- 评测/外部评审记录放 `flow/REVIEW-*.md`，只读巡检脚本是 `flow/review-watch.mjs`。
