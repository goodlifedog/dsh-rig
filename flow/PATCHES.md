# 外部评审提供的补丁（按需应用）

> 这些不是必须打的。每个都独立可应用、互不冲突，打过之后 `npm test` 全绿。
> 最后更新：2026-11-08 03:05。当前共 3 个，均已 `git apply --check` 通过。

## 顺序建议

```bash
git apply flow/patch-publish.diff            # 发布配置（发布前必打）
git apply flow/patch-prune-consolidate.diff  # 死代码合并（可选，建议打）
git apply flow/patch-deploy-freshness.diff   # 代码新鲜度检查（可选，建议打）
npm test && npm run repo:check
```

三个一起打之后实测：424 项测试全过、`repo:check` 全绿。

## 1. `patch-publish.diff`（78 行 / 3 个文件）

**发布前必打。**一次性解决六件事：

- 包名换成 scoped（`@goodlifedog/desktop-agent`，原名字在 npm 上被占用）
- 补 `bin`（`desktop-agent` 命令）、`files` 白名单（打包 249 文件 4.3MB → **138 文件 1.1MB**）
- 白名单额外排除评审/补丁类文档（`flow/REVIEW-*.md`、`flow/patch-*.diff`、`flow/BOSS-EXTRACT.md`、`flow/INDEX.md`、`docs/HANDOFF-*.md`）——这些是开发产物，尤其 `BOSS-EXTRACT.md` 是「怎么把招聘平台内容摘出去」的方案，随包公开很尴尬
- 同时**把根目录 `ARCHITECTURE.md` 加进白名单**：它是用户要读的架构说明，之前漏掉导致包内 `docs/USAGE.md` 的链接 404
- 排除后实测包内 9 处相对链接全部有效
- 补 `repository` 字段
- 补 `publishConfig`：`registry` 指官方源 + `access: public`（本机 npm 默认指向淘宝镜像，不加这条会发到镜像站，官方源上装不到）
- CI 矩阵收窄到 macOS（项目只支持 macOS，三平台会让徽章常年红）
- README 徽章占位 `USER` → 真实用户名

应用后还要手动改两处：npm 用户名、GitHub 仓库地址。

验证：
```bash
npm publish --dry-run   # 必须显示 Publishing to https://registry.npmjs.org ... public access
npm pack --dry-run      # 应显示 138 files / 1.1 MB
```

## 2. `patch-prune-consolidate.diff`（120 行 / 3 个文件）

清掉一份死代码：`core/prune.mjs` 的四个导出（`logTimestamp` / `selectStaleLogs` / `selectExcessReports` / `isPrunablePath`）全仓零引用，
真实逻辑在 `scripts/prune.mjs` 里自带一份。补丁把 `planPrune` 归位到 `core/prune.mjs`，
`scripts/prune.mjs` 只留 CLI，测试改 import 路径。

验证：
```bash
node scripts/prune.mjs      # 三段统计 + 可释放 X MB 都正常
node --test test/prune.test.mjs
```

## 3. `patch-deploy-freshness.diff`（191 行 / 3 个文件）

给 `npm run service:status` 加一列「代码新鲜度」：把每个常驻进程**启动时会加载的模块**的 mtime
和进程启动时间比，落后就提示 `npm run service:restart`（只提示，不自动重启）。

解决的问题：改了 `agentd.mjs` / `overlay/server.js` 这类启动时加载的文件却没重启时，
原来的「部署状态：ok」照样显示 ok，排查时会误以为改动没生效。

验证：
```bash
touch core/agentd.mjs && npm run service:status
# 应出现：daemon 代码新鲜度：落后 —— core/agentd.mjs 比进程新 N 分钟，建议 npm run service:restart
git checkout -- core/agentd.mjs   # 撤销 touch
```

## 已作废（不要再应用）

`patch-p1.diff`、`patch-classify.diff`、`patch-electron-task-test.diff`、`patch-ensure-app-window-test.diff`
对应实现都已在代码里，文件已删除；从 git 历史可查到。