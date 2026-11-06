# 独立代码审查（desktop-agent）

> 审查时间：2026-11-06 · 审查人：第三方视角（只读）
> 环境：macOS 26.5.1 arm64，Node v20.18.0；审查期间屏幕处于**锁屏**（ioreg 显示 CGSSessionScreenIsLocked=Yes）。
> 范围：desktop-agent/ 这个嵌套 git 仓库（父仓库里它整个是未跟踪目录），最近 12 个提交；重点 core/、overlay/，以及 README / ARCHITECTURE / docs/USAGE.md / CAPABILITIES / CHANGELOG。
> 方法：读代码 + 读 diff + 跑只读检查（npm test、npm run check、npm run repo:check、node scripts/health.mjs、curl 两个本地服务、起一次 ocu MCP 数工具）。**没有修改任何代码，没有 commit。**

## 0. 结论摘要

1. **最近 12 个提交里 11 个说明与代码一致，1 个不一致**：7181a78「锁屏时自动放宽浏览器启动超时」的说明写了两件事（browser.mjs 启动前检测 + 超时 ×3 + 打印提示），实际 diff 只加了 import，browser.mjs 逻辑一行没动。这就是任务背景里说的那种「说了没做」。它在下一个提交 f4fb282 里被补实，且 f4fb282 的说明自己承认了这次不一致——所以现在代码是对的，但这条历史要留档。
2. **真正会导致错误的问题 5 条**（第 1 节）。最该先修的两条：
   - core/browser.mjs 拿不到 Chrome pid 时返回 0，close() 里的 process.kill(-child.pid) 变成 kill(-0)，把**任务自己的进程组** SIGTERM 掉；
   - core/daemon.mjs 的任务日志流从不 end()，任务子进程没有 'error' 监听，长跑 daemon 会漏 fd、异常路径可能崩进程。
3. **会误导的问题集中在文档漂移**（第 2 节）：README 的行数/任务数、USAGE 的 OVERLAY_FPS 与缩略图上限、service.mjs 的 PATH 缺口（已修但文档还写着没修）、CAPABILITIES 的「8 秒空闲」和「6/6 验收」、ARCHITECTURE 的 v0.5 版本号，都还停在 v0.7.0 之前。
4. **两个模块已经没人用**：core/frames.mjs（全仓库 0 引用）和 core/permissions.mjs（0 引用，但 USAGE 说它是权限解析模块）。README 目录里还列着 frames.mjs。
5. 有些不是 bug 但风险明确：isScreenLocked() 的值判断有缺陷（未锁屏也可能返回 true，已用字符串模拟复现）；打包产物 bundle id 与 overlay 里写死的 com.github.Electron 不一致，打包版点小窗会把自己藏掉。
6. 确认没问题的部分见第 5 节：单测 35 条（34 pass + 1 skip）、语法检查、repo:check、全部 import 路径、文档里点名的脚本/图片/flow 文档、ui-regression 的 14 条断言、MCP 的 11 个工具，都对得上。

## 1. 高：会导致错误、崩溃或统计失真

### 1.1 core/browser.mjs:232、:333 —— pid 为 0 时 close() 会 SIGTERM 自己的进程组

~~~js
// browser.mjs:229-233（macOS 分支）
start('open', ['-g', '-n', '-a', 'Google Chrome', '--args', ...args]);
return { pid: await findChromePid(userDataDir) };   // 找不到时返回 0（browser.mjs:90-101）

// browser.mjs:332-334（close）
try { process.kill(-child.pid, 'SIGTERM'); } catch {}
try { process.kill(child.pid, 'SIGTERM'); } catch {}
~~~

**为什么是问题**：findChromePid 只等 8 秒（browser.mjs:90），而项目自己记录过「锁屏时 Chrome 启动从 ~1s 涨到 ~18s」（ARCHITECTURE.md:90；logs/runs 里也有实测 launch.ms=20963）。一旦 8 秒内没在进程表里匹配到 Chrome 主进程，pid 就是 0；后续 waitForPort 仍可能成功（超时已被放宽到 90 秒），于是 launch() 返回 pid=0 的句柄。调用 close() 时 -child.pid 是 -0，JS 里 -0 === 0，Node 把 0 解释为「当前进程组」——等于任务给自己和同组进程发 SIGTERM。在 daemon 里跑时会连带把 daemon 和正在跑的任务一起带走。

**建议**：close() 开头加 if (!child.pid) 分支，只做 killStaleChrome + resetProfileLocks；更彻底的是 findChromePid 返回 0 时直接抛错让 launch 重试，不要把 0 当合法 pid。

### 1.2 core/daemon.mjs:58、:61、:69、:72、:77 —— 日志流不 end、spawn 无 error 监听、定时器只在 close 清理

~~~js
const out = fs.createWriteStream(logFile);                 // 58：整个生命周期不 end()
const child = spawn(process.execPath, [file], {...});      // 61：没有 child.on('error')
const timer = setTimeout(... kill ..., 10 * 60 * 1000);    // 69
const beat = setInterval(... overlay.status ... , 4000);   // 72
child.on('close', (code) => { clearInterval(beat); clearTimeout(timer); ... }); // 77
~~~

**为什么是问题**：

- out 从不 end()，fd 只能等 GC 回收。**实测**：daemon（pid 67923）至今仍持有 23:27 就已结束的 logs/daemon/headless-demo-2026-11-06T15-25-15-767Z.log 的写 fd（下面这条 lsof 是刚跑的）。

~~~text
$ lsof -p 67923 | grep logs/daemon
node 67923 tester 20w REG ... logs/daemon/headless-demo-2026-11-06T15-25-15-767Z.log
~~~

- 子进程 spawn 失败会触发 'error'；没有监听时 Node 当未捕获异常，**daemon 整个进程退出**。同样，runner.mjs:48、ocu-mcp.mjs:47 也都没有 'error' 监听。
- 10 分钟 kill 定时器和 4 秒心跳只在 'close' 里清；若 'error' 先发生而 'close' 没来，心跳会一直推状态、kill 定时器也悬着。

**建议**：close 里 out.end()；加 child.on('error') 做与 close 相同的清理并 resolve；把清理抽成 finish()，用 Promise.race 防重复触发。

### 1.3 core/runner.mjs:41-44、:78-84 —— 结构化日志写入没有 await，close 与写存在竞态

~~~js
const record = (entry) => { void fd.write(line + '\n'); };   // 43：不 await、不 catch
...
record({ event: 'end', ... });                                // 81
await fd.close();                                             // 82
~~~

**为什么是问题**：scripts/health.mjs:72 靠日志里的 "event":"end","code":[1-9] 判定任务失败。写入不 await、紧接着就 close()，属于「未完成的 FileHandle 操作遇到 close」，理论上可能丢末尾几行或报 EBADF（未捕获的 rejection）。实测目前跑过的 jsonl 末尾 end 行都在（logs/runs/2026-11-06T15-29-44-791Z-headless-demo.jsonl 最后一行就是 "event":"end","code":0），还没踩中，但没有保证。

**建议**：record 改成串行 promise 队列（queue = queue.then(() => fd.write(...))），close 前 await queue。

### 1.4 core/ocu-mcp.mjs:47-56、:96-100 —— spawn 无 error 监听、stdin 写入无保护

~~~js
this.child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], env });   // 47
// 只挂了 stdout/stderr/exit，没有 'error'
this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');  // 96-100
~~~

**为什么是问题**：resolveOcu() 返回的路径存在但不可执行（权限、坏 shebang、打包后路径变化）时，spawn emit 'error'，没有监听 → 进程崩溃；MCP 子进程意外退出后继续 _request，stdin.write 会抛 EPIPE，同样没人接。这个客户端是 README 主推的「MCP 常驻」路径，user-chrome.mjs、mcp-demo 都依赖它。

**建议**：child.on('error') 里置 closed 并 reject 所有 pending；_request 内 try/catch write，并处理 stdin 的 'error'。

### 1.5 core/cdp.mjs:179、:203、:341 —— socket 错误与协议解析异常会变成未捕获异常

~~~js
socket.on('error', (error) => { this.emit('error', error); ... });  // 179：MiniWebSocket
ws.on('error', (error) => this.emit('error', error));               // 341：CDP 层再抛一次
const frame = this.readFrame();                                      // 203：readFrame 可能 throw
~~~

**为什么是问题**：CDP 继承 EventEmitter，而所有调用方（CLI、electron-task.mjs 的 wrapSession）都没有 cdp.on('error')。Node 在无 'error' 监听时 emit('error') 会**抛出**——连接中途断开（目标崩溃、端口被关）会让任务进程直接崩掉，而不是拿到可处理的异常。另外 readFrame() 在 'data' 回调里同步执行（:203），遇到超大帧（:233 throw）或非法 RSV（:221）会同步抛出，同样绕过 promise 链。

**建议**：CDP 构造函数里默认挂 no-op 'error' 监听（或把错误转成 pending 请求 reject + 'close' 事件）；onData 外层 try/catch 把解析错误转成 finalize(1002)。
## 2. 中：会误导（文档/显示/判定与实现不符）

### 2.1 scripts/health.mjs:52-54 —— 「最近任务失败数」永远 0/0

~~~js
const daemon = await getJson('http://127.0.0.1:7789/');     // 27
const hist = daemon.history || [];                           // 52 ← 这个字段不存在
const fails = hist.filter((h) => h && h.ok === false).length;
~~~

**为什么是问题**：daemon 的 GET / 只返回 {ok, service, pid, uptimeSec, current, queued, tasks}（core/daemon.mjs:104-113），history 只在 GET /status 和 GET /tasks 里。**实测**：

~~~text
$ curl -s http://127.0.0.1:7789/          → 没有 history 字段
$ curl -s http://127.0.0.1:7789/status    → 有 history，含 headless-demo ok:false
$ node scripts/health.mjs
  ✅ 最近任务失败数  0 / 0        ← 明明 24h 内有 4 次真失败
  ❌ 24h 运行记录   100 次｜近 1h 真失败 1｜24h 真失败 4｜…
~~~

同一次输出里上下两行自相矛盾，说明这一行是死数据。提交 c7c70b0 号称「一条命令看…失败」，这条实际没生效。

**建议**：改读 GET /status；并加断言，history.length === 0 时显示「无历史」而不是绿色 0/0。

### 2.2 core/platform.mjs:65、overlay/platform.js:157 —— isScreenLocked 只看键在不在，不看值

~~~js
// core/platform.mjs:65
return /CGSSessionScreenIsLocked"?\s*=\s*(Yes|true|1)/i.test(out) || out.includes('CGSSessionScreenIsLocked');
// overlay/platform.js:157
return out.includes('CGSSessionScreenIsLocked');
~~~

**为什么是问题**：CGSSessionScreenIsLocked 是 IOConsoleUsers 字典里的常驻键，未锁屏时值是 No。includes 会无视值直接判 true，前面的正则被 || 短路掉。**用字符串模拟已复现**：

~~~text
模拟未锁屏文本："CGSSessionScreenIsLocked"=No
core/platform.mjs 写法   => true   ← 误判
overlay/platform.js 写法 => true   ← 误判
~~~

后果不致命但会误导：browser.launch() 会把超时白放宽 3 倍并打印「检测到锁屏」（core/browser.mjs:262-265），小窗 /health 永远显示已锁屏（overlay/main.js:1322）。当前机器确实锁屏（Yes），所以暂时看不出来，一解锁就暴露。

**建议**：统一用 /"?CGSSessionScreenIsLocked"?\s*=\s*(Yes|true|1)/i 判断，删掉 includes 兜底；两处实现合并到同一个平台模块。

### 2.3 overlay/package.json:3 —— 版本 0.5.0 与仓库 0.7.0 不一致

**为什么是问题**：electron-builder.yml 用 overlay/package.json 的 version 生成产物版本和 DMG 文件名，打出来是 0.5.0，与根 package.json 的 0.7.0、CHANGELOG 的 0.7.0 对不上。scripts/repo-check.mjs 只比对「根 package.json vs CHANGELOG」，没查 overlay，所以体检全绿。

**建议**：overlay/package.json 版本跟根保持一致；repo-check 增加「overlay 版本 == 根版本」。

### 2.4 core/acceptance.mjs:112 —— 有环境跳过时退出码仍是 1

~~~js
const passed = RESULTS.filter((r) => r.ok && !r.skipped).length;   // 91
const total = RESULTS.length;                                       // 93
process.exit(passed === total ? 0 : 1);                             // 112 ← 没减 skipped
~~~

**为什么是问题**：报告头写的是 passed/(total-skipped)（:94、:104），退出码却拿 passed 和 total 比。只要有一项「环境跳过」（锁屏、宿主被占用、页面改版——都是它自己定义的正常情况），退出码就是 1，CI/自动化会把整轮判失败。

**建议**：process.exit(passed === total - skipped ? 0 : 1)。

### 2.5 docs/USAGE.md:358 —— 说 service.mjs 没补 PATH，实际已经补了

~~~text
或者给 plist 补 PATH（core/service.mjs 目前没写，属于已知缺口）
~~~

但 core/service.mjs:39-43（daemon plist）和 :59-62（overlay plist）都已经写了 PATH，f4fb282 的提交说明也明确说「两个 launchd plist 补 PATH」。文档停在修复前。

**建议**：4.3 第 6 条改成「已修复（f4fb282），若仍出现请确认 plist 已被重新 bootstrap」。

### 2.6 数值类文档与代码不符（三处）

| 位置 | 文档写的 | 代码实际 |
| --- | --- | --- |
| docs/USAGE.md:526 | OVERLAY_FPS 默认 7，范围 1–12 | overlay/main.js:77 默认 **15**，clamp **1–30** |
| docs/USAGE.md:546 | 缩略图最长边 **1600px** | overlay/main.js:58 THUMB_MAX_PIXEL_WIDTH = **2560** |
| docs/USAGE.md:541 / ARCHITECTURE.md:58 / overlay/main.js:76 注释 | 抓帧「约 7fps」 | 默认值 15fps（实际受 screencapture 耗时限制，约 100–125ms/帧，注释里也这么写，但默认值已经改成 15） |

顺带：overlay/main.js:56 注释写「上限 1600；质量 88」，:877 注释又写「上限 1600」，变量却是 2560/92——同一文件里两处旧注释。

**建议**：以代码为准更新 USAGE 这三处；把注释里的数字换成引用常量，避免再次漂移。

### 2.7 CAPABILITIES.md:21、:49 —— 空闲时间与验收结果过时

- :21 写「8 秒空闲淡出」，代码 overlay/main.js:84 默认 **5000ms**（README 和 USAGE 都写 5 秒，只有这里还写 8 秒）。
- :49 写「当前结果 6/6 PASS（overlay 在线、手动隐藏、活动显示、boss-scan、multi-app、form-fill）」，但 core/acceptance.mjs:84-89 现在跑 **6 个任务**，是 boss-scan / multi-app / form-fill / platform-demo / browser-demo / electron-demo，清单完全不同。
- :3 最后更新 2026-11-05，早于 0.7.0。

**建议**：更新这两行；或直接删掉容易过期的「当前结果」，只留跑法。
### 2.8 README.md:104-111 —— 行数表、任务数、总行数全部过时

| 项 | README | 实际（本次统计） |
| --- | --- | --- |
| 「~9000 行自己写的代码」 | 9000 | core+overlay+scripts+test/tools ≈ **11481 行** |
| core/ | 5566 | **6641** |
| overlay/ | 2788 | **3587** |
| scripts/ | 381 | **744** |
| test/ + tools/ | 286 | **509** |
| 「14 个任务」 | 14 | ls core/tasks/*.mjs = **17** |

另外 README.md:3 的 CI 徽章还是 USER/desktop-agent 占位符，链接是死的。

**建议**：要么更新数字，要么去掉具体行数（它们几乎每次提交都会漂）；徽章换成真实仓库地址或删掉。

### 2.9 ARCHITECTURE.md:3 —— 「最后更新 2026-11-06（v0.5）」

仓库已经是 0.7.0（package.json:3、CHANGELOG），ARCHITECTURE 里还写着 v0.5，也没有 0.6 的 MCP 常驻、0.7 的 headless 内容（第 4 节数据流仍是 screencapture 约 7fps 的旧描述）。

**建议**：更新版本号和 0.6/0.7 的架构变化（MCP 控制层、headless 浏览器、多会话小窗）。

### 2.10 死代码：core/frames.mjs 与 core/permissions.mjs

- core/frames.mjs:10 的 startFrameStream 在全仓库 **0 引用**（grep 只命中定义本身），README.md:183 的目录表却还列着「frames.mjs # 实时帧推送」。实际推帧在 overlay/main.js 的缩略图循环和任务自己的 /frame 调用里。
- core/permissions.mjs 也 **0 引用**；但 docs/USAGE.md:374 写「core/permissions.mjs 就是解析它的 accessibilityTrusted / screenCaptureGranted」，scripts/health.mjs:40-46 又自己重写了一份解析逻辑。文档指向的模块是死的，实际生效的是 health 里的复制品。

**建议**：删掉 frames.mjs 或接回任务层；permissions.mjs 要么被 health/acceptance 引用，要么删掉并改文档。

### 2.11 scripts/health.mjs:75 —— 「已知环境失败」正则过宽

~~~js
const known = /环境跳过|改成了指定关键词|已联系|未送达|锁屏|cgWindowNotFound|宿主窗口|还有 null 个窗口|No such file or directory|屏幕无窗口验收未过/;
~~~

No such file or directory 是通用 ENOENT：路径写错、二进制缺失、临时目录被删，全都会被归成「已知环境问题」从统计里消失；「还有 null 个窗口」这种依赖日志措辞的匹配也很脆。

**建议**：改成白名单式的结构化标记（任务自己在 jsonl 里写 skippedReason 字段），health 只认字段，不猜文本。

### 2.12 overlay/main.js:433、:1498 —— 写死的 bundle id 与打包产物不一致

~~~js
const self = 'com.github.Electron';                              // 433：开发态 Electron 的 bundle id
setTimeout(() => { attachToDsh(s, 'com.deepseek.dsh', dshBounds).catch(() => {}); }, 100);  // 1498
~~~

**为什么是问题**：

- 打包后 CFBundleIdentifier 是 com.goodlifedog.dsh-desktop-agent（overlay/electron-builder.yml 的 appId；dist-app/Desktop Agent.app/Contents/Info.plist 实测确认）。用户点一下小窗（点 ⤢/✕ 或拖拽条）时小窗自己成为 frontmost，frontOk = !front || HOST_BUNDLES.includes(front) || front === self 变成 false → shouldHide=true → 所有小窗被藏起来。开发态（com.github.Electron）不会复现，打包版才会。
- :1498 放大还原时写死 com.deepseek.dsh，绕过了 HOST_BUNDLES 配置；用户用 OVERLAY_HOST_BUNDLES 换成别的宿主时，放大还原后窗口可能一直不显示。

**建议**：self 改用运行时值（app.getAppPath()/app.getName() 或把打包 appId 加进默认 HOST_BUNDLES）；:1498 复用 attachTick() 而不是写死。

### 2.13 README.md:193、docs/USAGE.md:234 —— 点击热区描述不完整

README 写「只有右上角 ⤢/✕ 和顶部 8px 拖拽条接管鼠标」，实际 overlay/main.js:660-678 的 cursorInHotspot 还接管了**四边** 8px、左上角日志入口（4–60 × 4–32）、以及错误态的底部操作按钮（:676）；overlay/index.html:53-56 也确认四边都有 drag-strip。

**建议**：文档改成「四周/顶部 8px 拖拽条 + 右上角按钮 + 左上角日志入口（+ 错误态底部按钮）」。

## 3. 低：可改进（不影响正确性，但迟早会硌人）

1. core/daemon.mjs:43-48 —— readBody 超大 body 只 req.destroy()，Promise 永远不 resolve，请求挂起；应 reject。
2. core/browser.mjs:249-251 —— restoreFront 三个 setTimeout 没有清理/去重；进程提前退出时定时器会拖住事件循环最多 2.2s，并重复激活前一个应用 3 次。
3. scripts/start-all.mjs:55-57 + overlay/start.mjs —— start-all 只给直接子进程发 SIGTERM；start.mjs 没有把信号转发给 Electron 子进程。Ctrl+C 能停是因为终端把信号广播到整个进程组，用 kill <start-all pid> 时 Electron 可能残留。
4. overlay/supervisor.js:34-60 —— startDaemon 的 spawn 没有 'error' 监听；stopDaemon 只 kill 不等待退出。
5. core/service.mjs:54-55 —— overlay plist 写死 overlay/node_modules/electron/... 路径，打包成 App 后这个路径不存在；service:install 仍会写并 bootstrap，launchd 会反复失败重启。
6. scripts/ui-regression.mjs:10-15 —— overlay 离线时 health() 返回 null，紧接着 Object.prototype.hasOwnProperty.call(null, …) 抛 TypeError，脚本以栈崩代替「服务不在线」提示。
7. scripts/health.mjs:42 —— 用 path.join(process.env.HOME, '.local/bin/ocu') 拼路径，绕过 resolveOcu()；设了 OCU_BIN 或 HOME 异常时会误报「读不到 ocu doctor」。
8. core/ocu-mcp.mjs:55 —— clientInfo.version 硬编码 0.6.0，当前包 0.7.0；服务端日志会看到错误版本（实测 MCP 能起、11 个工具，只这一处版本信息陈旧）。
9. overlay/main.js:1322 —— 每次 /health 都同步 execFileSync ioreg（core/platform.mjs:64），最坏阻塞主进程 3 秒；健康轮询密集时小窗会卡。建议缓存 5–10 秒。
10. core/agentd.mjs:158-171 —— guard() 里 fn() 抛错时不再检查前台（after 丢失），也没记日志，事后难判断是不是被抬了前台。
11. core/browser.mjs:40-47 —— readDevToolsActivePort 先 existsSync 再 readFileSync，存在 TOCTOU：Chrome 退出瞬间会抛 ENOENT（外层 launch 会捕获重试，但错误信息会变差）。
12. 缺文件末尾换行：core/platform.mjs、core/browser.mjs、core/service.mjs、core/tasks/headless-demo.mjs、overlay/platform.js（tail -c 1 检查；7181a78/5fddf59/8878753 的 diff 里也能看到 No newline at end of file）。建议统一加。
13. CAPABILITIES.md:20、:24 —— 「多应用并行」重复了两行。
14. 未使用的导出（全仓库只出现定义本身）：core/browser.mjs 的 findChromePid / killStaleChrome / resetProfileLocks / sanitizeProfile / CHROME_BIN / DEFAULT_PROFILE。这些函数仍被 browser.mjs 内部使用，但对外暴露没有消费者；要么收窄导出，要么注明是给外部/测试用的 API。
## 4. 逐条对照最近 12 个提交（说明 vs 代码）

| 提交 | 说明要点 | 代码是否对得上 | 备注 |
| --- | --- | --- | --- |
| c7c70b0 整体状态面板 | scripts/health.mjs 一条命令看服务/权限/小窗/队列/失败/锁屏/随包 ocu | 大部分对：脚本在、字段在、失败分类确实实现了 | 「最近任务失败数」永远 0/0（2.1） |
| f4fb282 修两个真问题 + 补手册 | browser 真正接上锁屏超时；两个 plist 补 PATH；headless-demo 锁屏跳过；USAGE 574 行 | **对**：browser.mjs:261-265 有 isScreenLocked/×3；service.mjs 两个 plist 都有 PATH；USAGE 实际 574 行 | 但没回头改 USAGE 4.3 的旧说法（2.5） |
| 5fddf59 小窗健康补 screenLocked | platform.js isScreenLocked；/health 暴露 screenLocked；main.js 1650 行 | **对**：overlay/main.js:1322、platform.js:153-159；main.js 当前 1650 行 | 引入了值盲判断（2.2） |
| 7181a78 锁屏自动放宽超时 | 「core/browser.mjs 启动前检测，锁屏时等待端口时间 ×3，并打印提示」 | **不对**：diff 只在 browser.mjs 加了 import（还有 EOF 换行被删），没有任何调用 | 典型的「说了没做」；f4fb282 补实并自述 |
| aa4de48 记录失败模式 | ARCHITECTURE 加两条已知失败模式 | **对**：ARCHITECTURE.md:89-90 两条都在 | — |
| 7a82abc daemon 每 4 秒推进度 | 任务期间每 4 秒推「后台任务：名字 · Ns」 | **对**：daemon.mjs:72-75 是 4000ms 的 setInterval，close 里清理 | error 路径不清理（1.2） |
| 36974ff 补放大态实拍 | 新增 docs/ui-expanded-live.jpg | **对**：文件存在（318KB） | — |
| 781f155 小窗状态截图脚本 | scripts/ui-gallery.mjs + 三张状态图入 docs/ | **对**：脚本在，ui-gallery-running/expanded/error.png 都在 | 脚本依赖 launchctl 重启 overlay，只适合作者本机 |
| af40527 错误提示可读性 | 文案精简；回归断言改成「无画面回退 4:3」 | **对**：main.js 文案改了；ui-regression.mjs 有 expected = frameRatio 或 4/3 | — |
| 060cd8d 小窗效果回归 | 14 项断言，npm run ui:regression 可跑 | **对**：scripts/ui-regression.mjs 数下来正好 14 条 record，package.json 有脚本 | overlay 离线时会 TypeError（3.6） |
| 8878753 清晰度 1600→2560 | THUMB_MAX 1600→2560、质量 88→92、headless clip.scale=2 | **对**：overlay/main.js:58、:60；headless-demo.mjs 的 captureScreenshot 带 clip.scale=2 | USAGE 的 1600px 没跟着改（2.6） |
| 28e26d1 小窗美观与实用 | 状态胶囊、人话错误、hostVisible/hostBoundsStale、点击热区、ui-check 脚本 | **对**：/health 有 hostVisible/hostBoundsStale/clickThrough；preload 有 fix/setAction；scripts/ui-check.mjs 在 | 硬编码 self bundle id（2.12） |

**小结**：12 条里 11 条说明与代码相符；唯一不符的 7181a78 已被下一个提交补上。也就是说「曾经出现过说明与代码不一致」这件事属实，但现在的代码状态是修好的。

## 5. 确认没问题的部分（避免只报坏消息）

- **单测**：npm test → 35 条用例，34 pass、1 skip、0 fail（19 条 humanize 与 CHANGELOG 的「19 条单测」对得上）。
- **语法**：npm run check 通过；另外对 core/overlay/scripts/tools/test 下全部 .mjs/.js 逐个 node --check，全部通过。
- **import 路径**：静态扫描所有相对 import/require，没有指向不存在文件的（打包路径另说，见 3.5）。
- **仓库体检**：npm run repo:check 全部通过（但它只查版本一致性/大文件/隐私，覆盖面有限，见 2.3）。
- **文档里点名的东西都能找到**：package.json 的 24 个 script 全部存在；scripts/export.sh、overlay/electron-builder.yml、third_party/open-computer-use、flow/{OCU-INTEGRATION,PACKAGING,CROSS-PLATFORM,WINDOWS-TESTING,BOSS-GREET}.md、overlay/docs/multi-session.png、ui-expanded-live.jpg、ui-gallery-*.png 都存在；README 里的 npm 写法（含不带 -- 传参）在 npm 10.8.2 下实测可用。
- **MCP**：实测能起，tools 数 = 11（click/drag/query/get_app_state/list_apps/perform_secondary_action/press_key/scroll/set_value/select_text/type_text），与 CHANGELOG 0.6.0 的「11 个工具」一致。
- **ui-regression**：断言数与提交说明一致（14 条）。
- **清理做得好的地方**：browser-demo、form-fill-local、electron-demo、boss-scan-dedicated 都有 finally 收尾；overlay 的 cleanup() 在 before-quit 里统一停 timers / HTTP server / 临时目录；server.js 的 body 上限、session 校验、405/404/413 分支齐全，没有吞错。
- **CDP 客户端**：帧解析有边界检查（长度/掩码/分片/ping-pong），13 项验收通过；问题只在 socket error 事件没人接（1.5）。

## 6. 建议修复顺序与审查限制

**按性价比排序**：

1. browser.mjs 的 pid=0 保护（1.1）——改动一行，避免误杀进程组。
2. daemon.mjs 日志流 end + 'error' 监听 + 统一清理（1.2）——daemon 是常驻进程，fd/崩溃都是累积问题。
3. ocu-mcp.mjs 与 cdp.mjs 的 'error' 事件兜底（1.4、1.5）——一条 no-op 监听就能从「崩溃」变成「可处理错误」。
4. health.mjs 读 /status + isScreenLocked 值判断（2.1、2.2）——都是「显示的信息是错的」，会直接误导排查。
5. 文档批量更新（2.5–2.9、2.13）——一次性把 USAGE/README/CAPABILITIES/ARCHITECTURE 对齐 0.7.0，顺手删掉死代码（2.10）。
6. overlay 版本号与 bundle id（2.3、2.12）——影响打包产物和打包版交互。
7. 其余低优先级项（第 3 节）按需处理。

**本次审查的边界（没做到的）**：

- 没有在 Windows 实机验证；README 里 Windows 分支一律按「未实机验证」对待。
- 没有跑 npm run accept / npm run restart:check（会重启服务、操作真实应用/浏览器，超出只读范围）。
- 审查期间屏幕处于锁屏状态，无法对比「未锁屏」时的实际输出；2.2 的误判是用字符串模拟证明的，不是解锁实测。
- 1.1 的 kill(-0) 没有实机触发（需要 Chrome 启动超过 8 秒且 8 秒内进程表匹配不到），是按 Node 文档 + 代码路径推演，建议修复时加一条单测或日志断言。
- 只读了 .github/workflows/ci.yml 的内容，没有查 CI 的实际运行结果。
