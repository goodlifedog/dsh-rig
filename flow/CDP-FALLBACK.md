# Electron 类应用兜底方案：CDP 接入验证

> 目标：给「AX 树很薄、ocu 点不到」的 Electron/Chromium 应用一条可验证的兜底控制路径。
> 本文件所有结论都来自本机实测（macOS 26.5.1 arm64），命令和输出都贴出来了，可复现。

## 0. 一句话结论

- **CDP 对 Electron/Chromium 应用完全可用**：读到完整 DOM、执行任意 JS、触发真实点击（事件 `isTrusted=true`）、输入文本、截图。实测 overlay 与第三方 ChatGPT 都通过。
- **但只能在启动时开启**：给运行中的应用事后开调试端口做不到，必须退出后用 `--remote-debugging-port=N` 重启（A/B 实测）。
- **对原生应用无效**：macOS 版 Telegram 是 Swift/Cocoa 原生应用（不是 Electron），AX 薄是因为自绘，CDP 根本接不上；ChatGPT 是 Electron fork，能接。
- **代价**：重启第三方应用会把它的窗口带到前台（实测 `open -g` 也压不住），与「后台不打扰」冲突，需要用户知情同意。
- **落地建议**：自研 Electron 应用（overlay）用固定/随机调试端口常开；第三方应用 AX 够用就别 CDP；AX 不够用且用户接受重启才走 CDP；原生应用退回 AX 定位 + `sky_click` 坐标点击 + 读回校验。

## 1. 背景：AX 到底缺了什么

ocu 走的是 macOS Accessibility（AX）。三类目标在 AX 里的表现（本机实测）：

| 目标 | 类型 | AX 元素数 | AX 可交互控件 | AX 里能看到的内容 |
| --- | --- | --- | --- | --- |
| overlay（本项目） | Electron 41.7.1 | 17 | 2 个按钮（关闭、状态胶囊） | 窗口 chrome、HTML 内容节点、缩略图、状态文字；日志抽屉里每条日志不可见 |
| ChatGPT | Electron fork（Codex Framework 156） | 13 | 0 | 只有关闭/全屏/最小化 + 菜单栏 |
| Telegram | 原生 Swift/Cocoa | 20 | 3 个命名控件（Contacts、Add Contact、搜索框）+ 若干无名按钮 | 会话列表、消息区、消息输入框**完全不在 AX 里** |

Telegram 的 AX 原文（节选）：

~~~text
0 standard window Telegram @ good, Secondary Actions: Raise
	1 list
	2 scroll bar (disabled, settable, float) 0
	3 button Contacts
	4 button Add Contact
	5 search text field Description: Search (⌘K)
		6 button
		...
	11 close button
	12 full screen button
	13 minimize button
	14 text Telegram @ good
15 menu bar
~~~

结论：AX 缺失分两种根因——

1. **Web 内容没映射到 AX**（Electron/Chromium）：渲染进程里的 DOM 结构、文本、控件没有变成 AX 元素（或只暴露极浅一层）。这类可以用 CDP。
2. **自绘 native UI**（Telegram、微信等）：绘制在 canvas/CoreGraphics 里，本来就没有语义节点。CDP 接不上，只能 AX 定位窗口/少量控件 + 坐标点击。

## 2. 实验环境

- macOS 26.5.1 arm64
- overlay：`desktop-agent/overlay`，Electron 41.7.1，Chromium 146.0.7680.216
- Node：v20.18.0（**全局 WebSocket 为 undefined**，见第 5 节）
- ocu 1.1.3（`~/.local/bin/ocu`）

启动命令（本机有 `ELECTRON_RUN_AS_NODE=1`，必须显式去掉）：

~~~bash
cd desktop-agent/overlay
env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron . --remote-debugging-port=9333
~~~

启动日志只多一行，其余行为不变：

~~~text
DevTools listening on ws://127.0.0.1:9333/devtools/browser/9ec6cce8-...
~~~

## 3. 路径 A：受控 Electron 应用（overlay）实测

### 3.1 A/B 对照：端口只在启动参数里

同一份 overlay 代码，只差一个参数：

| 启动方式 | 9333 监听 | 结论 |
| --- | --- | --- |
| `electron .` | 无 | 不加参数就没有调试端口 |
| `electron . --remote-debugging-port=9333` | `127.0.0.1:9333` | 端口是启动参数决定的 |

### 3.2 HTTP 侧：拿 version 和 targets

~~~bash
curl -s http://127.0.0.1:9333/json/version
curl -s http://127.0.0.1:9333/json/list
~~~

实测输出：

~~~json
{
  "Browser": "Chrome/146.0.7680.216",
  "Protocol-Version": "1.3",
  "User-Agent": "... Electron/41.7.1 Safari/537.36",
  "webSocketDebuggerUrl": "ws://127.0.0.1:9333/devtools/browser/9ec6cce8-..."
}
~~~

~~~json
[{
  "id": "CC5610D3DA4C864504D17DC30010B286",
  "title": "Desktop Agent",
  "type": "page",
  "url": "file:///.../desktop-agent/overlay/index.html",
  "webSocketDebuggerUrl": "ws://127.0.0.1:9333/devtools/page/CC5610D3DA4C864504D17DC30010B286"
}]
~~~

### 3.3 WebSocket 侧：执行 JS、读 DOM 标题

~~~bash
node desktop-agent/core/cdp.mjs eval --port=9333 --expr="document.title"
~~~

~~~text
"Desktop Agent"
~~~

### 3.4 读 DOM（AX 读不到的部分）

~~~bash
node desktop-agent/core/cdp.mjs inspect --port=9333
~~~

~~~json
{
  "title": "Desktop Agent",
  "url": "file:///.../desktop-agent/overlay/index.html",
  "readyState": "complete",
  "nodes": 25,
  "interactive": 2,
  "interactiveSample": [
    { "tag": "button", "id": "close", "text": "×", "rect": { "x": 268, "y": 45, "w": 17, "h": 17 } },
    { "tag": "button", "id": "pill", "text": "待命", "rect": { "x": 18, "y": 142, "w": 264, "h": 30 } }
  ],
  "text": "× 等待目标窗口 ..."
}
~~~

对照 AX：同样这个窗口 AX 只有 17 个元素、2 个按钮，日志文本读不到；CDP 侧能读到日志抽屉里每条日志的文本（实测读到 `20:18:50 overlay 启动…`）。

### 3.5 执行 JS 并产生副作用（证明不是只读）

~~~bash
node desktop-agent/core/cdp.mjs eval --port=9333 \
  --expr="(document.documentElement.setAttribute('data-cdp-probe','ok'), document.documentElement.getAttribute('data-cdp-probe'))"
~~~

~~~text
"ok"
~~~

### 3.6 真实点击（关键验证）

点击有两种：

- `Runtime.evaluate` 里调 `el.click()`：合成事件，`isTrusted=false`，有些框架会忽略；
- `Input.dispatchMouseEvent`：走浏览器输入管线，`isTrusted=true`，和用户点一样。

实测用后者点 overlay 的状态胶囊 `#pill`（它的行为是开/关日志抽屉，状态体现在 `#logs.open`）：

~~~bash
node desktop-agent/core/cdp.mjs click --port=9333 --selector="#pill"
~~~

~~~json
{ "selector": "#pill", "tag": "button", "size": { "w": 264, "h": 30 },
  "point": { "x": 150, "y": 138, "method": "Input.dispatchMouseEvent" } }
~~~

点击前后 DOM 状态（同一页面里验证）：

~~~text
点击前:   logsClass=""      aria-hidden="true"
点击后:   logsClass="open"  aria-hidden="false"
再点一次: logsClass=""      （开→关，可逆）
~~~

并且在页面里挂的 click 监听收到 `{count:1, trusted:[true], target:"pill"}`，即事件确实经过真实输入管线。

> 坐标提示：`clickSelector` 先 `scrollIntoView` 再取 `getBoundingClientRect()`，所以坐标用的是滚动后的位置。
> overlay 这种固定尺寸窗口里，`scrollIntoView` 会让文档滚动十几像素（实测胶囊 rect.y 从 142 变成 123），
> 如果先取坐标再滚动就会点偏。这一点对其它 Electron 应用同样成立。

### 3.7 键盘输入

~~~text
Input.insertText('hello-cdp')  ->  输入框 value = "hello-cdp"
~~~

走真实输入管线，等价于输入法上屏；比直接改 `value` 更接近用户行为。

### 3.8 截图

~~~bash
node desktop-agent/core/cdp.mjs shot --port=9333 --out=/tmp/cdp-probe-shot.png
~~~

~~~json
{ "ok": true, "out": "/tmp/cdp-probe-shot.png", "bytes": 51680 }
~~~

`Page.captureScreenshot` 拿的是渲染进程的画面，**不依赖屏幕录制权限**，也不会被其它窗口遮挡——这对后台代理是个额外好处。

### 3.9 一条命令跑完验收

验收脚本：`desktop-agent/flow/cdp-probe.mjs`（前置：overlay 带 9333 启动）。

~~~bash
node desktop-agent/flow/cdp-probe.mjs 9333
~~~

实测输出（13/13 全过）：

~~~text
PASS  GET /json/version 返回 Browser  -> "Chrome/146.0.7680.216"
PASS  GET /json/list 有 page target  -> [{"title":"Desktop Agent","url":"file:///..."}]
PASS  Runtime.evaluate 返回 document.title  -> "Desktop Agent"
PASS  能读 DOM 节点数  -> {"nodes":25,"interactive":2,"readyState":"complete"}
PASS  能读到可交互元素  -> ["button#close","button#pill"]
PASS  写 DOM 属性后能读回  -> {"marker":"cdp-probe-1793881143997","readBack":"cdp-probe-1793881143997"}
PASS  Input.dispatchMouseEvent 点到 #pill  -> {"point":{"x":150,"y":138},"fired":1}
PASS  点击事件 isTrusted=true（真实输入管线）  -> [true]
PASS  点击后 DOM 状态改变（日志抽屉 open）  -> {"beforeOpen":false,"afterOpen":true}
PASS  再次点击可还原（开->关）  -> {"restoredOpen":false}
PASS  Input.insertText 输入文本  -> "hello-cdp"
PASS  Page.captureScreenshot 拿到 PNG  -> {"bytes":51680,"path":"/tmp/cdp-probe-shot.png"}
PASS  本次会话 CDP 消息数 > 10  -> 23

{ "port": 9333, "total": 13, "passed": 13, "failed": [], "verdict": "ALL PASS" }
~~~

## 4. 路径 B：第三方 Electron 应用

### 4.1 先判断它是不是 Electron 系

~~~bash
ls "/Applications/Xxx.app/Contents/Frameworks/" | grep -i electron
ls "/Applications/Xxx.app/Contents/Resources/" | grep -i asar
~~~

本机实测结果：

| 应用 | 框架 | 结论 |
| --- | --- | --- |
| ChatGPT | `Codex Framework.framework` + `app.asar`，内含 `Electron` 字样 | Electron fork，**可 CDP** |
| 抖音 / OpenCode / Antigravity / DeepSeek Harness | `Electron Framework.framework` + `app.asar` | Electron，理论上同一路径（本次未逐一重启实测，避免打扰） |
| Telegram | 无 Electron 框架，`libswift*.dylib` 一堆 | 原生 Swift，**不可 CDP** |

ChatGPT 的框架二进制里能直接查到调试相关字符串（说明它保留了 Chromium 的 DevTools 实现）：

~~~text
remote-debugging-port
remote-debugging-pipe
DevToolsActivePort
/json/version
/json/list
~~~

### 4.2 ChatGPT 实测：能接，而且信息量比 AX 大得多

启动（先完全退出，再带参数；`-g` 只是"不要主动到前台"）：

~~~bash
osascript -e 'quit app "ChatGPT"'    # 有单实例锁，必须先退出
open -g -a /Applications/ChatGPT.app --args --remote-debugging-port=9444
~~~

~~~bash
curl -s http://127.0.0.1:9444/json/version
~~~

~~~json
{
  "Browser": "Chrome/156.0.8078.79",
  "Protocol-Version": "1.3",
  "User-Agent": "Mozilla/5.0 ... Chrome/156.0.0.0 Safari/537.36",
  "webSocketDebuggerUrl": "ws://127.0.0.1:9444/devtools/browser/a7a8beec-..."
}
~~~

target 列表（4 个：2 个 page、1 个 iframe、1 个 worker）：

~~~json
[
  { "type": "page",   "title": "ChatGPT", "url": "app://-/index.html" },
  { "type": "page",   "title": "ChatGPT", "url": "app://-/detached-window.html?initialRoute=%2Fdetached-window" },
  { "type": "iframe", "title": "https://cdn.platform.openai.com/deployments/dil/v15/runner.html" },
  { "type": "worker", "title": "", "url": "" }
]
~~~

读 DOM（同一时刻对照）：

~~~bash
node desktop-agent/core/cdp.mjs inspect --port=9444 --target="index.html"
~~~

~~~json
{ "title": "ChatGPT", "url": "app://-/index.html", "readyState": "complete",
  "nodes": 819, "interactive": 64 }
~~~

可见按钮/链接文本（只读，没有点任何东西）：

~~~json
["跳转到内容","首页","图像","定时任务","资料库","插件","探索","代码审查","有可用更新","打开个人资料菜单","Codex","查看活动","搜索","新聊天","置顶"]
~~~

同一时刻 AX 侧：**13 个元素、0 个可交互控件**（只有关闭/全屏/最小化 + 菜单栏）。

> 诚实记录：DOM 节点数随加载阶段波动。首次启动等加载完成后读到 819 节点/64 个可交互元素；
> 后来一次刚启动的采样里读到 659（加载中），紧接着又读到 40（页面重载瞬间）。
> AX 侧两次都是 13 个元素、0 个可交互，这个数很稳定。结论不受影响：CDP 能看到真实 DOM，AX 看不到。

### 4.3 Telegram 实测：此路不通

~~~bash
ls /Applications/Telegram.app/Contents/Frameworks/          # 只有 Sparkle + libswift*.dylib
otool -L /Applications/Telegram.app/Contents/MacOS/Telegram  # 只链 libSystem
~~~

没有 Chromium/Electron 框架，就没有 DevTools，没有 `--remote-debugging-port` 可加。它的 AX 只有 20 个元素（见第 1 节），会话列表和消息区完全不可见。**Telegram 只能走 AX + 坐标点击，不能走 CDP。**

### 4.4 第三方应用接 CDP 的前提清单（都是实测出来的）

1. **必须是 Chromium/Electron 系**（框架目录、app.asar、二进制里的 `remote-debugging-port` 字符串可以判断）。
2. **必须完全退出后带参数启动**。运行中的应用没有任何 API 能在事后打开调试端口（A/B 对照见 3.1）。
3. **单实例锁要先处理**。实测：已有实例在跑时，再启动一个带 `--remote-debugging-port=9335` 的实例，9335 **不会**被监听——第二个实例把参数转给第一个后自己退出。
4. **重启会抢前台**。实测 `open -g` 也压不住：ChatGPT 启动后 `ocu list-apps` 第一行变成 ChatGPT（frontmost）；退出后前台变成 Chrome。这与本项目「后台不打扰」的原则冲突，需要用户明确同意，或安排在用户不在场时做。
5. **端口无鉴权**。本机任何进程都能连上来、执行任意 JS。必须只绑回环、用完就关；绝不要暴露到 0.0.0.0。
6. **更新器/自启动会丢端口**。应用自动更新或用户手动重启后，调试端口就没了，需要重新带参数启动。
7. **CDP 只覆盖渲染进程**。原生菜单栏、托盘、文件选择器、系统权限弹窗、原生窗口控件不在 CDP 里，仍然要用 AX/坐标。

### 4.5 随机端口（比固定 9333 更稳）

`--remote-debugging-port=0` 会让 Chromium 自己挑端口，并把「端口 + 浏览器 WS 路径」写到 user-data-dir 下的 `DevToolsActivePort` 文件。实测：

~~~bash
env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron . --remote-debugging-port=0
cat "$HOME/Library/Application Support/desktop-agent-overlay/DevToolsActivePort"
~~~

~~~text
54001
/devtools/browser/72f6104d-129c-41be-a15f-e698fefa25e3
~~~

用这个端口跑 cdp.mjs 一样通：

~~~bash
node desktop-agent/core/cdp.mjs eval --port=54001 --target="Desktop Agent" --expr="document.title"
# -> "Desktop Agent"
~~~

生产上建议用这种随机端口 + 用后关闭，减少端口冲突和「别的进程乱连」的窗口期。

## 5. Node 侧 WebSocket 从哪来（关键依赖问题）

任务里点名了这个问题：**Node 20 没有全局 WebSocket**。本机实测：

~~~text
$ node -v
v20.18.0
$ node -e "console.log(typeof WebSocket)"
undefined
~~~

可选方案对比（都实测过可行/不可行）：

| 方案 | 实测 | 优点 | 缺点 |
| --- | --- | --- | --- |
| A. 自己实现最小 RFC6455 帧协议（本仓库采用，见 `core/cdp.mjs`） | ✅ 已用于所有验收 | 零依赖、离线可用、行为可控 | 代码约 200 行；只支持 ws://、文本帧、无扩展/压缩 |
| B. `node --experimental-websocket` | ✅ 本机 20.18.0 实测 `typeof WebSocket === 'function'` | 不改代码，Node 自带 | 需要 flag（Node 22+ 默认可用，本机只有 20.18 未验证 22）；依赖运行参数 |
| C. `npm i ws` | 未安装（`require.resolve('ws')` 失败） | 成熟稳定 | 引入第三方依赖，与「零依赖」约定冲突 |
| D. `npx wscat` 等临时工具 | 未采用 | 不用装 | 交互式工具，不适合脚本编排；要联网拉包；多步调用难 |

本仓库选 **A**：`desktop-agent/core/cdp.mjs` 内置 `MiniWebSocket`，实现内容是
握手（`Sec-WebSocket-Key` + SHA1 校验）→ 客户端掩码帧编码 → 长度 7/16/64 位解析 →
分片续帧（continuation）→ ping/pong/close 处理 → 64MB payload 上限。

它的限制（写清楚，别当通用 ws 库用）：

- 只支持 `ws://`（本地 CDP 用不到 wss）；
- 只发文本帧，只处理文本/二进制帧的收；
- 不支持 permessage-deflate、扩展位；
- 没有自动重连（调用方自己处理）；
- 协议消息按 JSON 解析，带 `id` 的当响应配对，其余派发成事件。

## 6. core/cdp.mjs 用法

~~~js
import { CDP, getVersion, listTargets } from './cdp.mjs';

// 1) 先看有什么 target
const targets = await listTargets({ port: 9333 });

// 2) 连上（默认第一个 page，也可以按 title/url 子串或正则选）
const cdp = await CDP.attach({ port: 9333, target: 'Desktop Agent' });

await cdp.getTitle();                       // document.title
await cdp.inspectDom();                     // 节点数/可交互元素/文本
await cdp.inspectSelector('#pill');         // 某元素的状态与位置
await cdp.evaluate('1 + 1');                // 执行 JS，返回 by value
await cdp.clickSelector('#pill');           // Input.dispatchMouseEvent 真实点击
await cdp.clickSelectorSynthetic('#pill');  // el.click() 合成点击（备选）
await cdp.insertText('hello');              // 真实键盘输入
await cdp.setValue('#input', 'abc');        // 直接赋值 + input/change 事件
await cdp.screenshot('/tmp/a.png');         // 渲染进程截图（不依赖屏幕录制权限）
await cdp.send('Network.enable', {});       // 任意 CDP 命令
cdp.close();
~~~

命令行（取证用）：

~~~bash
node desktop-agent/core/cdp.mjs version  --port=9333
node desktop-agent/core/cdp.mjs targets  --port=9333
node desktop-agent/core/cdp.mjs eval     --port=9333 --expr="document.title"
node desktop-agent/core/cdp.mjs inspect  --port=9333
node desktop-agent/core/cdp.mjs click    --port=9333 --selector="#pill"
node desktop-agent/core/cdp.mjs shot     --port=9333 --out=/tmp/a.png
~~~

实现细节里有一个容易踩的坑：本客户端**不发 `Origin` 头**，所以不会触发 Chromium 的
`--remote-allow-origins` 限制（实测 Electron 146 与 Chrome 156 都可以直接连）。
如果以后换成浏览器自带的 WebSocket 客户端（会带 Origin），需要给应用补 `--remote-allow-origins=*`。
## 7. CDP vs 坐标点击（sky_click）：怎么选

对照 `flow/RECIPE.md` 里的实测：`accessibility` 元素点击最稳；`sky_click` 时灵时不灵、要先截图、
坐标是窗口内坐标、窗口一动就失效；`global` 会移动真实指针，禁用。

| 场景 | 首选 | 兜底 | 理由 |
| --- | --- | --- | --- |
| 自研 Electron（overlay） | CDP | AX | 端口可常开，零打扰；能读 DOM、真点击、截图不需要屏幕录制权限 |
| 第三方 Electron（ChatGPT/抖音/OpenCode/Antigravity） | AX（能读到的部分） | CDP（需重启 + 用户同意） | AX 只有窗口 chrome；要操作渲染内容只能 CDP，但重启会抢前台 |
| 原生应用（Telegram/微信/Steam） | AX + `sky_click` 坐标 | 无（CDP 不适用） | 自绘 UI 没有语义，CDP 也没有渲染进程可连 |
| Chrome 网页 | ocu/AX（已能用） | CDP（需重启 Chrome） | AX 已能完整读网页，没必要为它重启浏览器 |

判断顺序（建议实现成 agentd 里的一个 `chooseDriver(app)`）：

1. 目标进程的 bundle 里有 Electron/Chromium 框架？没有 → AX/坐标。
2. 已经在带调试端口的模式下运行？是 → 直接 CDP。
3. AX 树里能定位到目标控件？能 → AX（不需要重启，零打扰）。
4. 用户接受重启目标应用？能 → CDP（先完全退出，再带参数启动，随机端口，用完关端口）。
5. 都不行 → AX 定位 + `sky_click` 坐标点击 + **读回状态校验**（沿用 RECIPE 的轮询校验策略）。

两条硬建议：

- **任何兜底动作之后都必须读回校验**（CDP 用 `evaluate` 读 DOM/状态，AX 用重新 snapshot），
  不要因为「命令返回成功」就当动作生效了——RECIPE 里已经记录过点击被吞的情况。
- **CDP 用完就关**：端口只在任务期间开放，任务结束 kill 或让应用退出；不要让调试端口长期常驻。

## 8. 复现步骤（照抄可跑）

~~~bash
# 1. 启动带调试端口的 overlay
cd desktop-agent/overlay
env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron . --remote-debugging-port=9333 &

# 2. HTTP 侧确认
curl -s http://127.0.0.1:9333/json/version
curl -s http://127.0.0.1:9333/json/list

# 3. 读标题 / DOM
cd /Users/tester/Desktop/desktop-agent
node desktop-agent/core/cdp.mjs eval --port=9333 --expr="document.title"
node desktop-agent/core/cdp.mjs inspect --port=9333

# 4. 真实点击 + 读回
node desktop-agent/core/cdp.mjs eval --port=9333 \
  --expr="document.getElementById('logs').className"
node desktop-agent/core/cdp.mjs click --port=9333 --selector="#pill"
node desktop-agent/core/cdp.mjs eval --port=9333 \
  --expr="document.getElementById('logs').className"

# 5. 一条命令跑完整验收
node desktop-agent/flow/cdp-probe.mjs 9333

# 6. 清理
pkill -f "desktop-agent/overlay"
~~~

## 9. 未验证 / 待办（如实记录）

- 抖音、OpenCode、Antigravity 没有逐一重启实测（它们会抢前台、且可能需要登录态），
  只验证了它们是 Electron 系（Electron Framework + app.asar）。机制与 overlay/ChatGPT 相同，但没实证。
- 应用是否可能「过滤/忽略 `--remote-debugging-port`」：本机测的两个都正常接受；
  没有找到反例，也没有做全量验证（不同版本/不同打包方式可能不同）。
- Node 22+ 默认有全局 `WebSocket` 是公开事实，但本机只有 Node 20.18，未亲测；
  亲测的是 20.18 加 `--experimental-websocket` 可用。
- CDP 的事件订阅（`Network`/`Page.loadEventFired` 等）只验证了消息派发机制可用，
  没有做业务级用例（比如拦截网络请求）。
- 没有评估 DevTools attach 对应用性能的影响（一般很小，但没测）。
- 本次为了做 ChatGPT 实测，短暂启动并退出了 ChatGPT；实测它启动时仍会把自己切到前台
  （退出后前台变成 Chrome）。这是评估结论的一部分，也说明第三方 CDP 路线不能完全「后台无感」。

## 10. 文件

- `desktop-agent/core/cdp.mjs` —— 零依赖 CDP 客户端（HTTP 发现、RFC6455 最小实现、evaluate/click/insertText/screenshot、命令行）
- `desktop-agent/flow/cdp-probe.mjs` —— 13 项验收脚本（在带端口的 overlay 上跑）
- `desktop-agent/core/electron-task.mjs` —— 任务层封装（启动/连接/等就绪/生命周期，见第 11 节）
- `desktop-agent/core/tasks/electron-demo.mjs` —— 离屏 Electron 实例 + CDP 的自证任务（10 项检查）
- `desktop-agent/flow/CDP-FALLBACK.md` —— 本文件
## 11. 如何在任务里用（任务层 API）

底层 `core/cdp.mjs` 之上包了一层 `desktop-agent/core/electron-task.mjs`：
任务里不用再自己轮询端口、等 target、判空，直接调用就行（风格与 `core/agentd.mjs` 一致：导出函数 + 中文注释 + 明确错误）。

三行版（复制即用）：

~~~js
import { launch } from '../core/electron-task.mjs';
const host = await launch({ entry: '/tmp/host.js' });          // 随机调试端口 + 独立 user-data-dir
const page = await host.connect({ target: 'Demo' });           // 等页面就绪并连上 CDP
console.log(await page.title()); await page.click('#btn');     // 读 title + Input 真实点击
~~~

用完记得 `await page.close(); await host.close();`。

### 11.1 API 一览

| 导出 | 作用 |
| --- | --- |
| `launch({ entry, binary?, port=0, userDataDir?, args?, env?, timeoutMs? })` | 启动带调试端口的 Electron；返回 host（port/pid/userDataDir/connect/close） |
| `attach({ port, target?, timeoutMs? })` | 连已在跑的第三方 Electron 应用（你自己带端口重启的那个） |
| `writeOffscreenHost({ htmlPath, dir?, width?, height? })` | 生成「离屏透明宿主」的 host.js，返回 { dir, hostPath } |
| `offscreenHostSource({ htmlPath, width?, height? })` | 只生成宿主脚本源码（不落盘） |
| `waitForDevToolsPort(userDataDir)` / `readDevToolsActivePort(userDataDir)` | 读 DevToolsActivePort 里的真实端口 |
| `waitForTarget(port, { target })` | 等页面出现并返回底层 CDP 会话 |
| `frontmostApp()` | 读当前前台应用名（用于证明没抢焦点） |
| `resolveElectronBinary()` | 找 Electron 可执行文件（ELECTRON_BIN > overlay 自带） |

page（会话）方法：`title() / url() / evaluate(expr) / inspect() / inspectSelector(sel) / waitFor(expr) /
click(sel) / insertText(text) / setValue(sel, value) / screenshot(path) / send(method, params) / close()`。
`click` 会先确认元素存在且可见，找不到时直接报「页面上找不到元素：…（当前页面 …）」。

### 11.2 宿主窗口：为什么不会抢前台

`writeOffscreenHost` 生成的宿主脚本做了四件事（和 `core/tasks/form-fill-local.mjs` 同一套做法）：
accessory（`app.setActivationPolicy('accessory')` + `app.dock.hide()`）、`opacity: 0`、屏幕外坐标 `x/y = -5000`、`showInactive()`。
窗口正常渲染、能收 CDP 的点击和输入，但用户看不到也拿不到焦点。

实测（`electron-demo.mjs`，见 11.3）：运行前、运行中、结束后 `frontmostApp()` 都是 `DeepSeek Harness`，宿主 Electron 从未成为前台。

### 11.3 自证任务

~~~bash
node desktop-agent/core/tasks/electron-demo.mjs
~~~

它会临时写一个页面 + 离屏宿主，带 `--remote-debugging-port=0` 启动，读 `DevToolsActivePort` 拿端口，然后验证：

~~~text
[1] 初始前台: DeepSeek Harness
[2] 离屏宿主脚本: /tmp/electron-demo-xxx/host.js
[3] 启动 Electron（随机调试端口 + 独立 user-data-dir）…
    调试端口: 62144 pid: 18770
    已连上 target: {"title":"CDP Task Demo","url":"file:///.../demo.html"}
PASS  读到 document.title  -> "CDP Task Demo"
PASS  能读 DOM  -> {"nodes":16,"interactive":2,"readyState":"complete"}
PASS  点击 #btn 后计数 0→1  -> {"count":"1","point":{"x":53,"y":95}}
PASS  再点一次计数 1→2  -> "2"
PASS  点击事件 isTrusted=true  -> [true,true]
PASS  DOM 文本随点击变化  -> "点击次数：2（isTrusted=true）"
PASS  输入框写入并读回  -> "CDP-DEMO-9527"
PASS  页面截图成功  -> {"bytes":24335,"path":".../page.png"}
[4] 运行中前台: DeepSeek Harness
PASS  运行中前台不是 Electron 宿主  -> "DeepSeek Harness"
[5] 已关闭 Electron: {"pid":18770,...}
PASS  结束后前台不是 Electron 宿主  -> "DeepSeek Harness"

{ "verdict": "ALL PASS", "passed": 10, "total": 10,
  "frontmost": { "before": "DeepSeek Harness", "during": "DeepSeek Harness", "after": "DeepSeek Harness" },
  "port": 62144, "cdpMessages": 21 }
~~~

退出码 0。跑完临时目录已删除，没有残留进程。

### 11.4 接第三方已在运行的应用

~~~bash
# 先让应用带端口重启（会抢一次前台，需要用户同意）
osascript -e 'quit app "ChatGPT"'
open -g -a /Applications/ChatGPT.app --args --remote-debugging-port=9444
~~~

~~~js
import { attach } from '../core/electron-task.mjs';
const page = await attach({ port: 9444, target: 'ChatGPT' });
console.log(await page.inspect());
await page.close();
~~~

注意：这里只连、不负责启停应用；第三方应用的重启影响（抢前台、单实例锁、更新器）见第 4 节。

### 11.5 几个实现细节

- `launch` 会从子进程环境里删掉 `ELECTRON_RUN_AS_NODE`（本机全局有，不删 Electron 会以 node 模式起不来）。
- `port: 0` 时从 `user-data-dir/DevToolsActivePort` 读端口；固定端口则轮询 `/json/version` 等就绪。
- 启动前会删掉残留的 `DevToolsActivePort`，避免读到上一次的旧端口。
- `close()` 先 SIGTERM，5 秒不退再 SIGKILL，并删除自己创建的临时 user-data-dir；
  想留现场排查可传 `close({ keepUserData: true })`。
- 启动失败的错误信息里带二进制路径、入口、user-data-dir 和 stderr/stdout 尾巴，不用再猜。
