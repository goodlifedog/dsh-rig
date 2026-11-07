# 评审待办（外部检查者维护）

> 只列**还没做**的。已修好的沉到底部，不复述。
> 详细理由见 [`REVIEW-2026-11-07.md`](REVIEW-2026-11-07.md)，发布流程见 [`PUBLISH-CHECKLIST.md`](PUBLISH-CHECKLIST.md)。
> 更新：2026-11-08 17:00（**P1 全部由主会话自行实现并有测试**；`patch-p1.diff`、`patch-classify.diff` 已删除——两处实现都已落地，补丁再 apply 会失败。单测 400+）
>
> 旧记录：2026-11-08 15:00（`flow/patch-p1.diff` = **232 行 / 7 个文件**，新增 `core/runner.mjs`：日志写入从 `void fd.write()` 改为同步写，避免退出时末行丢失。**`docs/REVIEW.md` 那份 18 条旧审查，现在全部要么已验证修复、要么已进补丁。**）
  ① `node core/cli.mjs foo` → 退出码 2，用法输出到 stderr
  ② 死进程旧锁 → 抢锁成功且内容改写成本进程；活进程旧锁 → 拒绝抢
  ③ `cli stop` 在 launchd 托管下 → 打印暂停/卸载/重启指引，**daemon 未被杀**（7789 仍 200）
  ④ `start-all` 在 daemon+overlay 都在跑时 → 打印「小窗已在运行，跳过」，不产生第二个窗口
  ⑤ daemon 未捕获异常处理：仅静态确认（难以在测试里稳定注入）

## 当前有效补丁（可直接 `git apply`）

```
flow/patch-publish.diff              发布配置（包名/bin/files/repository/publishConfig/CI/徽章）
flow/patch-electron-task-test.diff   5 条 electron-task 单测
flow/patch-ensure-app-window-test.diff  6 条 ensureAppWindow 单测
flow/patch-deploy-freshness.diff     代码新鲜度检查（service:status 能报「跑的是旧代码」）
```

其余补丁已作废删除（对应实现已在代码里）。

## P0 · 公开前必须处理（3 条）

### 1. BOSS 直聘内容不该出现在公开仓库

- 现状：4 个 `boss-*` 任务、1 个 `greet-inner`、3 份 BOSS 文档（582 行）、README 首页有案例、**npm 包里也带着**
- 执行方案已写好：[`BOSS-EXTRACT.md`](BOSS-EXTRACT.md)（要删哪些、验收怎么补、怎么复查包）
- 需要你决定：**摘出去** / 保留但不上首页、加免责声明、删风控章节

### 2. 发布配置（补丁已备，`git apply flow/patch-publish.diff`）

- 一次解决：包名 scoped、`bin`、`files` 白名单（1.1MB / 143 文件）、`repository`、`publishConfig`（绕开淘宝镜像）、CI 矩阵、README 徽章
- 应用后替换两处占位：`@goodlifedog/desktop-agent`、`github.com/tester/desktop-agent`
- 验证：`npm publish --dry-run` 必须显示 `Publishing to https://registry.npmjs.org ... public access`

### 3. 笔记删除缺最后一层标记

- 现状：`core/note-cleanup.mjs` 删除行时不看标题（靠「只删顶部 N 条 + `--force`」挡着）
- 建议：删除前读 `name of rr`，只删 `[AGENT-TEST]` 前缀；写入时统一加该前缀

## P1 · ✅ 已全部由主会话实现（保留记录，勿再照做）

### 4. ✅ overlay 会话回收的「最近活动」保护（已实现：`overlay/session-policy.js`，有测试）

- 现状：到上限 12 时回收「不可见 + 最久没活动」的会话；但 **DSH 不在前台时所有会话都不可见**
- 正在被任务使用的会话可能被误回收。建议：`Date.now() - at < 60_000` 的不回收

### 5. ✅ 资源清理外包给调用方（复查后判定不用改，见下）

- 原判断：9 个任务里 `closeOcuMcp()` 在 finally 出现 0 次，担心泄漏
- **实测推翻了**：父进程正常 exit 或被 SIGTERM 杀掉时，MCP 子进程都自己退出了（stdio 关闭触发），打了 exit 钩子和没打补丁的对照结果一样干净
- 结论：这条**不用改**。真正需要 finally 的是「进程不退出但资源要释放」的场景，这里不适用

### 6. ✅ `npm stop` 谎报（已实现：launchd 托管给指引）（**✅ 已实现**）

- launchd 托管时 `logs/daemon.pid` 不存在 → kill 静默跳过 → 仍打印「已停止」；且 `KeepAlive` 会立刻拉回
- 建议：先判断是否 launchd 托管，托管时明确提示用 `service:uninstall`/`launchctl bootout`

### 7. ✅ `npm start` 双开小窗（已实现：探测 7788）（**✅ 已实现**）

- `start-all.mjs` 对 daemon 有复用判断，对小窗没有；已装服务时再跑 `npm start` → 第二个 Electron 绑 7788 失败但窗口照样显示
- 注意：探 7788 必须带 `localHeaders()`，否则 401 会误判成「没在跑」

### 8. ✅ 常驻进程兜底异常（已实现：daemon 两个 handler）（**✅ 已实现**）

- `daemon.mjs` / `runner.mjs` 无 `uncaughtException`/`unhandledRejection`；`overlay/main.js` 无 `render-process-gone`

### 8.5 ✅ `ocu` 缺失时的可读报错（已实现，配 `test/ocu-mcp-start.test.mjs`）

- 老审查（`docs/REVIEW.md` 1.4）提过 `ocu-mcp.mjs` 的 spawn 没有 `error` 监听，至今未修
- 实测：`new OcuMcp({ bin: '/nonexistent/ocu' }).start()` → `UNCAUGHT: spawn ... ENOENT`，任务进程直接崩
- 补丁后：`start 抛错：ocu 可执行文件无法启动（...）：spawn ... ENOENT`，是一条能看懂的错误
- 影响：用户机器上 ocu 没装/路径不对时，看到的是崩溃栈而不是「请先装 ocu」
- 建议：记日志后继续服务；overlay 崩了重载并把事件写进 `/health`

## P2 · 打磨（按需，不阻塞发布）

### 2.9 `core/prune.mjs` 是死代码，和 `scripts/prune.mjs` 逻辑重复（**补丁已备**：`flow/patch-prune-consolidate.diff`）

- `core/prune.mjs`（58 行）导出 `logTimestamp` / `selectStaleLogs` / `selectExcessReports` / `isPrunablePath`，**全仓零引用**（含测试）
- 真正在用的是 `scripts/prune.mjs` 自己的 `planPrune`（`npm run prune` 和 `test/prune.test.mjs` 都走它）
- 两个文件写的是一回事：一套在 core 里没人用，一套在 scripts 里带测试
- **已按方案②出补丁**：`planPrune` 移进 `core/prune.mjs`（清掉四个零引用导出），`scripts/prune.mjs` 改为 import + 只留 CLI，`test/prune.test.mjs` 改 import 路径。临时克隆里 `node scripts/prune.mjs` 正常、全量测试全绿

顺带：`core/driver-resolution.mjs` 的 `DRIVER_ORDER_NOTE` 常量、`core/tasks/greet-verify.mjs` 的 `readChatList` 也是零引用（后者随 BOSS 内容一起走）


### 3.05 `service:status` 的「部署状态」只查游离进程，不查代码新旧（**补丁已备**：`flow/patch-deploy-freshness.diff`）

- 现在 `deploymentDrift({listenerPid, managedPid})` 只判断「端口是不是被 launchd 受管进程占着」
- 容易误读成「部署的是最新代码」：实测此刻 `core/background.mjs`（02:53 改）比 daemon（02:42 启动）新，`service:status` 仍报 `ok`
- 说明一下影响面：daemon 不 import background.mjs（任务子进程运行时才加载），所以这次没问题；但 `agentd.mjs` / `retry-policy` / `front-watch` 这些是 daemon 直接 import 的，改了不重启就会跑旧代码，而状态仍显示 ok
- overlay 更明显：`server.js` / `recover.js` / `session-policy.js` 都是启动时 require 的
- 建议加一列「代码新鲜度」：把每个进程的直接依赖文件 mtime 与其启动时间比，落后就提示 `npm run service:restart`（只提示，不自动重启）
- **补丁已实现**：新增 `core/deploy-freshness.mjs`（纯函数 + 5 条测试）、接线到 `service.mjs status()`。实测：`touch core/agentd.mjs overlay/server.js` 后输出「落后 —— core/agentd.mjs 比进程新 14 分钟，建议 npm run service:restart」


### 3.1 `ensureAppWindow`（新加的组合动作，任务全靠它兜「进程在但没窗口」）没有单测（**补丁已备**：`flow/patch-ensure-app-window-test.diff`）

- 它把「确保在跑 → 等窗口 → 没有就用 bundleId/appName 唤起 → 仍没有就如实报错」串在一起，分支不少，但测试是 0
- 好在完全靠 `deps` 注入，不起任何应用就能测完：未运行、已有窗口、窗口计数 0 但 probe 可读（viaProbe）、唤起后成功、唤起后仍失败、唤起中前台被换
- 补丁：`git apply flow/patch-ensure-app-window-test.diff`（6 条测试 / 99 行，已对着当前实现跑通）


### 3.2 `core/electron-task.mjs`（500+ 行，overlay 的关键依赖）没有任何单测（**补丁已备**：`flow/patch-electron-task-test.diff`）

- 全仓 41 个 core 模块，38 个被测试引用；没被引用的三个是 `platform-smoke`（脚本）、`permissions`（读 TCC，纯 IO）、`electron-task`
- `electron-task` 里至少两个函数不启动 Electron 就能测：`readDevToolsActivePort()`（解析 `DevToolsActivePort` 文件：正常、缺失、端口非法）和 `resolveElectronBinary()`（显式路径优先 / 退到随包 / 都找不到时报可读错误）
- 补丁：`git apply flow/patch-electron-task-test.diff`（新增 5 条测试，69 行）。注意最后一条要写成环境无关——开发机装了 overlay 依赖时会静默退到随包 Electron，只有没装时才抛错


### 3.3 `app-profile.mjs` 抽离后两条异常路径没有测试

- 抽离本身是对的（依赖注入 + 4 条分类测试），我实测 `npm run app:runtime -- --all` 结果正常：199 native / 5 electron / 3 chromium / 1 qt，Chrome 仍归 chromium、Antigravity 仍归 electron
- 缺的是两条失败路径：① `otool` 不可用或超时 → `linkedFrameworks` 返回空（会把 electron 误判成 native）；② `hasJvm` 的正则 `libjvm|jdk|jre` 命中任意含这些字样的资源文件就会误判
- 建议各补一条：`otool` 抛错时分类结果退化但不崩；`hasJvm` 对「文件名里只有 jdk 字样、没有 libjvm 二进制」的目录返回 false


### 3.4 ✅ 真并发抢锁测试（已采纳，且被改进）

- 主会话采纳了我给的 `patch-lock-race-test.diff`，并**修掉了它的一个缺陷**：抢到锁的子进程如果立刻退出，另一个进程重试时会把已退出的持有者判成死锁并回收——那是正确行为，但会让测试偶发失败。他们让胜者多占 1.2 秒，问题消失
- 我对着改进版连跑 8 次，全过

### 3.45 抢锁 fail-open 没有测试

- `acceptance-lock.mjs` 在非 EEXIST 异常时返回 `{ ok: true, warning: ... }`（拿不到锁照跑）
- 这条分支没有任何测试；如果将来决定改成 fail-closed，也没有测试会失败提醒

## P2（续）


### 3.5 会话「真的可见」这条判断还没进单测（`b931e02` 修的）

- `b931e02` 把「正在显示」从 `state.visible` 改成 `state.visible && win.isVisible()`，方向对：窗口刚建好时 `showInactive` 会先把 `state.visible` 置 true，只看状态会把上限顶死
- 但这条逻辑留在 `overlay/main.js` 里，纯函数测试覆盖不到——而它恰恰是刚修的一个坑，容易回归
- 建议抽成纯函数放进 `session-policy.js`：`isTrulyVisible(session, windowVisible)`，main 传 `sess.win && !sess.win.isDestroyed() && sess.win.isVisible()`，再补一条「state.visible=true 但窗口不可见 → 可回收」的测试


### 8.6 ✅ overlay 折叠路径读真实前台（已实现）

- `overlay/main.js:1810`（从放大态还原成小窗时）调用 `attachToDsh(s, 'com.deepseek.dsh', ...)`，硬编码宿主 bundle
- 后果：`frontOk` 恒为 true，即使用户已经切到别的应用，折叠后小窗仍按「宿主在前台」处理 → 该隐藏时没隐藏
- 也绕过了 `OVERLAY_HOST_BUNDLES` 环境变量（换宿主时不生效）
- 补丁改为折叠时读真实前台：`readFrontmostBundle().then((frontNow) => attachToDsh(s, frontNow, dshBounds))`

### 9. ✅ 验收锁三个小洞（已实现：`core/acceptance-lock.mjs` + 测试）

- `existsSync` + `writeFileSync` 非原子（改 `{ flag: 'wx' }`）
- 无 SIGINT/SIGTERM 释放（Ctrl-C 留锁，pid 复用时会误判）
- `cleanupAfterAcceptance` 的 catch 是空的（清理失败无提示）

### 10. 文档数字会腐烂

- `README` 写「本机 27 个应用」，实测已 32 个
- 建议措辞改成「跑 `npm run apps:inventory` 看当前值」，并在 `repo:check` 里加一条数字比对

### 11. CLI 未知子命令退出码 0（**✅ 已实现**）

- `desktop-agent foo` 打印用法但 `exit=0`，脚本里 `|| die` 会误判；建议返回 2

### 12. `overlay/main.js` 1969 行 / 71 函数 / 5 类职责

- 建议拆 `thumb.js`（抓帧循环）与 `sessions.js`（会话生命周期），main 只做装配

### 12.5 文档里的「待补」标记

- `flow/CROSS-PLATFORM.md:94` 有 `Windows（待补）：`，公开仓库里看着像没写完；建议改成「Windows：未实现（计划中）」或直接删掉这段占位

### 12.6 旧审查遗留两条（不阻塞）

- `CAPABILITIES.md` 头部仍是「最后更新 2026-11-05」，内容基本仍成立，但日期该改
- `docs/REVIEW.md` 2.13「点击热区描述不完整」我无法判断是否已解决，需要作者确认
- 其余 16 条已在 `docs/REVIEW.md` 第 7 节标注状态（13 已修 / 3 进补丁）

### 13. 孤儿

- 4 个没人引用的任务（`boss-candidates` `human-demo` `parallel-demo` `parallel-real-demo`）
- 1 个没人引用的脚本（`scripts/ui-gallery.mjs`）

### 14. `repo:check` 在非 git 目录会报红

- 下载 ZIP 的用户跑会看到 `❌ git 仓库可用 / git ls-files 失败`；建议降级为「跳过（非 git 目录）」

### 15. 发布前隐私与历史

- `git config user.email` 未设置（作者是 `tester@goodlifedogdeMacBook-Pro.local`），设置成 GitHub noreply
- 历史里有 20 个 `goodlifedog@users.noreply.github.com` 自动检查点提交，公开前建议 squash

## 已修好（复核过，不用再看）

控制面 token（daemon + overlay 全接口）· Origin/跨域拦截 · pid Helper 误匹配 · 验收覆盖新通道（10 项）·
部署漂移守卫 · 进程收尾（组杀/SIGKILL/转发 TERM）· 失败归类放水（ENOENT/未送达/❌ 覆盖验收路径）·
应用锁偷锁 · doctor 误报 · USAGE curl 带票 · status 最近验收排序 · 日志轮转 · 卸载清理 ·
`open -g -j` 隐藏启动 · 弹窗守卫 · 验收互斥与空闲守卫 · 笔记盲删（已改成 force + 顶部 N 条）·
会话泄漏（任务主动 close + overlay 回收）· 小窗窗口失效自动恢复 · 还原失败信号 · 重绑并列保护 ·
锁屏死代码 · README 绝对化表述 · 命令速查表 · SECURITY 文档数字 · AGENT-COORDINATION 清理语义