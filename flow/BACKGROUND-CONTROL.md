# 后台控制：能力边界与「不切屏」的做法

> 2026-11-06 实测。目标：控制任何应用，但用户屏幕、前台、鼠标都不受影响。

## API 一览（core/background.mjs）

| 函数 | 作用 |
| --- | --- |
| frontName() | 当前前台应用名（System Events，约 120ms） |
| isAppRunning({bundleId, appName, processName}) | 应用是否在运行（优先英文可执行名 pgrep -x） |
| ensureAppRunning({...}) | 后台启动：已在跑就直接返回，没跑才 `open -g -j`（连窗口都不显示；旧行为设 `AGENT_LAUNCH_HIDDEN=0`） |
| launchFlags({env}) | 返回后台启动参数：默认 `['-g','-j']`，`AGENT_LAUNCH_HIDDEN=0` 时 `['-g']`（纯函数） |
| ensureAppWindow(app, {timeoutMs}) | 组合动作：确保应用在跑（`ensureAppRunning`）并等到它有可用窗口（`waitForWindow`），返回窗口信息；任务不再各自拼这两步 |
| state(app) | 读界面树文本（裸读，某些应用会被顶前台，探索性场景用 readSafe） |
| find(app, {role, text, limit}) | 按角色/文字查元素（同上，探索性场景用 findSafe） |
| click(app, elementIndex) | AX 语义点击 |
| setValue(app, elementIndex, value) | 给可设置控件设值 |
| typeText(app, text) | 后台键入（sky_key） |
| smartType(app, {elementIndex, text, order}) | 输入降级链：按顺序尝试 + 读回校验 |
| smartTypeWithCache(app, {...}) | 同上，但按能力缓存决定顺序，并把结果写回 |
| clickByText(app, text) | 按文字找再点，索引过期会重查 |
| clickMenuItem(app, {menu, item}) | 两步点菜单（先展开菜单栏），当前工具链下不可用 |
| windowControls(app) | 找关闭/最小化/缩放按钮 |
| secondaryAction(app, index, action) | 触发元素自带次要动作（删除/置顶/显示简介） |
| scrollElement(app, {...}) | 滚动列表或文档 |
| selectTextIn(app, {...}) | 选中文本或放置光标 |
| readSafe(app, {...}) | 带前台保护的读取（被抢就还原并标记）；默认查前台风险名单，命中直接跳过不读（`risk:false` 关闭） |
| findSafe(app, query, {...}) | 带前台保护的元素查询（同样受前台风险名单保护） |
| frontRiskGate() | 默认前台风险门控：名单里的应用「一读就自己跳前台」，已被记录证据，读取时直接跳过（`AGENT_FRONT_RISK=off` 关闭） |
| resetFrontRiskGate() | 丢掉缓存的名单（改了环境变量/名单文件后重新读；测试用） |
| withRetry(fn, {...}) | 只对瞬时错误重试 |
| isTransientAxError(message) | 判定是否瞬时错误（索引过期/超时等） |
| capabilityFile() | 能力缓存文件路径（~/.desktop-agent/capabilities.json） |
| toolFailureText(result) | 从工具返回正文里识别「isError=false 但实际失败」（如索引过期） |
| settleFront(expect, {...}) | 延迟复查前台：兜住「操作完才异步激活」的应用，发现被抢就还原 |
| windowCount(app, {...}) | 用 System Events 读窗口数（首启弹窗卡 Apple 事件时仍可用）；-1 表示查不到 |
| waitForWindow(app, {...}) | 轮询等窗口真的建出来（Electron 应用启动后要几百毫秒到十几秒） |
| parseDialogDump(text) | 把弹窗结构文本解析成 {index,title,texts,buttons} 列表（纯函数） |
| dialogs(app, {...}) | 列出 app-modal 弹窗（首启欢迎页/更新说明） |
| pickOnboardingButton(buttons, {...}) | 从按钮里挑一个能安全点掉的（白名单之外一律返回 null，纯函数） |
| dismissOnboarding(app, {...}) | 只点白名单按钮关掉首启欢迎弹窗，点完复查前台 |
| quitApp({appName, bundleId, processName}) | 收尾：先优雅退出，退不掉再按进程 TERM |

## 并发模型：AI 干活 ≠ 用户不能用电脑

后台控制的目标是**两边同时进行、互不影响**：AI 在那边拉应用、读树、点按钮，你这边鼠标键盘照常用。

做到这一点的几个硬约束（代码里都是默认行为）：

1. **启动不激活**：一律 `open -g -j`，不激活应用、不显示窗口（`launchFlags()`）
2. **操作不靠前台**：点击/设值走 AX 语义动作，不需要应用在前台；只有少数只吃键盘的应用才需要键入
3. **不合成系统事件**：不注入鼠标/键盘事件到系统层，不会打断你的输入
4. **被抢立刻还原**：个别应用读取后自己激活，`settleFront()`/`guard()` 会还原；用户自己切走时不再抢回来
5. **同一应用串行**：`withAppLock()` 保证两个任务不同时控制同一个应用，不会互相踩
6. **你正在操作时写类任务让路**：备忘录写入、冷启动退出应用、BOSS 投递、表单改写这类会动你内容/窗口的任务，键鼠 5 秒内动过就直接环境跳过
7. **单次探测/验证的输出不弹窗**：验收有门禁（键鼠空闲 + 中途一碰就停），日常后台任务默认隐藏窗口

想现场验证：`npm run demo:concurrent`（同时跑原生计算器 + headless 浏览器两族工作负载）（它跑的时候你照常动鼠标、打字即可，前台采样用 lsappinfo 每 ~80ms 一次，能抓到"闪一下"级别的抢占）。判定是「前台采样一次都没变 + 屏幕上没冒出新窗口」，
并且会检查这期间你的键鼠有没有动过——动了就是并发的直接证据。

## 前台风险名单（默认生效）

有些应用被 AX 读取后会自己 activate（Ghostty / ChatGPT / QQ / Gemini / Telegram / WPS 实测），
虽然 `settleFront` 会立刻还原，用户仍会看到一次闪动。所以：

- 读到抢前台就记进 `~/.desktop-agent/front-risk.json`（`core/front-risk.mjs`，600 权限、默认 30 天过期）
- `readSafe` / `findSafe` **默认**查名单，命中直接返回 `skipped:'front-risk'`，一次 AX 都不发
- 矩阵/通道协商因此不再把这些应用闪一遍；报告里标「该应用读取会抢前台，已跳过」
- `npm run front:risk` 看名单，`--clear "应用名"` 重测，`--clear-all` 全清，`--seed` 从历史矩阵报告补种
- 临时强制全测：`AGENT_FRONT_RISK=off`

## 一、能力边界在哪

控制能力来自 ocu，和 Codex 同源，所以**广度是一样的**：只要应用遵循无障碍规范，macOS 用 Accessibility、Windows 用 UI Automation 都能读和点。

我们目前的边界不在引擎，而在**我们自己刻意没启用的三种后台能力**：

| 能力 | 作用 | 我们之前为什么没用 |
| --- | --- | --- |
| `sky_click` | 窗口被遮挡、在别的 Space 也能点，不抬窗口、不动指针 | 担心私有 SPI 不稳定 |
| `sky_key` | 同上，后台键入，组合键走目标应用菜单栏 | 同上 |
| `agent_display` | 把窗口挂到一块用户看不见的虚拟显示器 | 会新增系统显示器，属敏感操作 |

结果就是：遇到「窗口被遮住」「窗口在别的 Space」「要点空白区域」时，我们只能把窗口拿到前台——这就是 Chrome 那种“强制切屏”观感的来源。

## 二、真正做不到的

| 场景 | 原因 |
| --- | --- |
| 锁屏状态 | AX/UIA 整体失效 |
| SSH / 服务上下文 | 必须有登录的桌面会话 |
| 自绘窗口内部（Electron/UWP/微信） | 只暴露一层壳 |
| 需要管理员权限的应用 | UIPI / TCC 拦截 |
| 过验证码 | 系统层注入会被识别为自动化 |

## 三、Chrome 强制切屏：根因与解法

**根因**：Chrome 的窗口必须在可见的 Space 里，AX 动作和坐标点击才有意义。我们用负坐标把窗口推出去，Chrome 会自己拉回来；某些操作（打开新标签、导航）还会主动激活窗口。

**解法（已实测通过）：`agent_display` + `sky_key` / `sky_click`**

```bash
OPEN_COMPUTER_USE_VIRTUAL_DISPLAY_ENABLED=true ocu js --file script.mjs
```

```js
var app = await cua.getApp('TextEdit', { initialState: false });
await app.getAXState({ windowPlacement: 'agent_display' });   // 挂到看不见的显示器
await app.typeText('BG-TEST-9137', { keyMethod: 'sky_key' }); // 后台键入
await app.getAXState({ windowPlacement: 'restore' });         // 还回去
```

实测结果：

```
操作前前台 = DeepSeek Harness
挂虚拟显示后树行数 = 56（窗口仍完整可读）
键入后控件 Value = BG-TEST-9137（真的写进去了）
操作后前台 = DeepSeek Harness（全程没变）
显示器数量 = 1（restore 后虚拟屏已移除）
```

## 四、用在 Chrome 上的方案

1. 自动化浏览器启动后，先 `agent_display` 挂起（用户屏幕上完全看不到它）
2. 操作用 `sky_click` / `sky_key`，或直接走 CDP（CDP 本身不抢焦点）
3. 结束、异常、会话关闭时都要 `restore`，避免窗口留在看不见的地方
4. 环境变量 `OPEN_COMPUTER_USE_VIRTUAL_DISPLAY_ENABLED=true` 必须由用户显式开启

## 四点五、一条实测出来的硬规矩：不要对用户的 App 截图

2026-11-06 实测：对后台运行的 Chrome 调用 `get_app_state(include_screenshot=true)` 之后，**Chrome 被置到了前台**（前台从 DeepSeek Harness 变成 Google Chrome）。
全程没有任何 activate/切换窗口/点击调用，只有截图。

结论与规矩：

- **截图只允许用于我们自己的 headless / 离屏实例**（它们本来就没有可见窗口，置前也无感）
- 操作用户正在用的应用时，一律 `include_screenshot=false`，只读 AX 树 + 语义点击
- 需要坐标时用 `query` 返回的 bounds（不需要截图）
- 兜底护栏：截图/点击前后比对前台应用，变了立即中止

## 四点六、应用能力矩阵（2026-11-07 实测）

按门类批量跑：`MATRIX_PRESET=office|im|dev|system|media|tools npm run matrix`（清单在 `core/app-presets.mjs`），
探测完默认只关掉本轮自己拉起的应用。

```bash
npm run bg:verify    # 一次跑完后端控制全部验收，输出 reports/bg-verify-*.md
npm run matrix       # 逐个应用探明：能否后台启动/读界面/点击/设值/回显
npm run stability    # 连续多轮后台操作，统计前台被抢次数与单轮耗时
npm run cold:launch  # 退掉应用再后台拉起，验证启动不跳前台
npm run user:active  # 你在用 A 时，后台控 B，A 的界面与前台都不受影响
```

实测 7 个不同门类的应用，结果写 `reports/app-matrix-*.md`：

| 应用 | 后台启动 | 读界面 | 可点元素 | 画面回显 | 前台未变 |
| --- | --- | --- | --- | --- | --- |
| 备忘录 | 冷启动成功 | ✅ 56 节点 | 11 按钮 / 1 文本区 | offscreen（在别的桌面） | ✅ |
| 文本编辑 | 冷启动成功 | ✅ 57 节点 | 7 按钮 / 1 文本区 | live | ✅ |
| 计算器 | 冷启动成功 | ✅ 37 节点 | 25 按钮 | live | ✅ |
| 访达 | 冷启动成功 | ✅ 108 节点 | 14 按钮 / 10 输入框 | live | ✅ |
| 系统设置 | 冷启动成功 | ✅ 64 节点 | 11 按钮 / 1 输入框 | live | ✅ |
| Clash Verge | 已在运行 | ✅ 12 节点 | 3 按钮 | offscreen | ✅ |
| Telegram | 已在运行 | ✅ 26 节点 | 0（自绘窗口，只露壳） | live | ✅ |

三条结论：

1. **读 + 点 + 设值在后台都成立**：全程只用 `include_screenshot=false` 的 AX 通路，7 个应用前台一个都没被抢。
2. **冷启动不跳前台、也不闪窗口**：`open -g -j -a <应用>` 起应用，不激活且窗口不显示；
   实测 FastZip / iRightMouse 加 `-j` 后窗口仍建出来、AX 树照样可读写、画面能抓，前台全程是 DeepSeek Harness。
3. **回显受限于桌面**：窗口在当前桌面 → live；在别的桌面且系统没渲染 → 纯色帧，标记 `offscreen`
   （仍可后台操作，只是画面抓不到）。

稳定性实测：12 轮连续操作（读两个应用 + 点计算器），0 次前台被抢、0 次失败，单轮约 900ms。

### 浏览器这一类：为什么必须走独立实例

2026-11-07 实测，Chrome 两条启动路径都会抢前台：

| 方式 | 结果 |
| --- | --- |
| 直接执行 `Google Chrome --user-data-dir=...` | 前台变成 Google Chrome |
| `open -g -n -a "Google Chrome" --args ...` | 仍然变成 Google Chrome（Chrome 自己会 activate） |

结论：**要让浏览器在后台干活且不跳前台，只能起独立实例**：

- headless 实例：屏幕上零窗口，CDP 驱动，帧推给小窗回显
- 实测 `npm run browser:bg`：启动 2.1s、打开页面 1.6s、拟人点击链接 1.5s 完成跳转
  （example.com → iana.org），全程前台稳在 DeepSeek Harness

所以「所有软件都能后台控制」的落地方式分两类：

1. **原生应用**（备忘录/文本编辑/计算器/访达/系统设置…）：直接控制用户那个应用，
   走 AX 语义通路，不抢前台（矩阵已验证）
2. **浏览器**：用独立实例（headless 或独立 profile），不碰用户正在用的窗口

### 驱动其他 agent 工具（2026-11-07 实测）

「用后台控制去操作别的 agent」是这个系统的重要一环，两条路都验证过：

**桌面 agent 应用**（`npm run agent:drive`）：

- 绑定窗口镜像 → AX 找到输入区 → 设值写入提示词 → 点发送按钮
- 实测 ChatGPT 应用：切换模式、写入、发送都成功（界面里确实出现"你说：只回复两个字：收到"），
  但它自己回了 "This model isn't available" —— 是应用侧模型/账号限制，不是控制失败
- 关键点：这类 Electron 应用**回车不提交**，必须找到「发送」按钮点它

**agent CLI**（`npm run agent:cli`）：

- 后台往终端敲命令（不激活窗口），输出重定向到文件再读回（终端 AX 文本会被截断，读文件更稳）
- 实测 opencode：`opencode run "只回复两个字：收到"` → agent 回复「收到」；
  `opencode run "只输出数字42"` → 回复「42」；`opencode run "只输出OK"` → 回复「OK」
- 每次耗时 5–98 秒不等，全程前台稳定在 DeepSeek Harness

这意味着任何 CLI 形态的 agent（opencode / codex / claude …）都可以被后台驱动：
敲命令 → 等它干完 → 读结果，不需要用户切换窗口。

### 次要动作 / 滚动 / 选中文本（2026-11-07）

工具链还暴露了三类没封装的 AX 能力，补齐后覆盖面更完整：

- `secondaryAction(app, index, action)`：调用元素自带的次要动作，例如备忘录笔记行的
  「置顶 / 删除」、访达项的「显示简介」——这类既不在菜单里也不是普通按钮
- `scrollElement(app, {direction, pages, elementIndex})`：滚动列表/文档，不移动系统指针
- `selectTextIn(app, {elementIndex, text, prefix, suffix, selection})`：选中文本或放光标

三个都带前台保护（调用前后比对，被抢就还原）。6 项单测覆盖参数透传与失败分支。

另外矩阵加了「中途锁屏」处理：跑到一半锁屏时，剩余应用标 SKIP 而不是输出
「全部不可读」的错误结论。

### 应用能力缓存（2026-11-07）

同一个应用每次都试错很浪费：计算器吃键盘、备忘录吃设值、文本编辑会忽略后台键入。
所以把「哪个应用吃哪种输入」记下来：

- `core/capabilities.mjs`：`methodOrder()` 读顺序、`recordMethod()` 成功提前/失败押后、读写 JSON
- `smartTypeWithCache()`：按缓存顺序尝试，把本次成功的方式写回 `~/.desktop-agent/capabilities.json`
- 没记录过的应用走默认顺序，不影响首次使用

7 项单测覆盖：未记录返回空、成功提前、失败押后、去重、点击与输入分开记、文件读写、坏文件不崩；
另外 2 项覆盖 order 覆盖顺序与缓存写回。

### 终端类：后台可控制（2026-11-07 实测）

`npm run terminal:bg` 在 Ghostty 里敲 `echo dsh-bg-xxx` + 回车，5 项检查全过：

| 检查 | 结果 |
| --- | --- |
| 读到终端文本区 | ✅ 1 个 |
| 后台键入命令 | ✅ 前台未变 |
| 后台回车执行 | ✅ 前台未变 |
| 终端输出里能看到命令与结果 | ✅ |
| 全程前台未变 | ✅ DSH → DSH |

说明终端类应用走"键入 + 功能键"这条路是通的（文档类应用会忽略非前台输入，终端不会）。
注意：这会在你的终端里留一行输出，属于可接受的副作用。

### 读取也可能抢前台（2026-11-07 实测）

矩阵扩到终端（Ghostty）和 Electron 聊天（ChatGPT）时发现：**读这两个应用的界面树会把它顶到前台**
（前台从 DSH 变成 ghostty / ChatGPT）。这和之前"截图会把 Chrome 抬起来"是同一类问题，
只是这次连 `include_screenshot=false` 也发生了。

对策：`readSafe()` / `findSafe()` —— 读之前记前台，读之后比对，变了立刻还原，
并把「这次读取抢了前台」作为结果返回。所有探索性读取都应走这两个函数。

实测修正后：Ghostty 17 节点 / 1 文本区，ChatGPT 132 节点 / 44 按钮 / 1 文本区，
两者读取后前台都稳定在 DeepSeek Harness。5 项单测覆盖「抢了就还原 / 没抢不动作 /
抛错也检查 / 可关闭还原 / 查询同样保护」。

### 瞬时错误重试（2026-11-07）

实机最常见的失败不是"做不到"，而是"刚刚好过期"：元素索引有 120 秒有效期，
两次调用之间可能失效；AX 偶尔也会短暂超时。现在统一成三层：

- `isTransientAxError()`：识别 expired / no longer available / timeout / 索引失效 这类瞬时错误
- `withRetry()`：只对瞬时错误重试（默认 1 次），断言类失败立即返回，不浪费时间
- `clickByText()`：按文字找元素再点，索引过期会重新查询一次（完全匹配优先）

9 项单测覆盖：瞬时重试成功、非瞬时不重试、抛错也重试、次数用完返回最后失败、
文案判定、索引过期重查、完全匹配优先、找不到不乱点、非瞬时失败不重试。

### 菜单命令与窗口按钮（2026-11-07）

很多应用的关键动作不在正文区，而在菜单栏（保存、新建、切换标签）或窗口按钮（关闭、最小化）。

- `clickMenuItem(app, {menu, item})`：**两步**——先点开菜单栏项，再点菜单项
- `windowControls(app)`：识别关闭/最小化/缩放类按钮

**快捷键替代方案也不行（2026-11-07 实测）**：想用 ⌘N 这类快捷键绕过"菜单点不到"，
结果 `press_key(key='cmd+n', key_method='sky_key')` 虽然执行成功，但**备忘录被顶到前台**
（前台从 DSH 变成 Notes），并新建了空笔记。结论：带修饰键的快捷键会触发应用激活，
不能当作后台菜单替代方案。

**另一个坑**：试图用 AppleScript（`tell application "Notes" to delete ...`）清理测试笔记时，
系统弹出「自动化」权限请求并把「系统设置」窗口带到屏幕上——**这本身就打扰了用户**。
所以第三方应用的 AppleScript 自动化不能用在后台流程里，只能走 System Events 的 AX 通路。

**实测限制（2026-11-07）**：备忘录实测 `AXMenuBarItem` / `AXMenuItem` / `AXMenuBar` 查询结果全为 0，
按文字查「文件」只返回文件夹按钮。界面树文本里能看到「菜单栏 → 文件 → 编辑 …」，
但这些节点不进入可查询集合。结论：**当前工具链下，后台点菜单栏命令走不通**，
`clickMenuItem` 保留给那些确实暴露菜单项的应用（部分 Electron 应用会暴露），
但不要把它当成通用能力。矩阵里「菜单项」列恒为 0 也印证了这一点。
真正需要菜单动作时，替代方案是走该应用暴露的按钮/快捷键，或者干脆用独立实例（浏览器类）。

矩阵报告也加了「菜单项」「窗口按钮」两列，方便看清每个应用暴露了多少可操作面。
6 项单测覆盖：完全匹配优先、包含匹配兜底、找不到不乱点、查询抛错不崩、缺参返回失败、中英文按钮识别。

### 输入方式的自动降级链（2026-11-07）

不同应用接受的输入方式不一样，靠猜容易"接口说成功、内容其实没进去"。`smartType()` 的做法：

1. **AX 设值**（`set_value`）：不依赖键盘焦点，最不打扰用户 —— 先用它
2. **后台键入**（`sky_key`）：计算器这类按键式应用吃这条
3. 每一步之后都**读回界面树校验内容是否真的出现**；没出现就换下一种，全都失败就如实报失败

一个关键区分（2026-11-07 自审时补上）：**「内容没写进去」和「读不出来」要分开处理**。
读不出来时如果继续降级再输入一遍，很可能造成重复内容（设值其实已经成功）。所以：

- 读回正常但内容不存在 → 换下一种方式
- 读回本身失败 → 停在当前方式，按成功处理，返回 `verified: null` 并注明原因
- `verify:false` 时同样返回 `verified: null`，不谎称校验通过

单测覆盖 6 种情况：设值成功即返回、设值失败降级、接口都报成功但读回找不到（判失败）、
没有元素索引时直接键入、设值未校验通过再试键入、每次尝试都记录前台是否被抢。

实测例子：计算器只吃键盘不走 AX 设值；备忘录/文本编辑用 AX 设值一步到位。同一个函数两种都能处理。

### 冷启动验收：`npm run cold:launch`（2026-11-07）

把应用彻底退掉，再用后台方式拉起，逐步检查前台：

| 应用 | 退出 | 退出后前台 | 冷启动 | 启动后前台 |
| --- | --- | --- | --- | --- |
| 计算器 | 成功 | DeepSeek Harness | 成功 | DeepSeek Harness |
| 系统设置 | 成功 | DeepSeek Harness | 成功 | DeepSeek Harness |
| 备忘录 | 成功 | DeepSeek Harness | 成功 | DeepSeek Harness |

三步（退出、启动、就绪）前台都没有变化。注意：`open -g -b <bundle id>` 在这台机器上
不一定能拉起应用（bundle 解析失败），可靠写法是 `open -g -a <本地化应用名>`；
判断"是否在运行"用英文可执行名（`pgrep -x Calculator`）最稳，中文应用名对 AppleScript 可用但 shell 里不可靠。

锁屏时矩阵/冷启动会被系统挡住（AX 整体失效），`npm run matrix` 会直接报"环境跳过"，
不会给出"全不可读"的假结论。

### 前台看门狗（2026-11-07）

任务运行时后台轮询前台（System Events，约 120ms/次），一旦发现被抢就还原到用户原来的应用：

- 同一应用被反复切走 3 次以上 → 认定是用户自己想切，停止争抢（避免和用户打架）
- 历史记录带 `frontSteals`，健康面板有「前台保护」一行
- `FRONT_GUARD=0` 可关闭

**验证状态**：逻辑由 5 项单测覆盖（单次抢占还原 / 反复切换认账 / 还原失败不崩 / 停止后不再轮询）。
真实抢占目前在测试机上无法稳定复现——DSH 处于全屏时其他应用顶不上来（`open -a` 不生效），
所以只能等实际遇到抢占时再看 `frontSteals` 是否记录。

### 弹窗守卫：自家软件的崩溃/更新弹窗别挡路（2026-11-08）

`core/dialog-guard.mjs` 扫我们自己的进程（默认只有 overlay 的 Electron 和 Desktop Agent，**不碰用户的 Chrome**），
把崩溃报告/更新提示这类弹窗点掉「确定/好/关闭/稍后」；**权限类弹窗（辅助功能/屏幕录制/自动化/登录项）绝不代点**，
只打印提醒让用户自己处理——代点授权违反本项目的安全约定。

```bash
node core/dialog-guard.mjs --dry-run   # 演练：只看不点
node core/dialog-guard.mjs             # 扫一轮
node core/dialog-guard.mjs --watch     # 常驻，每 5 秒一次
```

数据源走项目自己的 AX 层（`dialogs()` + System Events 点按钮），不用 ocu CLI——
ocu 没有 dialogs 工具，走它只会静默失效。

### 窗口就绪、首启弹窗、收尾（2026-11-07 实测）

这三个坑都不是「引擎不行」，而是时序和弹窗：

**窗口还没建好就采集**。Electron 应用 `open -g` 之后进程先起来，窗口晚几百毫秒到十几秒。
Steam 实测 677ms 就绪（等之前判「没有窗口」），抖音/Antigravity 等到 40s 也没窗口——它们随后自行退出，
是应用侧行为。对策 `waitForWindow()`：轮询 System Events 的窗口数（`windowCount()`），
不用 AX 全树，快且不怕弹窗卡住。

**首启欢迎弹窗卡住 Apple 事件**。Pages Creator Studio 首启弹窗期间，
`tell application "Pages" to count documents` 直接超时（-1712），退出也被卡住；
但 System Events 仍能正常读窗口结构。对策：`dialogs()` 读弹窗文案，`dismissOnboarding()`
只点白名单按钮（继续/下一步/开始使用/知道了/OK…），看到「存储/删除/取消」一律不点，
挑不到安全按钮就返回 `dismissed:false`，宁可不点也不乱点。

**收尾**。探测完不关会留一堆窗口在桌面上。`quitApp()` 先走 Apple 事件优雅退出；
退不掉时先查有没有「保存/删除」类弹窗，有就返回 `needs-confirm` 且**不强杀**（避免丢未保存内容），
没有才按进程 TERM。返回 `quit/term/already-stopped/needs-confirm/still-running`。
矩阵默认只关本轮 `launched` 的应用——用户本来就在跑的（如 Clash）绝不动。

10 项单测覆盖：窗口迟到、一直没窗口、-1 不当成功、弹窗结构解析（含坏行）、
白名单挑按钮（破坏性按钮一个都不挑）、没安全按钮时不点、点完复查前台。

## 五、风险与注意

- 虚拟显示器会短暂改变系统显示排列，restore 后恢复；**必须在同一会话内配对调用**
- 窗口在 restore 前会从用户桌面消失，需要明确告知
- `sky_click`/`sky_key` 是私有 SPI，macOS 升级后可能失效，需重新验证
- 我们的小窗抓图依赖窗口可见性；挂到虚拟显示器时要改用外部推帧（CDP 截图）