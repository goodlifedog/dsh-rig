# 外部评审提供的补丁

> 最后更新：2026-11-08 05:45。**只剩 1 个待应用补丁**，其余都已被主会话实现并删除。

## 待应用

```bash
git apply flow/patch-publish.diff        # 发布配置（发布前必打）
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
npm pack --dry-run      # 约 138 files / 1.1 MB
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
