# 外部评审提供的补丁（按需应用）

> 这些不是必须打的。每个都独立可应用、互不冲突，打过之后 `npm test` 全绿。
> 最后更新：2026-11-08 03:40。**当前只剩 3 个**，其余都已被主会话自行实现并删除。

## 应用程序

```bash
git apply flow/patch-publish.diff            # 发布配置（发布前必打）
git apply flow/patch-prune-consolidate.diff  # prune 死代码合并（建议打）
git apply flow/patch-deploy-freshness.diff   # 代码新鲜度检查（建议打）
npm test && npm run repo:check
```

## 1. `patch-publish.diff`（78 行 / 3 个文件）— 发布前必打

- 包名换 scoped（`@goodlifedog/desktop-agent`，原名在 npm 被占）
- 补 `bin` / `files` 白名单 / `repository` / `publishConfig`（绕开本机淘宝镜像指向官方源）
- `files` 额外排除评审与补丁类文档（`flow/REVIEW-*.md`、`flow/patch-*.diff` 等），并把 `ARCHITECTURE.md` 纳入
- CI 矩阵收窄到 macOS；README 徽章 `USER` → 真实用户名

应用后手动改两处：npm 用户名、GitHub 仓库地址。

验证：
```bash
npm publish --dry-run   # 必须显示 Publishing to https://registry.npmjs.org ... public access
npm pack --dry-run      # 约 138 files / 1.1 MB
```

## 2. `patch-prune-consolidate.diff`（120 行 / 3 个文件）

`core/prune.mjs` 的四个导出全仓零引用，真实逻辑在 `scripts/prune.mjs` 里另有一份。
补丁把 `planPrune` 归位到 `core/prune.mjs`，`scripts/prune.mjs` 只留 CLI，测试改 import。

验证：`node scripts/prune.mjs`、`node --test test/prune.test.mjs`

## 3. `patch-deploy-freshness.diff`（191 行 / 3 个文件）

给 `npm run service:status` 加「代码新鲜度」：把每个常驻进程启动时加载的模块 mtime 与进程启动时间比，
落后就提示 `npm run service:restart`（只提示，不自动重启）。

验证：`touch core/agentd.mjs && npm run service:status` 应出现「落后 —— core/agentd.mjs 比进程新 N 分钟」。

## 已采纳并删除的补丁（留档，不要再找）

| 补丁 | 落地情况 |
| --- | --- |
| `patch-p1.diff` | 七项修复由主会话自行实现（含测试），补丁作废 |
| `patch-classify.diff` | `envSkipReason` 的 ❌ 覆盖已落地 |
| `patch-electron-task-test.diff` | 5 条单测已落地 |
| `patch-ensure-app-window-test.diff` | 与 `test/app-window-ready.test.mjs` 重复，未采纳 |
| `patch-chromium-applescript.diff` | chromium 通道链已加 applescript |
| `patch-token-permissions.diff` | 主会话的 `hardenDataDir` 更完整 |
| `patch-host-check.diff` | `isLoopbackHost` 已落地 daemon 与 overlay |
| `patch-dialog-i18n.diff` | 主会话改成结构判定 + `unknown` 不点，比补丁更稳 |
| `patch-retry-unify.diff` | `retry-policy` 已复用 `ENV_RULES` |
| `patch-health-queue.diff` | `health` 队列显示已改读 `queueLength` |
