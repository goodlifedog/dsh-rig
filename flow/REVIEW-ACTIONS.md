# 评审待办（外部检查者维护）


> ✅ **已结案（03:28）**：`d49be81` 采纳了「收紧语义」方案——`HARD_FAIL`（❌/未送达/存在失败项/FAIL 行）优先于
> 所有环境规则；环境跳过必须由任务显式写 `SKIP` / `环境跳过：…`。我核了一遍：现有任务没有用 `FAIL: <环境措辞>` 的，
> 所以不会出现批量误红。**新的输出约定还没写进文档**（见 P2 的 2.0 条）。


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

## P0 · 公开前必须处理（4 条）

### 0.5 ✅ 已解决：`HARD_FAIL` 优先于环境规则（`d49be81`）

- `run-classify.mjs` 有一条环境规则 `[/改成了指定关键词|已恢复原值/, '目标页面结构已变']`
- 但 `core/tasks/form-fill.mjs` 的验收断言打印的是 `  PASS  ` / `  FAIL  ` 两种前缀，**不使用 ❌**
- 于是「断言失败」的日志里照样出现「改成了指定关键词」字样 → 分类器判成环境跳过 → 验收判 PASS
- 复现（无 ❌、含 FAIL、退出码 1 的日志）：
  ```
  --- 验收 ---
    PASS  搜索框定位成功
    FAIL  改成了指定关键词
    PASS  已恢复原值
  结果: 存在失败项     + end code=1
  → envSkipReason = "目标页面结构已变"（被豁免）
  ```
- **收回原因**：`test/run-classify.test.mjs` 的「常见环境原因都能识别」用例明确写了 `['  FAIL  改成了指定关键词', '目标页面结构已变']`，说明这是设计意图
- 仍值得讨论的风险：该归类区分不了「站点改版」和「自身填表逻辑回归」——两者断言都失败。建议断言失败时再取一个环境证据（URL/标题是否仍在预期站点）；还在就按真失败处理


### 1. BOSS 直聘内容不该出现在公开仓库

- 现状：4 个 `boss-*` 任务、1 个 `greet-inner`、3 份 BOSS 文档（582 行）、README 首页有案例、**npm 包里也带着**
- 执行方案已写好：[`BOSS-EXTRACT.md`](BOSS-EXTRACT.md)（要删哪些、验收怎么补、怎么复查包）
- 需要你决定：**摘出去** / 保留但不上首页、加免责声明、删风控章节

### 2. 发布配置（补丁已备，`git apply flow/patch-publish.diff`）

- 一次解决：包名 scoped、`bin`、`files` 白名单（1.1MB / 143 文件）、`repository`、`publishConfig`（绕开淘宝镜像）、CI 矩阵、README 徽章
- 应用后替换两处占位：`@goodlifedog/desktop-agent`、`github.com/tester/desktop-agent`
- 验证：`npm publish --dry-run` 必须显示 `Publishing to https://registry.npmjs.org ... public access`

### 2.8 🚨 后台控制任务会**覆盖用户正在编辑的文本编辑文稿**（数据丢失，未做内容检查）

- `core/tasks/background-control.mjs:138-141`：`const textAreas = await find('文本编辑', { role: 'AXTextArea', limit: 5 })` → 直接 `setValue('文本编辑', textAreas[0].index, '后台写入：…')`
- `setValue` 走 ocu 的 `set_value`，语义是**把该元素的值设成新值**——不追加、不询问，原来内容直接没了
- 也就是说：用户开着有内容的文本编辑文稿时跑验收/后台控制，第一步写入就把用户内容覆盖掉；清理脚本也只能关「未命名且空」的文稿，救不回来
- 同一份任务里备忘录那段是安全的（我们自己新建的笔记，标题带 `[AGENT-TEST]`），只有文本编辑这一步没有「这是不是我们的文稿」的判断
- 建议二选一：① 写之前读一下该文本区内容，只有为空、或已包含我们写的 `后台写入：` 字样才写；否则 `recordSkipped('文本编辑里有用户内容，跳过写入以免覆盖')`；② 更稳：自己做一份文稿再写（`make new document` / 快捷键新建），写完关掉自己那份

### 2.85 `form-fill` 恢复用户原值不在 `finally`，中途异常会让输入框停在测试值上

- `core/tasks/form-fill.mjs` 的注入脚本里，顺序是：读原值 → `writeValue(NEWVAL)` → 重新读状态 → `writeValue(out.original)` 恢复
- 但这段整体在一个 `try { … } catch (e) { out.error = … }` 里，**恢复不是 `finally`**：如果 `setNew` 之后、恢复之前有任何一步抛异常（`getAXState` 超时、页面跳转、CDP 断开），恢复就被跳过
- 结果：用户自己的搜索框内容被换成了测试关键词，而且清理脚本不会去动 Chrome 里的输入框
- 建议：把恢复放进 `finally`，并在恢复失败时至少再重试一次（照 `writeValue` 自带的 4 次重试即可）；同时把「恢复失败」当**真失败**上报，别混在环境跳过里

### 2.95 `LEGACY_TEST_WORDS` 仍然默认参与删除（`[AGENT-TEST]` 标记层的缺口）

- 现在的链路：`--force` → `deleteMarkedTestNotes` → `buildMarkedDeleteScript(limit)`，而它默认的词表是 `[TEST_NOTE_MARKER, ...LEGACY_TEST_WORDS]`
- 也就是 `--force` 不只删带 `[AGENT-TEST]` 的笔记，**也会删标题里含「后台测试 / 后台写入 / pta 测试」的笔记**
- 用户如果自己写过一条叫「后台测试计划」的笔记，加 `--force` 跑清理就会被删——这跟客户端的红线（不删用户笔记）有冲突
- 我理解 legacy 词是为了兼容「加标记之前留下的旧测试笔记」。建议：默认只认 `[AGENT-TEST]`，把 legacy 词收进 `--force-all`（或新加 `--legacy`）分支，并在输出里写清「这次用的是哪一级判据」
- 注意：`test/note-cleanup-safety.test.mjs` 里有两条用例**明确断言了 legacy 词可删**（`pickDeletableLabels` 与 `buildMarkedDeleteScript(3)`），改行为要同步改这两条——这正是「先看测试再报 bug」的意义，我这次先看了，才没把它当成实现疏漏

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

## P1.5 · 安全边界的四处不一致

### 2.2 ✅ 已解决：弹窗守卫改结构判定 + 兜底 unknown 不点（含多语言词条）

- `core/dialog-guard.mjs` 的策略是：弹窗文字命中 `PERMISSION_HINTS`（中文/英文关键词）就**绝不代点**，否则当普通弹窗，允许点白名单里的安全按钮
- 问题：`PERMISSION_HINTS` 只有中文和英文。**德语「Bedienungshilfen」、法语「Accessibilité」、日语「アクセシビリティ」都匹配不到**，会被判成 benign
- 白名单按钮里含 `OK`——德/法/日 macOS 的权限弹窗按钮恰好也叫「OK」或「許可」等，于是「点掉普通弹窗」有概率变成「点掉授权弹窗」
- 这违反项目自己写进 SECURITY.md 的红线（「权限类弹窗绝不代点」），而且只在非中英文系统上触发，作者本机测不到
- 建议改成**结构判定**而不是语言判定：只要弹窗里出现授予类按钮（允许/Allow/好/許可/Erlauben/Autoriser/Zulassen/Consenti/Accetta…），或出现「系统设置/System Settings/Systemeinstellungen」字样，就一律不点；再加一条测试覆盖非中英文文案


### 2.3 ✅ 已解决：/status /tasks 要票，/ 保留为最小存活探测并同步文档

- 文档两处写「**daemon 与 overlay 的全部接口**都要 `X-Agent-Token`」「实测两个服务无 token 均 401」
- 实测：`GET /`、`GET /status`、`GET /tasks` **无 token 均返回 200**（代码里 `needsToken` 只覆盖 `/run` `/stop` `/selftest`）
- `/status` 的 943 字节里含 `pid` / `startedAt` / `current` / `queue` / `history`（任务名、时间、结果）/ `tasks` 列表
- 更关键的是两个服务都不校验 `Host` 头：伪造 `Host: evil.example` 仍返回 200/202（token 正确时），意味着**网页可通过 DNS rebinding 读到这些只读信息**（token 它拿不到，所以只能读、不能驱动）
- 建议二选一：① 让 daemon 也全接口要票（和 overlay 一致，最省心）；② 保留只读免票，但把文档改成「写接口要票，只读接口免票」并说明原因。无论哪种，都建议加一条 Host 白名单校验（只认 127.0.0.1 / localhost），把 DNS rebinding 这条堵死


### 2.4 ✅ 已解决：hardenDataDir 收紧目录与敏感子目录

- `docs/SECURITY.md` 两处写「token 文件 600、**目录 700**」，代码注释也这么假设
- 实测：`~/.desktop-agent` 是 `drwxr-xr-x`（755），里面还有 `chrome-profile` / `headless-profile` 三个目录，全部 755，大量文件 644
- 这些浏览器 profile 里可能存着登录态 cookie——本机其他用户理论上可读
- 根因：`ensureTokenSync` 用 `mkdirSync(..., { mode: 0o700 })`，但**目录已存在时 mode 不生效**；而且早退路径（已有合法 token）直接 return，不修正文件/目录权限
- 建议：启动时幂等地 `chmod(数据目录, 0o700)`、`chmod(token 文件, 0o600)`；顺手评估把两个 chrome profile 目录也收紧到 700（Chrome 一般不受影响）；文档口径与实现对齐

### 2.45 ✅ 已解决：复用 token 时也会校正 600/700

- `ensureTokenSync` 读到内容合法就 return，不 chmod。若文件曾被备份/恢复成 644，服务不会纠正它，文档里「600」的保证就落空了


### 2.5 ✅ 已解决：cdp-driver 任务已传 expectedPid

- `core/safety.mjs` 有 `debugPortTrust()`（端口主人 pid 必须等于期望应用 pid），`cdp-driver.mjs:161` 也确实调用了——**但只在调用方显式传 `expectedPid` 时才校验**
- 实际情况：`core/tasks/cdp-driver.mjs:55` 在 `launchWithDebug` 之后直接 `attachPage({ port })`，没传 expectedPid；`launchWithDebug` 也只返回 version，不返回应用 pid
- 风险链路：调试端口是按 bundle id 哈希出来的**固定值**（9330-9389）。若本机有别的进程先占住该端口，应用带 `--remote-debugging-port` 启动会失败，但我们的 `probe` 探测到「端口有 CDP 响应」就认为成功，随后连上的是别人的调试服务
- 对比：`core/browser.mjs` 用 `--remote-debugging-port=0` + 自己的 user-data-dir 读 `DevToolsActivePort`，随机端口，风险低得多
- 建议：`launchWithDebug` 顺带取到应用 pid（已有 `findChromePid` 这类工具可复用），`attachPage({ port, expectedPid })`；拿不到 pid 时至少校验端口主人的可执行路径属于该应用 bundle


### 2.7 看门狗判定「用户意图」只看次数，不看人有没有真的在动

- `core/front-watch.mjs`：同一个应用在 `userIntentMs`（默认 1500ms）内把前台抢走 3 次以上，就认账「这是用户自己在切」，从此不再还原
- 问题：**应用自己连续 activate 3 次，和用户手动切 3 次，在代码里长得一模一样**。某些应用在启动、弹窗、收到消息时会在短时间反复激活自己，看门狗会误判成用户意图然后放弃——用户感受到的就是「焦点被抢走了，而且不管了」
- 现有测试也是这么模拟的：`getFront` 连续返回同一个别家应用，断言应认账。它证明的是「这个启发式按设计工作」，证明不了「真实场景下判得对」
- 建议：结合 `ioreg` 的 `HIDIdleTime` 判真伪——**最近 2 秒内用户没有任何键鼠输入，就不可能是用户切换的**，应继续还原（仍受 `maxRestores` 上限约束）。`core/acceptance.mjs` 已经在用 HIDIdleTime 判「用户是否在用电脑」，可以复用同一套
- 收益：既不会把「应用自己跳」误判成用户意图，也不会真的跟用户抢（用户一动鼠标就认账）


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


### 3.1 ✅ 已解决：ensureAppWindow 分支测试已落地

- 它把「确保在跑 → 等窗口 → 没有就用 bundleId/appName 唤起 → 仍没有就如实报错」串在一起，分支不少，但测试是 0
- 好在完全靠 `deps` 注入，不起任何应用就能测完：未运行、已有窗口、窗口计数 0 但 probe 可读（viaProbe）、唤起后成功、唤起后仍失败、唤起中前台被换
- 补丁：`git apply flow/patch-ensure-app-window-test.diff`（6 条测试 / 99 行，已对着当前实现跑通）


### 3.2 ✅ 已解决：electron-task 已有单测

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

### 3.45 ✅ 已解决：fail-open 有测试，且借此抓出 mkdir EEXIST 误判

- `acceptance-lock.mjs` 在非 EEXIST 异常时返回 `{ ok: true, warning: ... }`（拿不到锁照跑）
- 这条分支没有任何测试；如果将来决定改成 fail-closed，也没有测试会失败提醒

## P2（续）


### 3.5 ✅ 已解决：抽成 isSessionReallyVisible + 单测

- `b931e02` 把「正在显示」从 `state.visible` 改成 `state.visible && win.isVisible()`，方向对：窗口刚建好时 `showInactive` 会先把 `state.visible` 置 true，只看状态会把上限顶死
- 但这条逻辑留在 `overlay/main.js` 里，纯函数测试覆盖不到——而它恰恰是刚修的一个坑，容易回归
- 建议抽成纯函数放进 `session-policy.js`：`isTrulyVisible(session, windowVisible)`，main 传 `sess.win && !sess.win.isDestroyed() && sess.win.isVisible()`，再补一条「state.visible=true 但窗口不可见 → 可回收」的测试


### 8.6 ✅ 已解决：折叠路径读真实前台

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

### 2.1 会话标题门控用子串匹配，名字相近的会话会互相点亮小窗

- `overlay/session-gate.js` 的 `matchesTitle` 归一后用 `host.indexOf(hint) !== -1`，只要包含就算匹配
- 实测：hint「规划布局探讨」对 host「规划布局探讨（二） — DeepSeek Harness」返回 true（误判）
- 影响：同时开着名字相近的两个会话时，A 的小窗会在 B 里显示，违反「只在召唤它的会话里显示」
- 现有测试只覆盖全等与完全不同，没覆盖前缀关系；建议归一后优先全等，装饰符另作容错

### 2.05 `overlay/supervisor.js` 带起 daemon 后不管它死活（打包版才会走到）

- 这个模块负责「打包成单个 App 后，Electron 里把 daemon 作为子进程拉起来」，只在打包版生效，开发环境走 launchd，所以平时测不到
- 两个缺口：① `spawn` 后没有 `child.on('error')`——启动失败会变成未捕获异常（**和之前 ocu-mcp 那个 1.4 是同一种 bug，那边修了这边漏了**）；② 没有 `child.on('exit')`——daemon 中途崩掉后没人知道，小窗还在、但所有任务都会 127.0.0.1:7789 连不上
- 影响：打包给用户后，daemon 一崩就是「小窗看起来正常、点什么都失败」且没有任何提示
- 建议：加 error 监听转成可读错误；加 exit 监听——可以限次自动重启（带退避），或至少把状态写进 `/health` 并在小窗上显示「后台服务已退出」

### 2.06 ✅ 已解决：抽了 `attachSpawnError` 统一收口（cli/electron-task/runner/daemon 都在用，带测试）

- 主会话在 `core/safety.mjs` 加了 `attachSpawnError(child, onError)`：只把第一次失败交给调用方，监听常驻（避免 `once` 之后再有 error 变成未捕获异常），配 `test/spawn-error.test.mjs`
- 我当初那条扫描是**启发式误报**：它只看 spawn 后 1400 字符内有没有 `on('error')`，看不到「通过 helper 挂监听」的写法。以后同类扫描要顺带 grep 一下 helper

### 2.11 仓库里 20 张开发截图没有任何文档引用（2.8 MB，建议开前清掉）

- `overlay/docs/` 共 24 个图片文件，其中只有 **4 张**被 README/文档引用（`multi-session.png`、`ui-live-expanded.jpg`、`ui-live-small.png`、`ui-live2-*.png`）
- 其余 20 张是开发过程的 UI 截图（`ui-gallery-expanded.png` 613KB、`clarity-expanded.png` 506KB、`ui-before-ux-*.png` 355KB…），合计 **2.8 MB**
- 它们已经被排除在 npm 包外（打包白名单里排掉了），但还在 git 仓库里——克隆下来会多 2.8MB，公开后也显得仓库里有大量「过程产物」
- 建议：删掉这 20 张（需要留档的话挪到单独分支或 gist），README 引用的 4 张保留。命令：
  ```bash
  git rm overlay/docs/ui-gallery-expanded.png overlay/docs/clarity-expanded.png \
         overlay/docs/ui-before-ux-*.png overlay/docs/title-gate-a.png \
         overlay/docs/overlay-pip*.png overlay/docs/space-own.png overlay/docs/clarity-small.png
  ```

### 2.12 清理脚本会退出用户自己的备忘录/计算器（不区分「谁开的」）

- `scripts/cleanup-test-data.mjs` 的 `quitTestApps()` 无条件 `quitApp` 计算器和备忘录，注释写「Notes 自动保存，关掉不会丢用户内容」
- 实测跑一次 `npm run cleanup:test`（默认就执行，不需要 --force）：报告里出现 `{"kind":"quit","app":"Notes","mode":"quit"}`
- 问题不在数据（备忘录会自动保存），在于**打扰**：用户正开着备忘录写东西，跑个清理就被关掉；这跟项目反复强调的「不打扰、不动用户的应用」不一致
- 对比：`background-stability` 任务已经改成「只关自己拉起来的应用」（`launchedByUs`），清理脚本还没这个意识
- 建议：① 记录本次运行自己启动过的应用，只退这些；或 ② 退出前加 HID 空闲判断（用户最近 60 秒动过键鼠就不退）；或 ③ 至少把「退出应用」收进 `--force`，默认只报告

### 2.13 31 个任务里 17 个没写文件头用途说明（任务清单生成器会标出来）

- 任务脚本统一约定是文件头 `/** 一句话说明 */`，但有一半没写：
  `boss-candidates` `boss-greet` `boss-scan` `boss-scan-dedicated` `greet-inner` `greet-verify`
  `browser-demo` `coverage-probe` `electron-demo` `form-fill` `form-fill-local`
  `headless-demo` `human-demo` `mcp-demo` `multi-app` `platform-demo` `user-chrome-demo`
- 影响：`desktop-agent tasks` 只给名字，用户不知道这些任务是干嘛的；任务清单（`npm run tasks:doc`）里只能显示「（文件头没写用途说明）」
- 建议：采纳 `patch-tasks-catalog.diff` 后，给这 17 个补一行说明；之后可以再加一条 repo:check 规则「每个任务必须有文件头说明」，把它变成硬约束
- BOSS 相关的六个会随 BOSS 内容一起移除，可以先不动

### 2.14 实测跑了一遍完整验收：13 项里 2 项红，都是「测试设计」而非功能回归

本轮在用户空闲 10 分钟后真跑了一次 `npm run accept`（结果 `共 13 项，通过 9，环境跳过 2，失败 2`）：

**失败一：`background-control` —— 计算器点击「7 → 7」没有变化**
```
{"name":"后台点击计算器按钮","ok":false,"frontUnchanged":true,"detail":"7 → 7"}
```
点击本身没抢前台（`frontUnchanged:true`），但显示值没变。可能原因：上一次运行留下的显示值已经是 7，再点 7 变成 77 才该有变化；或者 AX 点击落空。
建议：断言前先按一次 `AC` 归零，再点 7，比较更确定；失败时把「点击前后完整显示」写进 detail，方便判断是落空还是值本来就是 7。

**失败二：`app-matrix` —— 画面回显 0/2**
```
FastZip   | ... | waiting | ...   ← 20:10 那次同一应用是 live
iRightMouse | ... | none   | ...   ← 菜单栏应用，本来就没有可抓窗口
```
两个原因：① FastZip 的缩略图状态有时是 `waiting`（抓帧还没就绪），属于时序抖动；② iRightMouse 是菜单栏工具，永远不会有窗口画面，把它算进「画面回显」分母本身就不合理。
建议：抓帧改成「等到 live 或超时」而不是固定 sleep 后就判；菜单栏类应用（窗口数 0）从画面分母里排除。

两处都不是新代码坏了——`元素级驱动` 那部分 2/2 可读可点、前台也没被抢。但**验收偶发红会让人误以为功能坏了**，发布后更明显。

### 2.15 跨会话互斥只在入口查一次，跑到一半别的会话开始就管不住了

- `13008e4` 加的互斥很对症（我实测过：能识别别人在跑 app-matrix，也不会误判测试文件），但**只在验收开始那一刻查一次**
- 验收一轮要跑几分钟：如果开始后另一个会话手动跑 `app-matrix` 或 `background-control`，两边还是会同时切窗口、互相污染结果——而这正是这条互斥想防的事
- 建议：在每个任务之间（`runTask` 之前）再查一次；注意不能直接把「命令行匹配 core/tasks/*.mjs」当成外来进程——**验收自己拉起的任务子进程也会匹配**，需要按「父进程链是否包含自己」排除（读 `ps -axo pid=,ppid=,command=` 往上走）
- 这条属于加固，不阻塞发布：目前入口检查已经挡住了最常见的情况（两个验收同时启动）

## 已修好（复核过，不用再看）

控制面 token（daemon + overlay 全接口）· Origin/跨域拦截 · pid Helper 误匹配 · 验收覆盖新通道（10 项）·
部署漂移守卫 · 进程收尾（组杀/SIGKILL/转发 TERM）· 失败归类放水（ENOENT/未送达/❌ 覆盖验收路径）·
应用锁偷锁 · doctor 误报 · USAGE curl 带票 · status 最近验收排序 · 日志轮转 · 卸载清理 ·
`open -g -j` 隐藏启动 · 弹窗守卫 · 验收互斥与空闲守卫 · 笔记盲删（已改成 force + 顶部 N 条）·
会话泄漏（任务主动 close + overlay 回收）· 小窗窗口失效自动恢复 · 还原失败信号 · 重绑并列保护 ·
锁屏死代码 · README 绝对化表述 · 命令速查表 · SECURITY 文档数字 · AGENT-COORDINATION 清理语义