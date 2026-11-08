# 文档索引（按「想做什么」找）

> `flow/` 只放**长期规范**：能回答「怎么做」的文档。一次性过程记录（评审/复盘/交接/台账/任务单/已收口的审计）
> 已移出仓库归档，不在这里。找入口也可从 [README](../README.md) 的目录进。

| 我想… | 看这份 |
| --- | --- |
| 让它控制某个应用（能做什么、怎么控、有什么坑） | [BACKGROUND-CONTROL.md](BACKGROUND-CONTROL.md) + [../docs/MAC-APPS.md](../docs/MAC-APPS.md) |
| 知道它为什么能支持一大类软件（运行时/通道/驱动链） | [../docs/APP-SUPPORT-ARCHITECTURE.md](../docs/APP-SUPPORT-ARCHITECTURE.md) |
| 加一个新应用或新门类进适配 | [../docs/MAC-APPS.md](../docs/MAC-APPS.md) + [../docs/ADAPTERS.md](../docs/ADAPTERS.md) |
| 搞 Chrome / 浏览器后台控制 | [CDP-FALLBACK.md](CDP-FALLBACK.md) |
| 哪些应用能走 CDP（实测/理论/不支持三档） | [CDP-READINESS.md](CDP-READINESS.md) |
| 看它现在健康不健康、验收跑什么 | [MONITORING.md](MONITORING.md) + [COVERAGE.md](COVERAGE.md) |
| 查安全边界（能防什么、还差什么） | [../docs/SECURITY.md](../docs/SECURITY.md) |
| 看 ocu（底层能力）怎么接进来、怎么跟进上游 | [OCU-INTEGRATION.md](OCU-INTEGRATION.md) + [OCU-SYNC.md](OCU-SYNC.md) |
| 打包、发布、CI | [PACKAGING.md](PACKAGING.md) + [PUBLISH.md](PUBLISH.md) |
| Windows / 跨平台怎么跑 | [WINDOWS-TESTING.md](WINDOWS-TESTING.md) + [CROSS-PLATFORM.md](CROSS-PLATFORM.md) |
| 写写入/投递类任务（不碰用户数据） | [WRITE.md](WRITE.md) |
| 写任务时日志怎么标（PASS / FAIL / 环境跳过 / ❌） | [TASK-OUTPUT.md](TASK-OUTPUT.md) |
| 代码风格与工程约定 / 技术选型 | [CODEX-STANDARD.md](CODEX-STANDARD.md) + [CODEX-TECH-STACK.md](CODEX-TECH-STACK.md) |
| 外部监控侧现在看到什么（评审侧维护的日志） | [SUPERVISION.md](SUPERVISION.md) |

## 自动生成的清单（别手改，跑命令重新生成）

- 有哪些任务、各自做什么：[TASKS.md](TASKS.md)（`npm run tasks:doc`）
- 有哪些环境变量、默认值多少：[TASK-ENV.md](TASK-ENV.md)（`npm run env:doc`）

## 常用命令

```bash
npm run verify         # 语法检查 + 单测 + 仓库体检（提交前跑）
npm run verify:safe    # 不碰屏幕的验收（用户在场也能跑）
npm run accept         # 端到端验收（会切窗口；你在用电脑时会被拒绝，ACCEPT_FORCE=1 强跑）
npm run apps:inventory # 本机装的应用里哪些已适配、哪些没测
npm run app:resolve -- Finder   # 某个应用现在能用哪条通道
npm run cleanup:test   # 清测试数据（默认只报告，--force 只删带 [AGENT-TEST] 标记的笔记）
npm run prune          # 日志/报告轮转（默认演练，--apply 真删）
npm run service:status # 服务是否由 launchd 管理、有没有游离进程占端口
```

## 维护约定

- 新增能力要同时更新 [CHANGELOG.md](../CHANGELOG.md) 和对应规范文档；`npm run repo:check` 会检查后台 API 是否有文档、文档引用是否失效。
- `flow/` 只收规范；评审/复盘/交接/一次性任务单请放仓库外归档目录，不要提交进来。
- 新增/移动流程脚本放 `scripts/`（不要放 `flow/`）。
