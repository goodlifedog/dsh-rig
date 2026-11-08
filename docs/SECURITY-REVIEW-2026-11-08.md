# 独立安全评审（2026-11-08）

> 评审对象：desktop-agent（嵌套在父仓库里的独立 git 仓库）。评审时间：2026-11-08。
> 评审人视角：第三方、只读。**没有修改任何代码，没有 commit**，唯一产物就是本文档。
> 环境：macOS 26.5.1 arm64、Node 20；评审时两个本地服务已在运行（daemon 7789、overlay 7788），
> 屏幕处于可用状态。评审期间**没有**启动/显示任何窗口，没有运行 `accept` / `verify:live` / `matrix` / `overlay` / `monitor`，
> 没有点击任何应用；只做了读代码、只读 grep、`npm test`，以及对两个本地服务发**只读或应被拒绝**的 HTTP 请求（清单见附录 A）。

## 0. 结论摘要

| 等级 | 数量 | 一句话 |
| --- | --- | --- |
| **高危** | **1** | 备忘录测试清理在「列表标题读不到」时会无提示地退化成「删最上面 N 条」，没有 `--force-all` 闸门，存在误删用户新建笔记的窗口 |
| 中 | 5 | 中止后遗留浏览器进程与未鉴权 CDP 端口、中止清理预算不足、验收锁 fail-open、CDP 端口信任判定可伪装、token 会被发往任意 OVERLAY_URL |
| 低 | 6 | /tmp 可预测临时文件、profile 目录权限路径、AppleScript 原始拼接（当前仅 env 来源）、清理脚本的 --force-all 边界、部分 kill 路径缺 pid 复核、无票存活探测与错误回显 |
| 待确认 | 3 | Windows 分支未实机、Notes 标题可读性对高危 1 的触发率、AGENTD_TASKS_DIR 环境变量边界 |
| 已确认安全 | 11 组 | 控制面鉴权、Host/Origin/CSRF、注入、任务名穿越、pid 复核、应急清理顺序、渲染层 CSP、日志清理边界等 |

**总体评价**：这个仓库的安全工程做得比一般自用工具扎实——控制面有 token、有 Host/Origin/JSON 三重门、有定长比较；
注入面主要靠 `JSON.stringify` 转义（本次专门验证了 AppleScript 转义语义，结论是安全的）；
数据清理脚本有明显的「只删自己写的」意识和多重闸门；单测 664 条、安全边界专项齐全。
真正需要先处理的是**一条会产生用户数据丢失的分支**，以及**中止/清理链路的收尾预算**。

### 与 `docs/SECURITY.md` 的三处不一致（文档说做了，代码没做到位）

1. `docs/SECURITY.md:62-63`：「标记读不到时退回『写入前后条数差、只删顶部 N 条』，并且要显式 `--force-all` 才允许。」
   实际：任务路径 `core/tasks/background-control.mjs:230` 调用 `deleteTestNotes({count})` 时**没有任何 force 闸门**，
   而 `core/note-cleanup.mjs:277-278` 在标题读不到时直接回退到 `deleteTopNotes()`。详见 **H-1**。
2. `docs/SECURITY.md:16`：「拿不到 pid 时校验端口主人的可执行路径属于该应用。」
   实际：`core/cdp-driver.mjs:151-156` 只是拿 `ps` 的**完整命令行**做子串匹配（`command.includes(appName)`），
   而 argv 是可以被进程自己随便写的。详见 **M-4**。
3. `docs/SECURITY.md:67-69`：「中止链路是三层……任务的应急清理同步关掉自己拉起的应用。」
   实际链路的**预算**对不上：外层 3 秒（live-verify）或 4 秒（runner）就 SIGKILL，
   而同步清理每个应用最多要 ~8 秒（AppleScript 4 秒 + 等待 2 秒），多应用场景会被截断。详见 **M-2**。

---

## 一、高危

### H-1 备忘录清理的「条数差」回退分支没有 force 闸门，可能误删用户笔记

- **位置**
  - `core/tasks/background-control.mjs:227-231`（验收任务末尾自动清理）
  - `core/note-cleanup.mjs:271-279`（`deleteTestNotes` 的回退逻辑）
  - `core/note-cleanup.mjs:141-156`（`deleteTopNotes`：按「删除」次要动作删最下面/最上面的行）
  - `docs/SECURITY.md:62-63`（声称需要 `--force-all`）
- **代码事实**：`deleteTestNotes({count})` 先走「按 `[AGENT-TEST]` 标记删」（安全）；但如果
  `deleteMarkedTestNotes` 返回 `readable === 0`（Notes 列表行标题完全读不到——模块注释自己描述了这类 Notes 版本），
  就直接 `return deleteTopNotes(count, opts)`，删除**顶部 count 条**，不再做任何标记匹配，也不看 `--force-all`。
- **攻击/故障场景**：`background-control` 验收会新建一条测试笔记，结束时 `delta = 测试后条数 - 测试前条数`。
  如果这次运行恰好落在「标题读不到」的 Notes 版本上，且用户在验收那 1 分钟里自己新建了 1 条笔记，
  用户的新笔记在列表顶部，`deleteTopNotes(2)` 会把它和测试笔记一起删掉。
  用户活动只在**任务开始时**检查一次（`shouldDeferForActiveUser`），运行中用户回来不会中止。
- **影响**：用户数据被静默删除（Notes 会进「最近删除」，但脚本明确提示「最近删除需手动清空」，等于需要用户自己发现并恢复）。
- **触发概率**：本机有日志证据显示目前走的是标记分支（`logs/runs` 里 `已清理测试笔记：1 条`），所以是**潜在**；
  但代码里这条回退是**无条件**的，一旦遇到读不到标题的 Notes 版本就自动生效。属于「安全闸门写在文档里、没写在代码里」。
- **最小修复建议**：给 `deleteTestNotes` 加显式开关：`deleteTestNotes({count, allowTopFallback: true})` 才允许回退，
  默认 `false` 时返回 0 并打印「无法识别测试笔记，未删除」；`background-control` 只在 `NOTES_CLEANUP_FORCE=1` 时传 `allowTopFallback`；
  更彻底的做法是任务路径彻底不调 `deleteTopNotes`（只保留给带 `--force-all` 的清理脚本）。

---

## 二、中危

### M-1 任务被停止/超时后，遗留 Chrome / Electron 进程与未鉴权的 CDP 调试端口

- **位置**
  - `core/daemon.mjs:456-464`：`POST /stop` 只 `process.kill(state.current.pid)`，没有杀进程组
  - `core/daemon.mjs:268`：10 分钟超时同样只 `child.kill('SIGTERM')`
  - 对比：`core/daemon.mjs:536-559`（daemon 自己收到 SIGTERM 时会 `kill(-pid)` 杀整组）
  - `core/browser.mjs:229-243`：macOS 用 `open -g -n -a` 拉起 Chrome，Chrome 是 LaunchServices 的子进程，**不在任务的进程组里**
  - `core/electron-task.mjs:346-350`：Electron 子进程没有 detached/没有挂到任务组，任务被杀后同样会活下来
  - `core/orphan-cleanup.mjs:16`：孤儿清理只认 ocu/app-agent 特征，不认本项目的 Chrome profile
- **攻击/故障场景**：headless / 离屏浏览器任务被 `POST /stop`、被 daemon 10 分钟超时、或被 Ctrl-C 结束；
  任务里的 `browser.close()` 来不及执行 → Chrome 继续带着 `--remote-debugging-port=<随机端口>` 和一个已登录 profile 跑着。
  CDP **没有任何鉴权**（Chrome 的协议本身如此），同机任意用户/进程都能连上去读页面、拿 cookie、代替用户操作。
  2026-11-06 实测过这种残留（同一 profile 的 headless 进程占着 SingletonLock，导致后续启动超时），
  现在的 `launch()` 会在**下一次启动**时清理同 profile 残留，但残留期间端口一直是开着的。
- **影响**：跨本地用户的会话接管面（若机器只有你一个用户，等价于「自己机器上的额外攻击面」）；资源泄漏；后续启动偶发超时。
- **最小修复建议**：
  1. daemon 的 `/stop` 与超时分支改成 `process.kill(-pid, sig)`（先 TERM 再 KILL），与 shutdown 路径一致；
  2. 浏览器/Electron 任务在 `finally` 之外再挂一层 SIGTERM 清理（像 `task-emergency-cleanup` 对应用做的那样，对 browser 也做）；
  3. 把孤儿清理的 pattern 扩到「命令行含 `--user-data-dir=<本项目 ~/.desktop-agent 下路径>` 的 Chrome」。

### M-2 中止清理预算不足：外层 3–4 秒就 SIGKILL，同步清理每个应用最多 ~8 秒

- **位置**
  - `scripts/live-verify.mjs:89-98`：用户碰键鼠 → `SIGTERM` 任务组，**3 秒后** `SIGKILL`
  - `core/runner.mjs:139-147`：runner 收到 TERM → 转发任务组，**4 秒后** `SIGKILL`
  - `core/sync-quit.mjs:30-43`：`quitAppSync` 每个应用 AppleScript 超时 4 秒（execFile 6 秒）+ 轮询等 2 秒
  - `core/tasks/cold-launch.mjs`、`core/tasks/app-matrix.mjs`：一次可能清理 2–3 个及以上应用
- **攻击/故障场景**：验收被中止时，任务收到 SIGTERM 开始同步关应用；第一个应用就卡满 4 秒的话，
  第 3 秒/第 4 秒的 SIGKILL 会把清理进程直接干掉，后面几个应用留在后台。
  与 `docs/SECURITY.md:67-69` 承诺的「中止后把自己拉起的应用关掉」不一致。
- **影响**：中止后桌面残留应用窗口；不会丢数据（清理只优雅退出），但用户会看到「验收停了，应用还开着」。
- **最小修复建议**：给 `quitAppSync` 加共享 deadline（例如总共 2.5 秒，逐应用扣减），
  或者把外层 SIGKILL 宽限从 3/4 秒提到 6–8 秒并在日志里写明；两者取其一即可。

### M-3 验收互斥锁在「写锁失败」时 fail-open（按未加锁继续）

- **位置**：`core/acceptance-lock.mjs:77-86`
- **代码事实**：只有 `EEXIST && exists` 才当成并发抢锁；其它错误（权限、ENOSPC、父路径异常）
  直接返回 `{ok:true, warning:'…按未加锁继续'}`。
- **攻击/故障场景**：`reports/` 不可写、磁盘满、或锁文件被别的进程换成不可创建状态时，
  两个验收/两个会动应用的任务会同时跑——两边互相抢前台、互相关应用、互相删测试数据。
- **影响**：正是这把锁要防的事故（验收场景最伤用户），且只打印一条 warning，容易被忽略。
- **最小修复建议**：验收这类入口 fail-closed（`ok:false` 直接退出），
  仅当显式 `AGENT_ALLOW_UNLOCKED=1` 才允许未加锁继续；或退回到 `os.tmpdir()` 下的第二把锁。

### M-4 CDP 调试端口「主人校验」用命令行子串，可被伪装

- **位置**
  - `core/cdp-driver.mjs:139-157`：知道应用 pid 时用 `debugPortTrust`（严格相等），
    不知道 pid 时退化成 `command.includes(appName|processName|bundleId)`
  - `core/safety.mjs:79-85`：`debugPortTrust` 本身是对的（owner === app）
  - `docs/SECURITY.md:16` 声称「校验端口主人的可执行路径属于该应用」
- **攻击场景**：调试端口是按 bundle id 哈希出来的固定区间（`core/cdp-driver.mjs:26-40`，9330–9389）。
  同机另一个用户可以先占住这个端口，把进程 argv 起成包含 `Google Chrome` 的样子；
  我们的 `verifyDebugPortOwner` 会判 `path-match`，然后 CDP 连上**攻击者的假 CDP 服务**，
  后续页面内容、输入、cookie 都会交给对方（这正是模块注释里说要防的「本地端口劫持」）。
- **影响**：本地中间人；需要本机另一个账号或同用户恶意进程（同用户本来就能读 token，威胁模型里已接受）。
- **最小修复建议**：把 `command.includes(...)` 换成「`ps -p PID -o comm=` 的可执行路径」与目标应用
  已知可执行路径做前缀比对（`/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`），
  `comm` 不可被 argv 伪造；拿不到 comm 就 fail closed（现在的注释也是这个原则，只是实现没跟上）。

### M-5 控制面 token 会跟随 `OVERLAY_URL` / `AGENTD_URL` 发往任意主机

- **位置**
  - `core/ports.mjs:34-38`、`:44-48`：允许把 base 指到任意 URL（注释写明「允许指向别的机器/隧道」）
  - `core/agentd.mjs:24-36`：每次 POST 都带 `localHeaders()`（内含 `X-Agent-Token`）
  - `core/local-token.mjs:49-53`：`localHeaders` 无条件附带 token
  - `overlay/main.js:1905-1928`：`stopBackgroundTask` 同样把 token POST 到 `AGENTD_URL`
- **攻击/故障场景**：环境变量被误配（或由某个会注入环境的工具/脚本设置）成 `OVERLAY_URL=http://some-host:port` 时，
  token 会以明文 HTTP 发到非回环地址；拿到 token 的一方只要能在本机落地，就能调用 daemon/overlay 的全部接口。
  同理 `AGENTD_URL` 被改写时，小窗的「停止任务」会把 token 发出去。
- **影响**：token 外泄；属于「本机信任之外」的额外风险，但触发只需要一个环境变量。
- **最小修复建议**：与 `AGENT_ALLOW_QUERY_TOKEN` 同风格：**只有目标是回环地址时才附带 token**，
  非回环地址必须显式 `AGENT_ALLOW_REMOTE_TOKEN=1` 才带；或在 `localHeaders()` 里做 URL host 校验。

---

## 三、低危

### L-1 `/tmp/ocu-calls-<pid>.json` 路径可预测，存在符号链接写穿

- **位置**：`core/agentd.mjs:110-117`
- **场景**：用 `process.pid` 拼固定文件名写 JSON，然后交给 ocu 读。别的本地用户可以在 `/tmp` 提前放一个同名符号链接，
  指向我们用户拥有的文件（例如 shell 配置），我们的 `writeFile` 会跟随链接把 JSON 写进去 → 覆盖用户文件。
- **影响**：同机其他账号可对我们做「有限的文件覆盖」（内容固定为 JSON；不提升权限）。
- **修复**：用 `fs.mkdtemp` 建私有临时目录，或 `fs.openSync(path, 'wx')` 再写；用完删除目录。

### L-2 新建 profile 目录未显式 700，且 `hardenDataDir` 白名单不含自定义 profile

- **位置**：`core/browser.mjs:287`（`fsp.mkdir(userDataDir, {recursive:true})`，未给 mode）；
  `core/local-token.cjs:38-47`（白名单只有 bin/smoke/chrome-profile/headless-profile/headless-profile-p1/p2）
- **说明**：本机实测各 profile 目录都是 `drwx------`（Chrome 自己会收紧），所以当前没有实际暴露；
  但 `AGENT_CHROME_PROFILE` / `HEADLESS_PROFILE` 指向的新目录（例如 concurrent-profile）不在白名单，
  依赖 Chrome 自己去 chmod。若某个版本/某个 profile 没有收紧，登录态 cookie 在目录被遍历时可能被同机其他用户读到。
- **修复**：`mkdir` 时给 `mode:0o700` 并在 `launch()` 里 `chmod` 一次；`hardenDataDir` 改为遍历 `~/.desktop-agent` 下所有目录统一 700。

### L-3 `overlay/platform.js` 的 macOS 分支把 `processName` 原样拼进 AppleScript

- **位置**：`overlay/platform.js:38-52`（`macWindowBounds` / `macWindowTitle`）；
  当前唯一调用来源是 `overlay/main.js:296` 的 `DSH_PROCESS`，值来自环境变量 `OVERLAY_HOST_PROCESS`（`overlay/main.js:44`）
- **说明**：没有使用 `overlay/quote.js` 的 `appleScriptQuote`。现在只受环境变量控制，风险低；
  但一旦以后换成「窗口标题/名字驱动」，就是一条 AppleScript 注入。窗口名里出现 `"` 也会直接让脚本语法错乱（功能故障）。
- **修复**：两处统一 `appleScriptQuote(processName)`（与 `main.js:326` 的兜底一致）。

### L-4 清理脚本的 `--force-all` 边界，以及「用户离开 2 分钟就关用户自己的应用」

- **位置**
  - `scripts/cleanup-test-data.mjs:70-74`：`--force-all` 时按历史测试词（后台控制验证/后台写入/后台测试）删笔记，可能误删同名用户笔记
  - `scripts/cleanup-test-data.mjs:133-151` + `core/cleanup-policy.mjs:18-24`：不是本次启动的应用，只要用户「键鼠空闲 ≥2 分钟」就会被 quit（Notes/计算器）
  - `core/cleanup-policy.mjs:18-24` 的判定与 `docs/SECURITY.md:37-38` 的「只关本轮自己拉起来的」表述存在差异
- **影响**：清理脚本是用户显式调用的，默认只报告、需要 `--force`/`--force-all`；但 `--force-all` 的语义（删历史同名词）值得再加一道确认，
  否则「用户离开时自动关掉他自己开着的备忘录」也会被当成清理的副作用。
- **修复**：`--force-all` 要求交互式确认或额外 `--yes`；`quitTestApps` 默认只关 `launchedByUs`，关用户的改为显式 flag。

### L-5 部分 kill 路径没有 pid 复核（与项目自己的严格做法不一致）

- **位置**
  - `core/daemon.mjs:456-464`（/stop）、`:268`（10 分钟超时）
  - `core/service.mjs:110-127`（uninstall 结束占端口的进程）、`:220-233`（restart）
  - 对照：`core/background.mjs:948-980` 退应用前会 `ps -p PID -o comm=` 复核，`core/safety.mjs:64-72`
- **说明**：daemon 持有任务子进程引用的时间窗很短（zombie 未被 reap 时 pid 不会复用），实际误杀概率极低；
  service 侧依赖 `lsof` + 命令行匹配判定「是不是本项目进程」，与 M-4 同类（argv 可伪装，但后果只是「杀到别人的进程」/漏杀）。
- **修复**：统一复用 `pidMatchesProcess` 做最后一道复核；service 侧用可执行路径而不是命令行子串判定归属。

### L-6 无票存活探测与错误回显（已知设计，记录边界）

- **位置**：`core/daemon.mjs:406-414`（GET / 无票返回 pid/uptime）；`overlay/server.js:58-66`、`:393-398`
  （403/404 回显 Host/Origin/path，各自截断 80 字符）
- **说明**：GET / 的信息价值很低（pid/uptime），是启动脚本/看门狗需要的；错误回显是 JSON 且 `Content-Type: application/json`，
  没有 XSS，控制字符经 `JSON.stringify` 转义后也不构成响应拆分。记录在案，不建议改。

---

## 四、待确认（拿不准，需要条件才能定性）

| 编号 | 事项 | 为什么拿不准 | 建议验证方式 |
| --- | --- | --- | --- |
| T-1 | Windows 分支（PowerShell/PrintWindow/UIA）安全性与功能都未实机验证 | 本机是 macOS；`overlay/platform.js` 的 PowerShell 拼接已经用 `ps-quote.js` 做了单引号转义，但整条链路没跑过 | 在 Windows 机器上跑 `verify:safe` + `scripts/cleanup-test-data.mjs --dry-run` |
| T-2 | `readable === 0` 在常见 macOS/Notes 版本上的出现频率 | 决定 H-1 的触发概率；本次禁止启动应用，无法实测 | 在解锁且有 Notes 的机器上跑一次 `node -e` 调 `deleteMarkedTestNotes(0)` 看 readable，或加日志观察 |
| T-3 | `AGENTD_TASKS_DIR`（`core/daemon.mjs:29`）可指向任意目录 | 设了这个环境变量就能让 daemon 执行任意目录下的 `.mjs`；能改 daemon 环境的人本来就是同一用户，所以只算纵深 | 若要保持「任务目录不可配」就删掉这个测试钩子，或校验目录必须在仓库内 |

---

## 五、已确认安全（有证据，不是「看起来没问题」）

### S-1 控制面鉴权：除 daemon `GET /` 外全部要 token（实测）

本次对两个运行中的服务发了 13 条只读/应被拒请求，结果全部符合设计：

| # | 请求 | 结果 |
| --- | --- | --- |
| 1 | `GET :7789/`（无 token） | 200，只回 `{ok,service,pid,uptimeSec}`，无任务列表 |
| 2 | `GET :7789/status`（无 token） | **401** |
| 3 | `GET :7789/status`（正确 token） | 200 |
| 4 | `GET :7789/` + `Host: evil.example` | **403** |
| 5 | `GET :7789/` + `Origin: https://evil.example` | **403** |
| 6 | `GET :7789/` + `Host: localhost:7789` | 200 |
| 7 | `GET :7788/health`（无 token） | **401** |
| 8 | `GET :7788/health`（正确 token） | 200 |
| 9 | `GET :7788/health` + 正确 token + `Host: evil.example` | **403**（带 token 也拒） |
| 10 | `GET :7788/health` + 正确 token + `Origin` | **403** |
| 11 | `POST :7788/log` 无 `Content-Type: application/json` | **415** |
| 12 | `OPTIONS :7788/log`（预检） | **403** |
| 13 | `POST :7789/run`（无 token，带 JSON） | **401**，且 daemon 队列未被污染（`/status` 里 queue 为空） |

结论：鉴权、DNS rebinding 防护、CSRF 防护（Origin+JSON Content-Type+OPTIONS）都在生效。
token 文件权限实测：`~/.desktop-agent` 为 700、`api-token` 为 600（`stat` 实测）。

### S-2 token 实现细节

- 32 字节随机 hex（`core/local-token.cjs:20-22`）；文件损坏/权限被放宽会重新生成并 chmod 回 600（`:49-67`）。
- 比较用 `crypto.timingSafeEqual`，长度不同先返回 false（`:85-95`）。
- 默认只认请求头；`?token=` 必须显式 `AGENT_ALLOW_QUERY_TOKEN=1`（daemon `core/daemon.mjs:397-404`、overlay `overlay/server.js:202-207`），避免把 token 写进 shell history/访问日志。
- 两个服务都只监听 `127.0.0.1`（`lsof` 实测）。

### S-3 AppleScript 注入：`JSON.stringify` 拼接在本项目的用法下是安全的（专门验证过）

仓库里大量把变量拼进 AppleScript（`core/sync-quit.mjs:33-35`、`core/front-watch.mjs:34`、`core/agentd.mjs:190`、
`core/background.mjs:63,71,744,845,920,950`、`core/tasks/cold-launch.mjs:32` 等），
统一用 `JSON.stringify(value)` 生成字符串字面量，而不是 `appleScriptQuote`。本次用只读 `osascript` 实验确认了 AppleScript 的转义语义：

```text
$ osascript -e 'return "a\"b"'   → a"b      （\" 是合法转义：引号不会提前结束字符串）
$ osascript -e 'return "a\\b"' → a\b      （\\ 是合法转义）
$ osascript -e 'return "a\nb"'  → a<LF>b   （\n 不是脚本断行，是字符串内换行）
$ osascript -e 'return "x\" & (1 + 1) & \"y"' → x" & (1 + 1) & "y"（证明 \" 不会变成代码）
```

因此 `JSON.stringify` 产出的 `"…\"…\\…\n…"` 在 AppleScript 里就是普通字符串，**不构成注入**；
非字符串（对象/数组）会生成 `{"a":1}` 这类非法 AppleScript 语法，只会编译失败，不会变成代码。
真正注意点只有两处：**L-3 的原始拼接**（无转义）和「不要用 `+ JSON.stringify` 之外的方式拼字符串」这条约定。
另外全仓库**没有** `shell:true`、`sh -c`/`bash -c` 构造命令行，所有外部命令都是 `execFile(绝对路径, [参数数组])`（`grep` 验证）。

### S-4 任务名目录穿越与请求体约束

- `POST /run` 的任务名必须命中 `listTasks()` 白名单（`core/daemon.mjs:437-449`），`../` 进不来；`runTask` 又校验一次（`:216-224`）。
- 队列上限 50，超了 429（`:446-449`）；daemon 请求体 1MB（`:148-178`）、overlay 推帧 8MB（`overlay/server.js:91-120`），超限 413 且把剩余数据丢掉再回响应（不会掐断连接）。
- 坏 JSON / 非对象一律 400，不再静默当空对象（daemon `:180-199`、overlay `:122-136`）。

### S-5 杀进程与「未保存数据」保护

- `core/background.mjs:969-996`：pgrep 拿 pid 后先用 `ps -p PID -o comm=` 复核 `pidMatchesProcess`，对不上就不杀；
  退应用前先扫「保存/覆盖/删除」类弹窗（`:956-967`），有就返回 `needs-confirm`，不发 TERM。
- 弹窗采集同时覆盖 `AXDialog` 与 `AXSheet`（`core/background.mjs:850-852`），与 SECURITY.md 描述一致。
- 冷启动任务只对「退出无副作用」的应用（计算器/系统设置）做 `pkill -x` 兜底，备忘录明确 `forceQuit:false`（`core/tasks/cold-launch.mjs:24-29`）。

### S-6 应急清理的注册顺序是对的（SIGTERM 竞态已规避）

`core/ocu-mcp.mjs:176-183` 会在第一次拿到 MCP 时注册 `SIGTERM → process.exit(143)`；
任务侧 `installEmergencyAppCleanup` 用同步的 `quitAppSync`。Node 按注册顺序执行监听器，本次逐个核对了四个用应急清理的任务：

| 任务 | cleanup 注册行 | 首次 MCP 调用行 | 顺序 |
| --- | --- | --- | --- |
| `core/tasks/cold-launch.mjs` | 62 | 不用 MCP（全走 osascript/exec） | 安全 |
| `core/tasks/background-control.mjs` | 82 | 169（`clickByText` 之后的 find/state） | 安全 |
| `core/tasks/concurrent-demo.mjs` | 121 | 132 | 安全 |
| `core/tasks/app-matrix.mjs` | 195 | 240 | 安全 |

### S-7 渲染层与推帧

- `overlay/index.html:6-8`：CSP `default-src 'none'; script-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'`。
- `overlay/renderer.js` / `preload.js`：没有 `innerHTML`/`insertAdjacentHTML`/`eval`（grep 为空），外部文本走 `textContent`。
- `POST /frame`：只接受 `data:image/(png|jpeg|webp|gif);base64,` 内联图（`overlay/image-meta.js:86-94`），拒 http(s) 与 svg；
  `cursor` 只接受有限数字（`:72-82`）；宽高限制 1–10000（`overlay/server.js:139-146`）。
- `session` 白名单正则 `^[A-Za-z0-9._-]{1,64}$`（`overlay/server.js:32,156-165`），不会被当成路径/日志注入。

### S-8 日志/报告清理边界

- `scripts/prune.mjs` 默认 dry-run，只遍历 `logs/runs`、`logs/daemon`、`reports` 三个目录（`:50-52`）；
  验收证据类报告只按 90 天老化、不被数量上限挤掉（`core/prune.mjs:11-16,46-48`）。
- `core/note-cleanup.mjs:36-39` 的 AppleScript 词表构造会过滤 `" \ CR LF`；标记删除要求行文本命中 `[AGENT-TEST]`（`:47-60`）。

### S-9 数据目录与文件权限（实测）

`~/.desktop-agent` 700、`api-token` 600、各 chrome/headless/concurrent profile 目录 700（`stat` 实测）；
`hardenDataDir` 每次启动幂等修正（`core/local-token.cjs:28-47`），修了「mkdir 的 mode 对已存在目录不生效」这个经典坑。

### S-10 无 shell 注入面

全仓库没有 `shell:true`、`execSync` 拼接、`sh -c`/`bash -c`、`eval`/`new Function`（grep 验证）；
所有命令都是绝对路径 + 参数数组。`PlistBuddy -c` 的键来自代码常量（`core/app-scan.mjs:44-50`）；
`pkill -x` 的进程名来自静态清单（`core/app-presets.mjs`）。

### S-11 本次评审没有发现的东西（防误报）

- 没有发现可绕过 token 的路径（大小写、重复头、query 参数都按预期 401）；
- 没有发现由 HTTP 字段直接进入 shell/AppleScript 的未转义路径（所有外部字段要么进 JSON、要么只做匹配/展示）；
- 没有发现原型链污染入口（没有把请求体 `Object.assign` 进共享对象；`__proto__` 字段不会被读取）；
- 没有发现 overlay 能把自身/DSH 窗口当被控目标（`selfWindowIds` 拦截 + 403）。

---

## 六、修复优先级建议

1. **H-1**：给 `deleteTestNotes` 的「删顶部 N 条」回退加显式开关，任务路径默认不允许。改动两行，风险最低、收益最大。
2. **M-1 + M-2**：daemon 停止/超时改成杀进程组；中止宽限从 3–4 秒提到 6–8 秒（或让 quitSync 带总 deadline）。
   这两条决定「中止之后桌面干不干净」。
3. **M-4 + M-5**：CDP 端口信任改成可执行路径比对；token 只对回环地址附带。都属于「把文档里写的保证真正写进代码」。
4. **M-3**：验收锁 fail-closed（或显式允许未加锁）。
5. 低危按需：L-1（临时文件）、L-2（profile 权限）顺手改；L-3 建议统一 quote 函数。
6. 待确认项（T-1/T-2/T-3）需要条件，不阻塞。

---

## 附录 A：本次评审做过的只读验证

```bash
# 1) 控制面鉴权（13 条，矩阵见 S-1；全部只读或应被拒绝，无副作用）
curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:7789/                     # 200
curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:7789/status               # 401
curl -s -o /dev/null -w '%{http_code}' -H "X-Agent-Token: <本地 token>" http://127.0.0.1:7789/status  # 200
curl -s -o /dev/null -w '%{http_code}' -H 'Host: evil.example' http://127.0.0.1:7789/                 # 403
curl -s -o /dev/null -w '%{http_code}' -H 'Origin: https://evil.example' http://127.0.0.1:7788/health # 403
curl -s -o /dev/null -w '%{http_code}' -X POST -H "X-Agent-Token: <token>" --data x http://127.0.0.1:7788/log # 415
...

# 2) token 与数据目录权限
stat -f '%Sp %N' ~/.desktop-agent ~/.desktop-agent/api-token     # 700 / 600

# 3) AppleScript 转义语义（只读，不操作任何应用）
osascript -e 'return "a\"b"' …

# 4) 单测
npm test    # 664 tests，663 pass / 0 fail / 1 skip
```

**明确没做的事**：没有启动/显示任何窗口；没有运行 `npm run accept`、`verify:live`、`matrix`、`overlay`、`monitor`；
没有执行任何会写用户数据的清理脚本（`cleanup-test-data`、`prune --apply` 等）；
没有修改代码；没有 git commit/push。
