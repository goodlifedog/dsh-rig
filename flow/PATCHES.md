# 外部评审提供的补丁

> 最后更新：2026-11-08 07:20。**3 个待应用补丁**，其余都已被主会话实现并删除。

## 待应用

```bash
git apply flow/patch-publish.diff        # 发布配置（发布前必打）
# patch-scope-lock 已应用（锁屏时 scope:check 环境跳过），文件已删
# patch-ports 已应用（端口单一来源 core/ports.mjs），文件已删
# repocheck-zip / packaging-files 已应用（ZIP 降级 + 打包白名单），文件已删
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
npm pack --dry-run      # 约 147 files / 1.1 MB
```

### ✅ `patch-repocheck-zip.diff`（59 行 / 1 个文件）—— 已应用，补丁文件已删除

**问题**：从 GitHub 下载 ZIP 的用户（没有 .git）跑 `npm run repo:check` 会看到
`❌ git 仓库可用 / git ls-files 失败`，一共「1 项未通过」——这条红跟代码质量无关。

补丁：git 不可用时把三项依赖 git 的检查（依赖产物、孤儿图、大文件）标成「跳过」而不是失败，
汇总里用 ⏭️ 显示且不计入未通过。实测：无 .git 目录下输出「全部通过」，三项显示跳过。

验证：
```bash
rsync -a --exclude .git ./ /tmp/zipcheck/ && cd /tmp/zipcheck && node scripts/repo-check.mjs
```

### ✅ patch-packaging-files.diff（82 行 / 2 个文件）—— 已应用，补丁文件已删除

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

### ✅ patch-index-coverage.diff（29 行 / 1 个文件）—— 已应用，补丁文件已删除

**问题**：`flow/` 下新写的文档经常忘记加进 `INDEX.md`（我自己就漏了三轮，累计 10 份没入口）。

补丁：`repo:check` 增加一条「flow 文档都能从 INDEX 找到」——列出未收录的文档名，
`INDEX.md` 与 `BOSS-*.md`（公开前要移除）豁免。实测：新建一个未收录文档立刻报红，加进 INDEX 后恢复绿。

验证：
```bash
npm run repo:check   # 应显示「29 份文档都有入口」
```

### ✅ patch-tasks-catalog.diff（207 行 / 6 个文件）—— 已应用，补丁文件已删除

**问题**：31 个任务脚本没有任何地方列全过。`desktop-agent tasks` 只输出名字，用户不知道每个任务是干什么的；
其中 3 个（browser-background / cold-launch / user-active-demo）在所有文档里一个字都没提到。

补丁：
- 新增 `scripts/tasks-doc.mjs` + `npm run tasks:doc`：扫描 `core/tasks/*.mjs` 的文件头注释，生成 `flow/TASKS.md`
- 写操作类任务自动标 ⚠️；缺文件头说明的标「（文件头没写用途说明）」——目前 17 个属于这种
- `repo:check` 增加「任务清单与 core/tasks 同步」：改了任务没重新生成就报红
- 4 条单测覆盖解析/标记/缺说明

验证：
```bash
npm run tasks:doc && npm run repo:check
```

### ✅ patch-bundle-provenance.diff（106 行 / 2 个文件）—— 已应用，补丁文件已删除

**问题**：`scripts/bundle-ocu.mjs --with-binary` 会把第三方 ocu 运行时（37MB）拷进分发产物，
NOTICE.md 里只记了版本/许可/仓库，**没有二进制指纹**——发出去的到底是哪一份运行时，事后无法核对。

补丁：拷贝后计算 `bin/ocu` 的 sha256 写进 NOTICE.md（取不到时明确写「未取到」），
并把 NOTICE 生成抽成纯函数 `buildNotice()` + 3 条单测。

验证：
```bash
node --test test/bundle-ocu.test.mjs
node scripts/bundle-ocu.mjs --with-binary && cat third_party/open-computer-use/NOTICE.md | grep sha256
```

### ✅ patch-doc-refs.diff（58 行 / 1 个文件）—— 已应用，补丁文件已删除

**问题**：文档里写死的文件名会腐烂——`THIRD-PARTY.md` 引用已删除的 `frames.mjs`、
`flow/CDP-FALLBACK.md` 引用带 `desktop-agent/` 前缀的路径，都没人发现。

补丁：`repo:check` 增加「文档引用的源文件都存在」——扫描 README/ARCHITECTURE/THIRD-PARTY/docs/flow 里
反引号中的 `xxx.mjs|js|cjs|ps1|html|yml`，带路径的按仓库根判断、只写名字的按已知文件名集合判断。
排除历史文档（REVIEW/HANDOFF）与补丁索引（写的是应用后才有的文件）。

实测：在 README 里加一句引用 `core/deleted-file.mjs` 立刻报红；恢复后全绿。

### ✅ patch-calc-flaky.diff（38 行 / 1 个文件）—— 已应用，补丁文件已删除

**问题（实测抓到）**：完整验收跑下来 `background-control` 偶发失败：
`{"name":"后台点击计算器按钮","ok":false,"frontUnchanged":true,"detail":"7 → 7"}` ——
点击没抢前台，但显示值没变。可能是上一次运行残留的显示值本来就是 7，或 AX 点击落空。

补丁：点击前先按 AC 归零（找不到就跳过），并最多重试 3 次直到显示值真的变化；
抢了前台就立刻停止重试。

验证：应用后在真实仓库跑 `npm run accept`，这一项应稳定 PASS。
（我在临时克隆里跑这个任务时 ocu 运行时缺失导致 MCP 崩溃，无法在克隆里端到端验证。）

### ✅ patch-accept-front.diff（105 行 / 2 个文件，含 5 条单测）—— 已应用，补丁文件已删除

**问题（实测抓到的验收失败链）**：完整验收里 `background-control` 记录「全程前台未被抢占 Calculator → Calculator」——
**任务开始时前台就已经是 Calculator**，不是用户的 Chrome。说明前面某个任务（multi-app 读 Finder/Calculator）
把测试应用留在前台了。后果是后续任务的「起点前台」基线全歪，`app-matrix` 因此判失败。

补丁：把「该不该还原」抽成纯函数 `shouldRestoreFront(current, frontAtStart)`（5 条单测覆盖），`runTask()` 每个任务之后调用一次，
还原本人（用户自己切走的不动）。这样每个任务的判定基线都是用户原来的应用。

验证：应用后跑 `npm run accept`，日志里每个任务后应出现「（已把前台还给 …）」，
`background-control` 的起点前台应是用户应用而不是 Calculator。

### ✅ patch-ports.diff（191 行 / 6 个文件）—— 已应用，补丁文件已删除

**问题（实测）**：文档写着 `AGENTD_PORT` 可改 daemon 端口，但只有 `daemon.mjs` / `cli.mjs` /
`service.mjs` 读它；`health` / `status` / `doctor` / `restart-check` 里写死 7789。
用户改了端口后，daemon 在新端口监听，而所有诊断工具仍去敲 7789，全体报「服务未启动」。

补丁：新增 `core/ports.mjs`（`daemonPort()` / `overlayPort()` / `daemonUrl()` / `overlayUrl()`，
非法值回退默认），四个诊断入口改为从它取端口。实测：`AGENTD_PORT=7799 node core/platform-smoke.mjs`
现在会如实报「后台 daemon 7799 未启动」，而不是显示 7789 上那台服务；默认端口下一切不变。

范围说明：本次只统一了 **daemon 端口**（4 处写死 + cli/service/daemon）。
overlay 侧的 7788 还有约 18 处（7 个任务 + 11 个脚本），改端口目前要同时设 `OVERLAY_URL`，
已在 docs/USAGE.md 写明配对关系；全量统一收益不高、改动面大，留作发布后再做。

验证：
```bash
node --test test/ports.test.mjs
AGENTD_PORT=7799 npm run doctor   # 应报 7799 未启动
npm run doctor                     # 应全绿
```

### ✅ patch-scope-lock.diff（28 行 / 1 个文件）—— 已应用，补丁文件已删除

**问题（实测）**：锁屏状态下跑 `npm run scope:check` 会红——`❌ 读得到当前会话标题 拿不到 dshTitle`。
锁屏时系统前台是 loginwindow，宿主窗口标题读不到，这是环境限制，不是会话隔离坏了。
项目里其它依赖 AX/前台的任务都已经改成「锁屏 → 环境跳过」，这个脚本还没跟上。

补丁：入口检测锁屏，命中直接打印「环境跳过：屏幕已锁…」并返回 0（与 background-stability / cold-launch 等一致）；
未锁屏但拿不到标题时，把提示补成「DSH 窗口不在前台？锁屏或最小化」。

验证：
```bash
npm run scope:check   # 锁屏下应显示环境跳过、退出码 0；解锁后仍跑完整 7 项
```

### patch-monitor-detail.diff（58 行 / 2 个文件）

**问题（实测）**：`npm run monitor` 输出里有两处自相矛盾：

- `✅ 会话隔离 0.1s 未通过`：明细兜底统一回落成字符串「未通过」，即使这一项是跳过/通过
  真实原因：锁屏时 scope:check 直接返回、没有任何明细行，兜底文案就露出来了
- `43437B（undefinedpx 宽出图，收起态）`：收起态 `target.width` 拿不到值，模板直接拼成 undefinedpx

补丁：明细兜底按 `ok` 区分（通过写「本项没有明细输出」，失败才写「未通过（且无输出）」）；
帧率显示宽度回落到实际使用的 600px。

实测修正后：`✅ 会话隔离 （本项没有明细输出）`、`43450B（600px 宽出图，收起态）`。

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
