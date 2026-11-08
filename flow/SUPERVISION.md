# 外部监控日志（评审侧维护，执行侧按需读取）

> 我这边没有直接给你发消息的通道，所以把状态和指令写在这里。
> 每个阶段边界读一次即可；不用每轮都看。

## 当前状态（2026-11-08 22:39）

| 项 | 状态 |
| --- | --- |
| `npm test` | 1177 项 / 1175 过 / 2 跳过 / 0 失败 ✅ |
| `npm run repo:check` | 全部通过 ✅ |
| `npm run verify` | 全部通过 ✅ |
| 工作区 | **77 个文件未提交**（13 删 + 60 改 + 4 新增），最后一次提交 22:25 |
| 改名 | package.json 已是 dsh-rig / 0.8.0；launchd 标签已换 + 有 LEGACY 清理 |
| BOSS | 代码与文档基本清完（core 引用 0） |
| 未开始 | README 首屏、package 的 bin/files/repository/publishConfig、ocu 依赖、适配工作 |

## 现在请先做这两件事

1. **立刻提交**当前这一批（含 `docs/ADAPTERS.md`、`examples/`、两个新测试文件），
   提交信息说明「删 BOSS + 通用化改写 + 清单/夹具同步」
2. **删除 `flow/patch-publish.diff`**：它还写着 `@goodlifedog/desktop-agent` + `0.7.0`，
   与现在完全脱节；发布配置应直接落进 `package.json`

## 之后的优先级（不要跳）

1. `package.json` 补 `bin` / `files` / `repository` / `publishConfig`，加 `open-computer-use` 依赖
2. `resolveOcu()` 增加 `node_modules/open-computer-use/bin/ocu` 查找；打包从 node_modules 拷
3. README 首屏重写：标题 DSH Rig / 徽章 / 中英定位 / GIF 占位 / keywords
4. 许可：`files` 白名单包含 ocu 的 LICENSE / NOTICE / THIRD_PARTY_NOTICES
5. 适配工作按 `docs/ADAPTERS.md` 顺序，QQ / WPS / Ghostty 必须走 front-risk 名单

## 我这边会持续核验的事

- 每轮跑 `npm test` / `repo:check` / `verify`，确认没有为了推进而牺牲绿线
- 抽查新任务的守卫（锁屏跳过、用户在场让路、数据恢复、front-risk）
- 发布前做一次干净副本彩排：install（自动装 ocu）→ 测试 → 打包 → 全局安装 → doctor → publish dry-run
- 确认仓库与产物里没有真实姓名、本机路径、个人材料（含 git 历史）
