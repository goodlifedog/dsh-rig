# 使用手册

> 这份文档回答两件事：**日常怎么用**、**出问题怎么查**。
> 项目是什么、为什么这么设计，看 [README.md](../README.md) 和 [ARCHITECTURE.md](../ARCHITECTURE.md)；每个流程的踩坑细节在 `flow/`。
>
> 实测环境：macOS 26.5.1、Node 20、ocu 1.1.3、Electron 41。命令都对着仓库里的实际代码核对过。

---

## 0. 先看这里

三条铁律，违反任何一条都会出现「自作主张的操作」或「屏幕被抢」：

1. **所有 ocu 调用必须带 `OPEN_COMPUTER_USE_VISUAL_CURSOR=0`**，否则屏幕上会飘一个假光标。服务安装脚本（`core/service.mjs`）的 plist 里已经写死这个变量。
2. **不要对用户正在用的应用截图**：`get_app_state` 带 `includeScreenshot: true` 会把那个应用**提到前台**（`flow/BACKGROUND-CONTROL.md` 有实测）。截图只用于我们自己的 headless / 离屏实例。
3. **目标应用变成前台就中止**：`core/agentd.mjs` 的 `guard()` 是硬护栏，会直接报错。

目录约定（相对仓库根目录）：

| 路径 | 是什么 |
| --- | --- |
| `core/` | daemon、任务运行器、平台层、浏览器/CDP、ocu 封装 |
| `core/tasks/` | 所有任务，一个文件一个任务，文件名就是任务名 |
| `overlay/` | Electron 小窗（端口 7788） |
| `flow/` | 方法论与踩坑记录（RECIPE / BOSS-GREET / CDP-FALLBACK / PACKAGING …） |
| `logs/` | 运行日志（不进 git） |
| `reports/` | 验收报告（不进 git） |

---

## 1. 三分钟上手

### 1.1 环境自检

```bash
cd desktop-agent
npm run doctor
```

正常输出（本机实测）：

```text
平台自检（darwin）

  ✅ 平台              darwin（macOS）
  ✅ 控制后端            ocu
  ✅ ocu 可执行文件       …/third_party/open-computer-use/bin/ocu
  ✅ 数据目录可写          ~/.desktop-agent/smoke
  ✅ 小窗服务 7788        pid=36336 sessions=default
  ✅ 后台 daemon 7789  pid=62730 tasks=17
```

有 ❌ 就先去第 4 节对应条目。**换机器第一件事永远是跑这个。**

### 1.2 装依赖

```bash
npm run setup     # 根目录依赖 + overlay/node_modules（会联网下 Electron，约 100–200MB）
```

ocu 的查找顺序（`core/platform.mjs`）：`OCU_BIN` → 随包 `third_party/open-computer-use/bin/ocu` → `~/.local/bin/ocu` → PATH。本机实际用的是随包那份。

### 1.3 起服务

两个常驻服务：**daemon（7789，调度）** 和 **小窗（7788，展示）**。二选一：

```bash
# A. 装成开机自启（launchd），日常用这个
npm run service:install

# B. 只临时起一下：一条命令带起 daemon + 小窗，Ctrl+C 一起停
npm start

# C. 只要 daemon，不要小窗
npm run daemon
```

> 小窗想单独起：`npm run overlay`（走 `overlay/start.mjs`，内部会去掉 `ELECTRON_RUN_AS_NODE`，本机必须这样，否则 Electron 会以 Node 模式跑、没有窗口）。

### 1.4 看状态

```bash
npm run status
```

```text
=== 桌面代理状态 ===
小窗     : 在线 pid=36336 | 状态「任务完成：headless-demo」| 已隐藏
缩略图   : live (窗口 85) | 日志 24 条
运行中   : 无任务

=== 最近任务 ===
✅ 23:08:58  browser-demo    3.4s    结果: 6/6
✅ 22:47:41  headless-demo   3.9s
```

- 「运行中」列出的是 `/tmp/agentd-*.lock` 应用锁，说明此刻哪个应用被某个任务占着。
- 「最近任务」读的是 `logs/runs/*.jsonl`，最后一行会带任务的结论（比如 `结果: 6/6`）。

### 1.5 跑第一个任务

```bash
npm run list                  # 看有哪些任务（当前 17 个）
npm run run headless-demo     # 推荐：全程零窗口，最干净，不会碰你的屏幕
```

跑通的样子（本机实测）：

```text
[runner] headless-demo 第 1/1 次
  │ [0] 启动前前台: DeepSeek Harness pid 13790
  │ [1] headless Chrome 启动: 1334 ms, 端口 61630 pid 39716 （第 1 次尝试, 清理残留 0 个）
  │ [1b] 命令行含 --headless=new: true
  │ [2] 页面加载: 35 ms, 标题: Example Domain （load 完成: true ）
  │ [3] CDP 截图推帧: 51767B / 51767B / 51767B ；小窗 visible=true frameBytes=51767 clickThrough=true
  │ [4b] 拟人点击: 541 ms；落点 URL: https://www.iana.org/help/example-domains
  │ [5] 屏幕上没有窗口：pid 39716 的窗口数 = 0 ；前台: DeepSeek Harness pid 13790
  │ [6] 关闭: 290 ms, 进程已退出: true ；同 profile 残留进程: 0
[runner] 成功，用时 4.6s，日志 …/logs/runs/2026-11-06T14-11-31-488Z-headless-demo.jsonl
```

其他自证类任务（都不会动你的数据）：

| 任务 | 干什么 | 大概耗时 |
| --- | --- | --- |
| `headless-demo` | headless 浏览器：启动→导航→截图推帧→拟人点击→验证零窗口 | 5s |
| `browser-demo` | 离屏 Chrome + CDP：导航/读 DOM/点击/填输入框，6 项自证 | 3–5s |
| `electron-demo` | Electron + CDP：读 title、点击、输入 | 10s |
| `form-fill-local` | 本地静态页填表（文本/下拉/勾选）对照实验 | 15s |
| `platform-demo` | 跨平台控制层通路自检 | 5s |
| `coverage-probe` | 扫描当前运行应用的 AX 可读性，出覆盖率表 | 1–2min |

任务失败时退出码非 0，runner 会打 `FAIL: …`，日志照样落在 `logs/runs/`。

### 1.6 停 / 卸

```bash
npm run stop              # 停 daemon（cli.mjs stop）
npm run service:uninstall # 移除 launchd 自启（daemon + overlay 两个 plist）
```

---

## 2. 三种运行方式怎么选

都不同屏，但代价和适用场景不同：

| 方式 | 屏幕上有没有窗口 | 控制手段 | 登录态 | 什么时候用 |
| --- | --- | --- | --- | --- |
| **headless 浏览器** | 完全没有 | CDP（页面内鼠标/键盘） | 独立 profile，首次要登录 | 纯网页自动化，最干净 |
| **你自己的 Chrome** | 有，但不抬、不切、不抢焦点 | AX 语义点击 + `sky_key` | 直接用你已登录的 | 需要登录态、需要你**看着**页面 |
| **离屏实例** | 没有（窗口在 -5000,-5000） | CDP | 独立 profile | 需要独立登录态，又要真窗口语义 |

一句话决策：

- 不需要登录态 / 只跑网页流程 → **headless**（`node core/runner.mjs run headless-demo`）
- 必须用你现成登录态、又不希望脚本弹窗 → **你自己的 Chrome**（`npm run run user-chrome-demo`）
- 两边都不想要（独立登录态 + 不想看到窗口）→ **离屏实例**（`npm run run browser-demo`）
- 目标不是浏览器（Electron 应用）→ 见 2.4，走 CDP 兜底

### 2.1 headless 浏览器

代码：`core/browser.mjs` 的 `launch({ headless: true })`，参数是 `--headless=new`。profile 默认 `~/.desktop-agent/headless-profile`。

- **屏幕上 0 窗口**：实测 `System Events` 数该 pid 的窗口数 = 0，CGWindowList 里也没有它的窗口。
- 画面靠 CDP 截图 `POST /frame` 推给小窗（推帧频率由推流方决定，实测可到 ~12fps），小窗里能看、能显示虚拟光标。
- 启动前会自动清同一 profile 的残留进程 + `DevToolsActivePort`/`SingletonLock`；失败自动重试一次。实测有残留时也能 695ms 起来，日志会写「清理残留 1 个」。
- 登录态要单独维护：在 headless/离屏 profile 里登录一次即可长期保留。

### 2.2 你自己的 Chrome

代码：`core/user-chrome.mjs`（`ensureUserChrome / readState / find / clickText`），底层走 ocu 的 MCP 常驻连接。

- 只读 AX 树 + 语义点击 + `sky_key` 后台键入，不移动指针、不切标签页。
- **不要**给它带 `includeScreenshot: true`（会把 Chrome 提到前台）。
- 已经有登录态，适合「读列表、点筛选、点收藏」这类后台动作。

### 2.3 离屏实例

代码：`core/browser.mjs` 的 `launch({ headless: false })`：独立 user-data-dir + `--window-position=-5000,-5000`，连上后再用 `Browser.setWindowBounds` 把窗口钉到屏幕外。

- 启动前会 `sanitizeProfile`：删掉 `window_placement` 和会话恢复文件，否则 Chrome 会按上次位置把窗口还原到你屏幕上。
- 用到 BOSS 投递这类需要独立登录态的流程（`greet-verify`、`boss-scan-dedicated`）。

### 2.4 不是浏览器：原生 App 与 Electron

- **原生 macOS 应用**（系统设置、访达、备忘录、计算器、App Store）：AX 很完整，直接 `core/agentd.mjs` 的 `ocu` 封装操作。参考 `flow/COVERAGE.md` 的覆盖率表。
- **Electron 应用**（AX 树很薄）：用 `core/electron-task.mjs` 走 CDP。前提是目标进程带 `--remote-debugging-port` 启动，已启动的第三方应用要重启才能加参数。用法见 `flow/CDP-FALLBACK.md` 第 11 节，示例任务 `electron-demo`。
- **Safari**：AX 只有浏览器壳，网页内容读不到，别指望 AX。
- **微信 / Telegram**：AX 只覆盖窗口壳，聊天内容基本读不到。

---

## 3. 小窗怎么读

### 3.1 长什么样、在哪

- 默认 **300 × 190**，14px 圆角、半透明、置顶（floating 层级，不盖别的 App），贴在 DSH 窗口右上角。
- **只在创建时所在的 Space 显示**，切桌面不跟过去（有意为之）。
- 多会话：每个 sessionId 一个窗口，在 DSH 窗口内按格子平铺，最多 12 个（`OVERLAY_MAX_SESSIONS`）。
- 标题门控：同一时刻只显示「当前前台 DSH 会话」对应的那个窗口。

### 3.2 状态点与状态胶囊

底部那条半透明胶囊是信息主体：

| 状态 | 视觉 | 含义 |
| --- | --- | --- |
| 待命 | **灰点**，胶囊整条隐藏 | 没有活动（`activity: idle`） |
| 运行中 | **绿点**（轻微呼吸）+ 一行「正在做什么」+ 右侧已用时 | 任务在跑（`activity: running`） |
| 出错 | **红点** + 淡红胶囊 + 一句人话原因 + 操作按钮 | `activity: error` |

胶囊上的字就是 agent 通过 `POST /status` 推的文案，太长会省略，悬停可在 title 里看全文。

### 3.3 日志抽屉

- 悬停胶囊（或点左上角极小的 `⋯`）滑出日志面板；点一下可以固定，移出窗口自动收起。
- 最多保留 **200 条**，就是 agent `POST /log` 推的内容（每一步动作）。
- 排查时先看这里：出错前的最后几条日志通常直接说明卡在哪。

### 3.4 它为什么自己消失了（这是设计，不是 bug）

- 收到 `/status`、`/log`、`/window`、`/frame` 等**活动**才淡入；最后一次活动后 **5 秒**自动隐藏（`OVERLAY_IDLE_HIDE_MS`，0 表示关闭自动隐藏）。
- **悬停暂停**：鼠标停在窗口上暂停隐藏；但兜底 `max(15s, 3×idleMs)` 完全没活动仍会强制隐藏（防「悬停标记卡住」）。
- **DSH 不在前台就隐藏**；DSH 最小化/隐藏/在别的 Space 时 `hostVisible=false`，也会收起。
- 标题不匹配当前 DSH 会话时隐藏（多会话门控）。

### 3.5 交互

| 操作 | 怎么做 | 备注 |
| --- | --- | --- |
| 放大 / 还原 | 点右上角 `⤢` | 比例按最近一帧画面自适应，没有画面回退 4:3 |
| 关闭这个会话的小窗 | 点右上角 `✕`，或先点一下小窗再按 Esc | 进程和 HTTP 服务还在，下次有活动会重新召唤 |
| 拖动 | 从四周/顶部 **8px 拖拽条**拖 | 拖动后位置固定，空闲仍会隐藏 |
| 缩放 | 拖窗口边缘 | 最小 250 × 160 |
| 点下面的页面 | 直接点小窗中心 | **默认整窗点击穿透**，只有 `⤢`/`✕`/胶囊/拖拽条接管鼠标 |

### 3.6 用 HTTP 读小窗状态

小窗自己有完整状态接口，比肉眼看更准：

```bash
curl -s http://127.0.0.1:7788/health | head -c 600
```

关键字段：

| 字段 | 看什么 |
| --- | --- |
| `ok` / `exists` | 服务在不在、这个 session 的窗口建没建 |
| `visible` | 现在是否真的显示在屏幕上 |
| `activity` | `idle` / `running` / `error`（状态点颜色来源） |
| `matched` / `titleHint` / `dshTitle` | 标题门控是否命中（为什么窗口被藏了看这里） |
| `hostVisible` / `hostBoundsStale` | 宿主 DSH 窗口此刻是否真的可见、坐标是不是缓存 |
| `clickThrough` | 是否处于点击穿透（true = 点击落到下面的 DSH） |
| `pinned` / `hovering` / `idleMs` / `hardHideMs` | 显隐规则当前状态 |
| `screenLocked` | 系统是否锁屏（锁屏下抓图/控制都会出问题） |
| `thumbnail.state` | 缩略图：`live` / `error` / 其它 |
| `fps` / `frameBytes` / `frames` / `captureMs` | 帧率、最近一帧真实字节数、累计帧数、抓图耗时 |
| `frameWidth` / `frameHeight` | 最近一帧像素尺寸（放大比例按它算） |

---

## 4. 排查清单

先记住万能三连，80% 的问题这三条就能定位：

```bash
npm run health                                   # 一条命令看全局（服务/权限/小窗/队列/失败）
npm run health -- --deep                         # 上面这些 + 跑一遍小窗效果回归
npm run doctor                                   # 环境 + 两个服务在不在
npm run status                                   # 小窗状态 + 有没有任务占着应用锁
curl -s http://127.0.0.1:7788/health | head -c 400   # 小窗自己怎么说
```

### 4.1 小窗不出现

按这个顺序查：

1. **服务到底在不在**

   ```bash
   curl -s -m 2 http://127.0.0.1:7788/health || echo OFFLINE
   launchctl list | grep desktop-agent
   ```

   - 连接失败 → 小窗进程没起。`launchctl list` 的格式是「PID 上次退出码 Label」，第二列就是退出码（`0` 正常，`-15` 表示被 SIGTERM 杀掉，其它非 0 是异常退出）。
   - 看日志找原因：`tail -30 logs/launchd-overlay.err`（未捕获异常、`SyntaxError`、模块加载失败都在这里）。
   - 重启：`launchctl kickstart -k gui/$(id -u)/com.desktop-agent.overlay`（装了服务时）；没装服务就 `npm run overlay` 前台起，报错直接可见。
   - 端口被占：`lsof -nP -iTCP:7788 -sTCP:LISTEN`。

2. **服务在，但 `visible:false`** —— 这是设计内行为，逐项对照：

   | health 线索 | 原因 | 处理 |
   | --- | --- | --- |
   | 刚空闲 5 秒 | 空闲自动隐藏 | 推一次活动验证：`curl -s -X POST http://127.0.0.1:7788/status -H 'Content-Type: application/json' -d '{"text":"ping"}'` |
   | 前台不是 DSH | 不在前台时隐藏（设计如此） | 切回 DSH |
   | `matched:false` | 该会话 titleHint 与当前 DSH 标题不匹配 | 推 `/status` 时带当前 `titleHint`，或看是不是推到了别的 session |
   | `hostVisible:false` | DSH 最小化/隐藏/在别的 Space | 切回 DSH 所在 Space，等它重新出现 |
   | `exists:false` | 这个 session 还没有窗口 | 推一条 `/status` 或 `/log`（按需建窗） |

3. **会话对不上**：小窗按 `session` 隔离。agent 侧读 `AGENT_SESSION`（默认 `default`），你 curl 时要带 `?session=xxx` 才看得到那个窗口。

4. **多会话爆了**：超过 `OVERLAY_MAX_SESSIONS`（默认 12）返回 409，关掉不用的：`POST /close {"session":"xxx"}`。

5. **小窗在别的 Space**：它只在创建时的 Space 显示，切回原来的桌面才看得到。

### 4.2 画面黑 / 显示「画面不可用」

缩略图是 `screencapture -l <windowID>` 抓的，黑屏基本是三类原因：

1. **没有「屏幕录制」权限**：小窗会显示「画面暂时不可用：…」+ 红色胶囊，按钮是 **打开设置**。
   去 系统设置 → 隐私与安全性 → 屏幕录制，勾选启动小窗的终端/Electron/App，然后重启小窗。
   判定：`curl -s http://127.0.0.1:7788/windows` 返回 500 也说明权限缺失。
2. **绑定的窗口 ID 失效 / 窗口在别的 Space / 已最小化**：`/health` 的 `thumbnail.state` 是 error。
   - 重新拿窗口列表：`curl -s http://127.0.0.1:7788/windows`（带 `self:true` 的是我们自己的窗口，别绑）
   - 重新绑：`curl -s -X POST http://127.0.0.1:7788/window -H 'Content-Type: application/json' -d '{"windowId":123456}'`
   - 或者直接点小窗上的 **重试** 按钮。
3. **headless 推帧没到**：headless 模式屏幕本来没有窗口，画面只能靠 `POST /frame`。
   - 看 `/health` 的 `frames` 是否在涨、`frameBytes` 是否非 0。
   - 自己手推一帧验证链路：`POST /frame` 的 `dataUrl` 必须是 `data:image/jpeg;base64,...` 或 PNG；body 上限 8MB。
   - 推帧方停了 → 3 秒后小窗恢复本地 screencapture，没有可抓的窗口就黑着，这是预期。

另外：**抓帧耗时高**（`captureMs` 200ms+）时 fps 会掉到 4–5，系统重负载过了会自己恢复，不是故障。

### 4.3 任务卡住 / 一直不结束

1. **先看是谁在跑**

   ```bash
   npm run status
   curl -s http://127.0.0.1:7789/status
   ```

   `/status` 的 `current` 是正在跑的任务（带 pid、日志路径），`queue` 是排队。

2. **想马上停**：`curl -s -X POST http://127.0.0.1:7789/stop`（清空队列并 SIGTERM 当前任务）。

3. **超时规则**（不是卡住，是还没到点）：

   | 层面 | 默认超时 | 怎么改 |
   | --- | --- | --- |
   | runner 单次任务 | 300 秒 | `node core/runner.mjs run <task> --timeout 600000` |
   | daemon 跑任务 | 硬编码 10 分钟 | 改 `core/daemon.mjs` 里的 `10 * 60 * 1000` |
   | 单次 ocu 调用 | 60 秒 | 任务里传 `{ timeout }` |

4. **应用锁在等**：同一应用同时只允许一个任务操作，锁文件 `/tmp/agentd-<app>.lock`。
   等待 120 秒会报「等待应用锁超时」；锁 180 秒没更新会被当过期自动清掉。先确认没有别的任务在跑。

5. **浏览器任务卡在「启动 Chrome」**：

   - 同一个 user-data-dir 只允许一个 Chrome。新版 `launch()` 启动前会自动清残留进程 + 端口/单实例锁，小窗日志会写「发现同 profile 的残留 Chrome 进程：…，正在清理」。
   - 还起不来就看有没有别的任务占着同一 profile：`ps -ax -o pid=,command= | grep -i "desktop-agent"`。
   - 失败重试一次后仍失败会报「启动 Chrome 失败（已尝试 2 次）：…」。

6. **daemon 里跑任务报 `env: node: No such file or directory`**：
   launchd 拉起 daemon 时 PATH 只有 `/usr/bin:/bin:/usr/sbin:/sbin`，而 ocu 是 `#!/usr/bin/env node` 脚本、本机 node 在 `~/.local/bin`——于是任务里所有 ocu 调用都失败。
   **绕法**：这类任务用 `npm run run <task>`（runner 继承你的 shell 环境）；或者给 plist 补 `PATH`（`core/service.mjs` 目前没写，属于已知缺口）。

7. **看日志定位**：

   - runner 跑：`logs/runs/<时间戳>-<任务名>.jsonl`，每行是 `start` / `line` / `end`，最后一行带退出码和耗时。
   - daemon 跑：`logs/daemon/<任务名>-<时间戳>.log`，就是任务子进程的 stdout+stderr。
   - daemon 自身输出：`logs/daemon.out`；launchd 两份服务：`logs/launchd-daemon.out/.err`、`logs/launchd-overlay.out/.err`。

### 4.4 权限缺失

需要两项系统权限：**辅助功能**（读/点 AX 树）和 **屏幕录制**（按窗口抓图）。

1. 判定：`npm run doctor` 看「ocu 可执行文件 / 控制后端」；更细的用
   ```bash
   OPEN_COMPUTER_USE_VISUAL_CURSOR=0 ocu doctor --json
   ```
   （`core/permissions.mjs` 就是解析它的 `accessibilityTrusted` / `screenCaptureGranted`）。
2. 授权对象：**启动小窗的那个进程**——终端（Terminal/iTerm）、Electron、或打包后的 App，三个是不同的授权条目。
3. 打开设置：
   - 辅助功能：系统设置 → 隐私与安全性 → 辅助功能
   - 屏幕录制：系统设置 → 隐私与安全性 → 屏幕录制
   - 改完必须**重启小窗/终端**才生效。
4. 打包 App 首次打开被 Gatekeeper 拦：`xattr -cr "/Applications/Desktop Agent.app"`，或右键 → 打开。
5. 症状速查：AX 读不到 → 辅助功能；缩略图黑/「画面不可用」/ `GET /windows` 500 → 屏幕录制；锁屏时两项都不可用（见 4.5）。

### 4.5 锁屏时变慢 / 超时

- 判定：`ioreg -n Root -d1 | grep CGSSessionScreenIsLocked`（`core/platform.mjs` 的 `isScreenLocked()` 就用这个；小窗 `/health` 也有 `screenLocked` 字段）。
- 现象：锁屏后 AX/UIA 整体失效；Chrome 这类 GUI 应用启动从 ~1s 变成 ~18s，任务容易超时（`ARCHITECTURE.md` 已知失败模式）。
- 处理：不要在锁屏时跑长任务；必须跑就把超时放宽（runner `--timeout`），或者等解锁再跑。浏览器类任务在锁屏下尤其容易误判失败。

### 4.6 其他常见症状

| 症状 | 原因 | 处理 |
| --- | --- | --- |
| 任务报成功但外部没变化 | 用「脚本自己看到的成功」自证 | 改用外部事实验收（BOSS 投递的差集判据） |
| 「等待应用锁超时：X」 | 另一个任务占着同一应用 | 等它结束，或确认没有僵死任务后删 `/tmp/agentd-*.lock` |
| 「前台发生了变化：X 被激活，操作已中止」 | `guard()` 护栏触发 | 说明操作把目标应用提到了前台，检查是不是用了截图/坐标点击 |
| ocu 元素 index 报 stale / not found | index 只对同一次 AX 快照有效 | 每次动作前重新取状态、重新解析 index（不要硬编码数字） |
| `ELECTRON_RUN_AS_NODE` 导致 Electron 起不来 | 本机全局有这个变量 | 用 `npm run overlay`（内部会去掉）或 `env -u ELECTRON_RUN_AS_NODE …` |

---

## 5. 命令速查

### 5.1 npm 脚本（全部来自 package.json）

| 命令 | 实际执行 | 用途 |
| --- | --- | --- |
| `npm run doctor` | `node core/platform-smoke.mjs` | 环境自检（平台/ocu/目录/两服务） |
| `npm run setup` | `npm install && npm install --prefix overlay` | 装依赖 |
| `npm run service:install` | `node core/service.mjs install` | 装 launchd 自启（daemon + overlay） |
| `npm run service:uninstall` | `node core/service.mjs uninstall` | 卸自启 |
| `npm start` | `node scripts/start-all.mjs` | 前台起 daemon + 小窗，Ctrl+C 同停 |
| `npm run daemon` | `node core/cli.mjs start` | 只起 daemon（detached） |
| `npm run stop` | `node core/cli.mjs stop` | 停 daemon |
| `npm run agent` | `node core/cli.mjs status` | daemon 状态（当前任务/队列/历史） |
| `npm run status` | `node core/status.mjs` | 小窗 + 应用锁 + 最近任务看板 |
| `npm run list` | `node core/runner.mjs list` | 列任务 |
| `npm run run <任务>` | `node core/runner.mjs run` | 前台跑任务（推荐，日志直接可见） |
| `npm run task <任务>` | `node core/cli.mjs run` | 提交给 daemon 排队跑 |
| `npm run overlay` | `node overlay/start.mjs` | 只起小窗 |
| `npm test` | `node --test test/` | 单测 |
| `npm run check` | 一串 `node --check` | 语法检查 |
| `npm run repo:check` | `node scripts/repo-check.mjs` | 仓库体检（版本/产物/大文件/隐私） |
| `npm run restart:check` | `node scripts/restart-check.mjs` | 真重启两服务并验证健康 |
| `npm run accept` | `node core/acceptance.mjs` | 端到端验收（需要两服务在线） |
| `npm run demo:platform` | `node core/runner.mjs run platform-demo` | 平台通路演示 |
| `npm run bench:ocu` | `node scripts/bench-ocu.mjs 4` | ocu 效率基线（CLI vs MCP 常驻） |
| `npm run check:ocu` | `node scripts/check-ocu.mjs` | 对比随包 ocu 与 npm 最新版 |
| `npm run ui:check` | `node scripts/ui-check.mjs` | 截小窗区域 + 附 health 指标，改外观前后对比 |
| `npm run ui:regression` | `node scripts/ui-regression.mjs` | 小窗行为回归（出现/消失/穿透/放大比例） |
| `npm run scope:check` | `node scripts/session-scope-check.mjs` | 会话隔离检查（只在本会话出现、切走多久消失、切回多久出现） |
| `npm run soak` | `node scripts/soak.mjs` | 稳定性巡检：连跑 6 轮任务，看耗时、内存增长、有没有有效帧 |

### 5.2 直接跑 node（npm 不覆盖的参数）

```bash
node core/runner.mjs list
node core/runner.mjs run <任务> --timeout 600000 --retries 2
node core/cli.mjs start|stop|status|tasks|run <任务>
node core/status.mjs
node core/acceptance.mjs
node core/tasks/<任务>.mjs          # 单跑一个任务文件（不经 runner）
```

### 5.3 小窗 HTTP（127.0.0.1:7788）

所有接口 POST 用 body 里的 `session`，GET 用 `?session=`；缺省 `default`。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/health?session=x` | 会话状态快照（不存在返回 `exists:false`，不建窗） |
| GET | `/sessions` | 所有会话摘要 |
| GET | `/windows` | 可截图窗口列表（`self:true` 是我们自己的窗口） |
| GET | `/frame-target?session=x` | 小窗当前需要的画面像素尺寸（收起 600×380，放大 1920×…），推帧方按它出图 |
| POST | `/log` | `{"text"}` 追加动作日志 |
| POST | `/status` | `{"text","state"}` 更新胶囊；state: `idle/running/error`；`{"clear":true}` 复位成「待命」 |
| POST | `/window` | `{"windowId"}` 切换缩略图目标（绑自身窗口返回 403） |
| POST | `/visible` | `{"visible":true}` 或 `false`：手动显隐；true 会固定显示（暂停自动隐藏） |
| POST | `/expand` | `{}` 放大/还原 |
| POST | `/frame` | `{"dataUrl","cursor","width","height"}` 外部推帧 |
| POST | `/close` | `{}` 关掉该会话窗口 |

```bash
curl -s http://127.0.0.1:7788/health | head -c 400
curl -s -X POST http://127.0.0.1:7788/status -H 'Content-Type: application/json' \
  -d '{"text":"手动验证一下","state":"running"}'
curl -s -X POST http://127.0.0.1:7788/visible -H 'Content-Type: application/json' \
  -d '{"visible":true}'
curl -s http://127.0.0.1:7788/sessions
curl -s -X POST http://127.0.0.1:7788/close -H 'Content-Type: application/json' -d '{"session":"alpha"}'
```

### 5.4 daemon HTTP（127.0.0.1:7789）

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/` | 健康检查 + 任务列表 + 队列长度 |
| GET | `/status` | 完整状态：current / queue / history |
| GET | `/tasks` | 任务名 + 历史 |
| POST | `/run` | `{"task":"xxx"}` 或 `{"tasks":["a","b"]}` 入队 |
| POST | `/stop` | 清队列并停当前任务 |

```bash
curl -s http://127.0.0.1:7789/
curl -s http://127.0.0.1:7789/status | head -c 500
curl -s -X POST http://127.0.0.1:7789/run -H 'Content-Type: application/json' -d '{"task":"headless-demo"}'
curl -s -X POST http://127.0.0.1:7789/stop
```

### 5.5 launchctl（macOS 服务）

```bash
launchctl list | grep desktop-agent                 # 看两个服务是否加载 + 上次退出码
launchctl kickstart -k gui/$(id -u)/com.desktop-agent.daemon     # 重启 daemon
launchctl kickstart -k gui/$(id -u)/com.desktop-agent.overlay    # 重启小窗
launchctl print gui/$(id -u)/com.desktop-agent.daemon | head -30 # 看 plist 生效内容与运行状态
```

plist 在 `~/Library/LaunchAgents/`：`com.desktop-agent.daemon.plist`、`com.desktop-agent.overlay.plist`。

### 5.6 日志与临时文件

| 路径 | 内容 |
| --- | --- |
| `logs/runs/<时间戳>-<任务>.jsonl` | runner 的任务日志（start/line/end） |
| `logs/daemon/<任务>-<时间戳>.log` | daemon 拉起的任务 stdout+stderr |
| `logs/daemon.out` | `npm run daemon` / `npm start` 的 daemon 输出 |
| `logs/launchd-daemon.out` / `.err` | launchd 版 daemon 的输出/错误 |
| `logs/launchd-overlay.out` / `.err` | launchd 版小窗的输出/错误（Electron 崩在这里） |
| `logs/daemon.pid` | daemon pid 文件 |
| `reports/` | `npm run accept` 生成的 Markdown 验收报告 |
| `/tmp/agentd-<应用>.lock` | 应用锁（同一应用串行） |
| `~/.desktop-agent/chrome-profile` | 离屏实例 profile（登录态） |
| `~/.desktop-agent/headless-profile` | headless profile（登录态） |

### 5.7 环境变量

| 变量 | 默认 | 作用 |
| --- | --- | --- |
| `OPEN_COMPUTER_USE_VISUAL_CURSOR` | — | **必须为 0**，否则屏幕上出现假光标 |
| `AGENT_SESSION` | `default` | 当前 DSH 会话用哪个小窗 |
| `OVERLAY_URL` | `http://127.0.0.1:7788` | agent 推送目标 |
| `AGENTD_PORT` | `7789` | daemon 端口 |
| `OCU_BIN` | 自动查找 | 指定 ocu 可执行文件 |
| `CHROME_BIN` / `CHROME_APP` | 系统 Chrome | 指定浏览器二进制 / 应用名 |
| `AGENT_CHROME_PROFILE` | `~/.desktop-agent/chrome-profile` | 离屏实例 profile |
| `HEADLESS_PROFILE` | `~/.desktop-agent/headless-profile` | headless demo 的 profile |
| `OVERLAY_PORT` / `OVERLAY_HOST` | `7788` / `127.0.0.1` | 小窗 HTTP 端口/监听地址（改 0.0.0.0 会暴露局域网，不建议） |
| `OVERLAY_WINDOW_ID` | — | 启动时绑定的被控窗口 ID |
| `OVERLAY_FPS` | `15`（1–30） | 缩略图帧率 |
| `OVERLAY_WIDTH` / `OVERLAY_HEIGHT` | `300` / `190` | 小窗尺寸 |
| `OVERLAY_MARGIN` | `16` | 距屏幕右上角边距 |
| `OVERLAY_IDLE_HIDE_MS` | `5000` | 空闲隐藏；0 关闭（兜底 max(15s, 3×)） |
| `OVERLAY_ATTACH_FAST_MS` | `400` | 有小窗露着时轮询宿主的间隔（切会话靠它及时隐藏） |
| `OVERLAY_ATTACH_SLOW_MS` | `1500` | 小窗全藏着时的轮询间隔（省电） |
| `OVERLAY_MAX_SESSIONS` | `12` | 最多会话窗口数 |
| `OVERLAY_SHOW_DOCK` | `0` | 设 1 保留 Dock 图标 |

---

## 6. 已知限制（诚实清单）

- **Windows 没实机验证**：代码照 Win32 写的，当前只在 macOS 上跑过。
- **锁屏时 AX/UIA 全失效**，Chrome 启动慢一个数量级。
- **Safari 网页内容**在 AX 里读不到；微信/Telegram 只有窗口壳。
- **小窗不跟随 Space**：切到别的桌面就看不到它（有意为之，避免跟着你到处飘）。
- **小窗画面会比真实操作滞后**：抓帧约 7fps，编码/缩放有几十毫秒。
- **对用户应用截图会把窗口提到前台**，所以用户应用一律不截图。
- **小窗 HTTP 无鉴权**，只监听回环地址。
- **form-fill 与 overlay 同时跑可能失败**（`cgWindowNotFound`，环境冲突，不是逻辑错误）。
- **daemon（launchd）环境缺 node 路径**：浏览器类任务建议用 `npm run run` 跑（见 4.3 第 6 条）。
- 缩略图按「小窗宽度 × 2（Retina）」出图，最长边上限 2560px；放大后目标分辨率会跟着变大（960pt 窗口对应 1920px），抓帧也更慢。

---

## 7. 自己加一个任务

任务 = `core/tasks/` 下的一个 `.mjs` 文件，**文件名就是任务名**，runner 自动发现。

```js
// core/tasks/my-task.mjs
'use strict';
import { overlay } from '../agentd.mjs';

async function main() {
  await overlay.status('开始干活');
  await overlay.log('第 1 步：读界面');
  // 原生应用：用 core/agentd.mjs 的 ocu 封装（记得不截图、走语义点击）
  // 浏览器：用 core/browser.mjs 的 launch({ headless: true }) + CDP
  const result = { ok: true };
  console.log(JSON.stringify(result));
}

main().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
```

约定：

- 退出码 0 = 成功，非 0 = 失败（runner/daemon 都按这个判定，失败会推红点到小窗）。
- 过程用 `overlay.status()` / `overlay.log()` 推给小窗，用户只看小窗就知道跑到哪。
- **成功判据要来自外部事实**，不要用「弹窗说成功了」自证（见 `flow/BOSS-GREET.md` 的 8 连误报案例）。
- 要操作用户的应用，先过 `guard()` / `withAppLock()`，别绕开护栏。
