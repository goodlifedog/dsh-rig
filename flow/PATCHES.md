# 外部评审提供的补丁

> 最后更新：2026-11-08 04:15。**3 个待应用补丁**，其余都已被主会话实现并删除。

## 待应用

```bash
git apply flow/patch-publish.diff        # 发布配置（发布前必打）
git apply flow/patch-repocheck-zip.diff  # repo:check 在非 git 目录（下载 ZIP）不再报红
git apply flow/patch-packaging-files.diff # 打包白名单补齐 main.js require 的所有模块
```

### `patch-publish.diff`（78 行 / 3 个文件）

- 包名换 scoped：`@goodlifedog/desktop-agent`（原名 `desktop-agent` 在 npm 已被占用）
- 补 `bin` / `files` 白名单 / `repository` / `publishConfig`
  - `publishConfig.registry` 指官方源（本机 `~/.npmrc` 指向淘宝镜像，不加这条会发到镜像站，官方源上装不到）
  - `files` 排除评审与补丁类文档，并把 `ARCHITECTURE.md` 纳入（否则包内 `docs/USAGE.md` 的链接 404）
- CI 矩阵收窄到 macOS（项目只支持 macOS）
- README 徽章 `USER` → 真实用户名

应用后手动改两处：npm 用户名、GitHub 仓库地址。

验证：
```bash
npm publish --dry-run   # 必须显示 Publishing to https://registry.npmjs.org ... public access
npm pack --dry-run      # 约 138 files / 1.1 MB
```

### `patch-repocheck-zip.diff`（59 行 / 1 个文件）

**问题**：从 GitHub 下载 ZIP 的用户（没有 .git）跑 `npm run repo:check` 会看到
`❌ git 仓库可用 / git ls-files 失败`，一共「1 项未通过」——这条红跟代码质量无关。

补丁：git 不可用时把三项依赖 git 的检查（依赖产物、孤儿图、大文件）标成「跳过」而不是失败，
汇总里用 ⏭️ 显示且不计入未通过。实测：无 .git 目录下输出「全部通过」，三项显示跳过。

验证：
```bash
rsync -a --exclude .git ./ /tmp/zipcheck/ && cd /tmp/zipcheck && node scripts/repo-check.mjs
```

### patch-packaging-files.diff（82 行 / 2 个文件）

**问题（打包版起不来）**：overlay/electron-builder.yml 的 files 只列了 9 个 js，
而 main.js 实际 require 14 个本地模块——recover.js / host-select.js / session-policy.js /
capture-policy.js / frame-target.js / layout.js / image-meta.js / crash-log.js / quote.js 都不在名单里。
照这个配置打出来的 App 一启动就是 MODULE_NOT_FOUND。

补丁：files 改为通配 "*.js" + index.html + package.json（并排除 start.mjs / smoke-http.js 两个开发脚本），
另加 test/overlay-packaging.test.mjs：**解析 yml 白名单，断言 main.js 每个 require 的模块都被覆盖**，以后再拆模块忘了加也不会漏。

验证：
```bash
node --test test/overlay-packaging.test.mjs
```

## 已采纳并删除的补丁

| 补丁 | 落地方式 |
| --- | --- |
| `patch-p1.diff` | 七项修复由主会话自行实现（含测试） |
| `patch-classify.diff` | `HARD_FAIL` 优先于环境规则（`d49be81`） |
| `patch-electron-task-test.diff` | 5 条单测已落地 |
| `patch-ensure-app-window-test.diff` | 与 `test/app-window-ready.test.mjs` 重复，未采纳 |
| `patch-chromium-applescript.diff` | chromium 通道链已加 applescript |
| `patch-token-permissions.diff` | 主会话的 `hardenDataDir` 更完整（含敏感子目录） |
| `patch-host-check.diff` | `isLoopbackHost` 已落地 daemon 与 overlay |
| `patch-dialog-i18n.diff` | 改成结构判定 + `unknown` 不点，比补丁更稳 |
| `patch-retry-unify.diff` | `retry-policy` 已复用 `ENV_RULES` |
| `patch-health-queue.diff` | `health` 队列显示改读 `queueLength` |
| `patch-formfill-restore.diff` | 改成 catch 里补 `restore-after-error`，语义等价且不重复写 |
| `patch-textedit-guard.diff` | 已采纳：`core/text-edit-guard.mjs` + 写入前判空文稿 |
| `patch-cleanup-idle.diff` | 主会话做得更全：`launchedByUs` + `shouldQuitApp` + HID 空闲 |
| `patch-watchdog-hid.diff` | 看门狗改用 HID 空闲判用户意图 |
| `patch-deploy-freshness.diff` | `core/deploy-freshness.mjs` + service 接线 + 单测 |
| `patch-prune-consolidate.diff` | `planPrune` 归位 `core/prune.mjs` |
| `patch-title-gate.diff` | 标题门控不再用裸子串 |
