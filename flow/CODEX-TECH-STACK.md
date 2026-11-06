# Codex 风格的电脑后台控制：技术栈拆解

> 依据：open-computer-use（MIT）是对 Codex Computer Use 的开源复刻，本文事实来自其 1.1.3 版的安装包与随包文档（`skills/open-computer-use/references/usage.md`、`installation.md`）。
> 结论只覆盖该文档明确写出的内容，未写到的部分本文标注为「未说明」。

## 一、全景：一条控制链的四段

```
读界面 → 选目标 → 投递动作 → 确认结果（+ 给人看画面）
  AX 树     索引      四种方法      快照/读回      软件光标
```

关键设计取舍：**全部建立在「系统语义层」而不是「像素层」**。它不截图找按钮，而是问系统「这个窗口里有哪些控件、叫什么、能不能按」。

好处是窗口移动、缩放、被遮挡都不影响定位；代价是要拿系统权限，而且不同应用暴露的树质量差异很大。

## 二、读界面：Accessibility 树

macOS 上读的是 AXUIElement 树，每个节点有角色（按钮/文本栏/列表）、名称、值、坐标。

几个工程细节值得学：

1. **查询索引有生命周期**：一次查询的结果在同一原生会话内最多保留 120 秒、最多 5000 个句柄。超过就失效，必须重新查。
2. **动作前重新校验**：每次点击都会重新验证「进程还在、窗口还在、控件还在、几何没变」。这解决的是「查到和点到之间界面变了」的经典竞态。
3. **树是裁剪过的**：默认渲染 1200 个节点、64 层，超出的截断。否则一个大应用的树能把上下文撑爆。

这两条直接对应我们踩过的坑：BOSS 那个弹窗就是「索引失效了但脚本还在用旧索引点」，结果点是点中了，但点在遮罩上，什么也没发生。

## 三、点击：四条路径，按需选择

这是整套技术里最有含金量的部分。

| 方法 | 底层机制 | 平台 | 什么时候用 |
| --- | --- | --- | --- |
| `accessibility` | 调用控件的 AX 语义动作（AXPress 等） | mac / win | 默认首选，最稳 |
| `app_post` | `CGEventPostToPid`，把鼠标事件直接投给目标进程 | mac / win | 目标区域没有控件、或点击被重定向到子元素时 |
| `sky_click` | **私有 SkyLight 框架**：在目标窗口内合成「成为 key window + 点击」，不抬窗口、不动指针、不切 Space | 仅 mac | 窗口被别的窗口盖住、或目标在另一个 Space |
| `global` | 真实系统指针 | mac / win / linux | 兜底，且需要显式开 `OPEN_COMPUTER_USE_ALLOW_GLOBAL_POINTER_FALLBACKS=1` |

`sky_click` 是私有 SPI（`_SLPSSetFrontProcessWithOptions`、`SLPSPostEventRecordTo` 一类符号），Apple 没公开、也没有 API 稳定性承诺。文档明确写了：**macOS 升级后要重新验证**。

为什么它值钱：普通方案要操作后台窗口，只能把窗口提到前台（打断用户）或用全局事件（动真实指针）。SkyLight 这条路能在「窗口不动、指针不动、前台不变」的前提下把点击送进去——这就是「后台控制」的技术核心。

## 四、输入：键入的三种情况

- **`sky_key`**：同样走 SkyLight，让目标窗口在它自己应用内成为 key window，投递按键，再释放状态。命令组合键（cmd+a / cmd+c / cmd+v）**通过目标应用自己的菜单栏完成**，这是绕开快捷键冲突的巧办法。
- **`auto`**：默认路径，窗口消息投递。
- **`global`**：Windows 的物理按键路径，需要显式调用并开安全开关。

注意文档里一句话：显式指定的方法**失败不会自动降级**。这是故意设计的——静默降级会让「我以为点到了、其实没点到」变成常态，这正是我们项目里那 8 条误报的同款问题。

## 五、离屏：agent_display 虚拟显示器

把目标窗口的 frame 移到一块用户看不见的虚拟显示器上：应用正常渲染、完整暴露树、`sky_click` / `sky_key` 都可用，而用户的 Space、焦点、指针完全不受影响。

约束也很清楚：

- 仅 macOS
- 会新增一块系统显示器，可能改变用户的显示排列，所以**不能未经用户同意就这么干**
- 窗口在 `restore` 之前、或这个会话结束时，会一直待在那块看不见的显示器上
- 必须在同一个会话里完成 park → 操作 → restore

这解释了为什么它必须绑定在「一轮对话」的生命周期里：会话一断，窗口自己回来。

## 六、看：截图与软件光标

截图在 macOS 用 ScreenCaptureKit（我们自己项目里用的是 `screencapture -l`，同一个目标，不同实现）。

软件光标这里有几个不错的工程细节：

1. **窗口相对锚点**：光标记住的是「相对目标窗口的位置」，不是屏幕坐标。所以窗口一移动，光标的落点立刻跟过去，不会继续朝旧位置飞。
2. **30Hz 后台读窗口 frame**：同一时刻只允许一次读取在飞，避免堆积。
3. **优先用 AX 拿窗口元素，取不到才用 `CGWindowListCopyWindowInfo`**：因为后者在窗口移动后可能报旧原点。
4. **渲染只用缓存帧**：AX 卡住也不让光标卡住。

这套「读位置」和「画画面」解耦的设计，是让「给人看的反馈」不拖慢「实际动作」的关键。

## 七、浏览器：不走 AX，走 CDP

网页内容对 AX 是不友好的（尤其 Chromium 里的大量自定义控件）。浏览器场景改用 Chrome DevTools Protocol：执行 JS、读 DOM、发真实输入事件。

我们项目里也是这个分工：界面用 AX，网页用 CDP。

## 八、借用的技术清单

| 层 | 来源 | 性质 |
| --- | --- | --- |
| Accessibility API（AXUIElement / UIAutomation） | Apple / Microsoft | 公开 API |
| `CGEventPostToPid` | Apple | 公开 API |
| ScreenCaptureKit | Apple | 公开 API（新系统） |
| **SkyLight（`_SLPSSetFrontProcessWithOptions` 等）** | Apple | **私有 SPI，靠逆向，无稳定性承诺** |
| 软件光标浮层 | AppKit（NSWindow 透明覆盖层） | 公开 API |
| Chrome DevTools Protocol | Chromium | 公开协议 |
| **open-computer-use（ocu）** | iFurySt，MIT | 第三方开源项目，Codex 行为的复刻 |

**借力的核心只有一条**：Apple 的私有 SkyLight 框架。没有它，就只能在前台操作或者动真实指针，「后台控制」不成立。

## 九、平台差异（官方文档明写）

| | macOS | Windows |
| --- | --- | --- |
| 读界面 | Accessibility | UI Automation |
| 点击 | AX / app_post / **sky_click** / global | UIA / app_post / global |
| 输入 | **sky_key**（菜单栏走组合键）/ auto / global | Win32 消息投递 / global |
| 离屏 | **agent_display** | 无 |
| 运行前提 | 辅助功能 + 屏幕录制权限 | **必须有登录的桌面会话**，SSH/服务上下文看不到顶层窗口 |

最后这条很关键：Windows 上的自动化如果跑在服务或 SSH 会话里，CLI 起得来但看不见窗口——表现是「什么都读不到」，而不是报错。

## 十、这套方案的代价（学习时最该记住的）

1. **私有 SPI 不稳定**：系统升级就可能失效，需要重新逆向。
2. **权限重**：辅助功能、屏幕录制，缺一个就有一半功能不可用。
3. **依赖用户会话**：锁屏、切换用户、SSH 上下文都会让 AX 失效（我们的项目里碰到过 `NSPOSIXErrorDomain Code=2`）。
4. **树质量参差**：原生 AppKit 应用暴露得很好，Electron / 微信这类只暴露一层壳。

## 十一、映射到我们的项目

| 能力 | 我们怎么做 |
| --- | --- |
| 读界面 / 点击 / 输入 | 调 ocu 的 CLI（`ocu snapshot` / `call click` / `js`） |
| 网页 | 自己写的零依赖 CDP 客户端 |
| 小窗回显 | Electron 多会话窗口 + 按窗口抓图，约 13fps，按窗口尺寸自适应出图 |
| 后台调度 | 自己写的 daemon、任务队列、应用锁、前台守卫 |
| 验收 | 自己写的三层验证（单测 / 仓库体检 / 重启自检） |

一句话：**底层那套「怎么在不打扰用户的前提下操作系统」的硬功夫是别人的（Apple 私有框架 + ocu 的逆向复刻）；我们做的是把它变成可调度、可观察、可验证的东西。**
## 十二、系统层还是应用层？

**结论：主体是系统层，浏览器部分是应用层。**

把它的技术按「离操作系统多近」排一下：

```
第 1 层  窗口服务器 / 内核           SkyLight（私有）
第 2 层  系统服务                    Accessibility、CoreGraphics、ScreenCaptureKit
第 3 层  应用框架                    AppKit（软件光标浮层）、Electron（我们的小窗）
第 4 层  应用自己的协议              CDP（浏览器）、AppleScript（单个应用）
```

对应到具体动作：

| 动作 | 站在哪一层 | 为什么 |
| --- | --- | --- |
| 读界面树 | 第 2 层（Accessibility） | 系统提供全应用通用的语义树 |
| 普通点击 | 第 2 层（AX 动作 / CGEventPostToPid） | 系统事件注入 |
| 后台点击 | 第 1 层（SkyLight） | 要绕开窗口管理器的前台限制 |
| 后台键入 | 第 1 层（SkyLight + 菜单栏） | 同上，组合键还要借应用菜单 |
| 截图 | 第 2 层（ScreenCaptureKit） | 系统级窗口捕获 |
| 虚拟显示器 | 第 1~2 层（系统显示管理） | 新增一块系统显示器 |
| 网页操作 | 第 4 层（CDP） | 网页不是原生控件，AX 树太差 |

**这意味着什么：**

1. **通用性来自系统层**。因为站在系统层，所以任何应用都能操作——不需要那个应用提供插件、不需要它支持脚本接口。这是「控制和被控应用无关」的前提。
2. **代价也在系统层**。要辅助功能权限、屏幕录制权限；系统升级可能改私有 SPI；锁屏或 SSH 上下文直接失效（Windows 上要求必须是登录的桌面会话）。
3. **应用层只用于补短板**。网页内容 AX 树不可靠，才退到 CDP；某些应用的原生脚本接口（AppleScript）也属于应用层，但只能一个应用一个应用地写。

对比一下三种做法：

| 做法 | 层次 | 通用性 | 稳定性 |
| --- | --- | --- | --- |
| 系统层（AX + 事件注入 + 私有 SPI） | 低 | 全应用通用 | 受系统升级影响 |
| 应用层协议（CDP / AppleScript / 插件） | 高 | 只能覆盖单个应用 | 相对稳定 |
| 纯像素（截图 + 坐标点击） | 最外层 | 通用 | 分辨率/窗口一变就废 |

所以真正「后台不打扰用户」的能力只能来自第 1~2 层；第 3 层是给人看的界面，第 4 层是补网页的短板。
## 十三、Windows 与 macOS 各自能做到什么

按 ocu 1.1.3 文档，跨平台的**九个核心工具**是兼容面：读应用状态、点击、输入文本、按键、滚动、拖拽、列应用等。超出这个面的能力两边不一样。

| 能力 | macOS | Windows | 说明 |
| --- | --- | --- | --- |
| 读界面树（AX/UIA） | ✅ Accessibility | ✅ UI Automation | 九大核心之一 |
| 语义点击（按元素） | ✅ AXPress | ✅ UIA Invoke 等 | 九大核心之一 |
| 直接投递鼠标事件 | ✅ `app_post` | ✅ `app_post` | 不动指针 |
| **后台点击（窗口不动）** | ✅ **`sky_click`**（私有 SkyLight） | ❌ 无等价能力 | Windows 要么走 UIA 语义动作，要么抬前台 |
| **后台键入** | ✅ **`sky_key`** | ⚠️ 窗口消息投递（`auto`） | Windows 的窗口消息对部分应用无效 |
| 命令组合键（cmd/ctrl+A 等） | ✅ 走目标应用菜单栏 | ⚠️ 窗口消息，可能不生效 | macOS 的做法更可靠 |
| 真实指针操作（兜底） | ✅ 需开安全开关 | ✅ 需开安全开关 + 显式调用 | 会打断用户 |
| **离屏到虚拟显示器** | ✅ **`agent_display`** | ❌ 无 | macOS 独有 |
| 定向查询元素（`query`） | ✅ | ❌ 仅 macOS | 按文本/角色精确定位 |
| 软件光标浮层 | ✅ | 未说明 | ocu 的交互体验组件 |
| 网页自动化 | ✅ CDP | ✅ CDP | 与平台无关 |
| 运行前提 | 辅助功能 + 屏幕录制权限 | **必须在登录的桌面会话** | SSH/服务上下文读不到窗口 |

### 结论：两边的「后台」不是同一个意思

**macOS 能真正做到「用户完全无感」**：窗口不抬、指针不动、Space 不切，甚至能把窗口搬到看不见的虚拟显示器上去操作。这一层靠的是私有 SkyLight。

**Windows 的「后台」要打折扣**：UIA 语义动作（按钮、菜单、输入框）可以完全不打扰用户；但一旦需要「在没有控件的空白区域点一下」，就只剩两条路——抬到前台，或者动真实指针。没有 SkyLight 那样的注入通道。

对应到我们的项目：

- macOS 上可以承诺「全程不抢焦点」，实测也做到了（BOSS 投递时 DSH 一直是前台）
- Windows 上只能承诺「语义控件操作不抢焦点」，点到空白区域会退化

### Windows 反而更省事的地方

Windows 的 UIA 提供 `InvokePattern` / `SelectionItemPattern` / `ValuePattern` 这类标准动作，很多场景比 macOS 更规整；而且 Win32 消息投递对传统 Win32 应用的兼容性不错。只是对 Electron、UWP 这类自绘窗口，效果会差一些。
## 十四、能力清单：两边各自能覆盖到哪

分两类看：**ocu 已封装的**（拿来就能用）和 **系统能做但没封装的**（要自己补）。

### A. ocu 已封装（跨平台九件套）

| 工具 | 能做什么 | macOS 底层 | Windows 底层 |
| --- | --- | --- | --- |
| `list_apps` | 列出正在运行的应用 | NSWorkspace / AX | 进程枚举 |
| `get_app_state` | 读界面树，可选附截图 | Accessibility + ScreenCaptureKit | UI Automation + 截图 |
| `click` | 点击（元素或坐标） | AXPress / CGEventPostToPid / SkyLight | UIA / app_post |
| `type_text` | 输入文本 | SkyLight / 事件注入 | Win32 窗口消息 |
| `press_key` | 按键、组合键 | SkyLight（走菜单栏） | 窗口消息 |
| `scroll` | 滚动 | CGEvent | Win32 |
| `drag` | 拖拽 | CGEvent | Win32 |
| `set_value` | 直接设控件值 | AXValue | UIA ValuePattern |
| `perform_secondary_action` | 触发控件的次要动作（右键菜单等） | AX 动作 | UIA |

macOS 额外：`select_text`（选文本）、`query`（按文本/角色定向查元素）。

### B. 系统能做、ocu 没封装（要自己写）

| 能力 | macOS 怎么做 | Windows 怎么做 | 我们项目里的情况 |
| --- | --- | --- | --- |
| 启动应用 | `open -a`、NSWorkspace | `Start-Process`、CreateProcess | 已用（离屏 Chrome、Electron 宿主） |
| 窗口移动/缩放 | AX 设 position/size、CGWindow | `SetWindowPos` | 已用（小窗定位、切窗口） |
| 读前台应用 | NSWorkspace / System Events | `GetForegroundWindow` | 已用（前台守卫） |
| 按窗口截图 | `screencapture -l` | `PrintWindow` | 已用（小窗缩略图） |
| 剪贴板 | `pbpaste` / `pbcopy` | `Get-Clipboard` / `Set-Clipboard` | 未用 |
| 文件操作 | Node fs | Node fs | 已用 |
| 多显示器/虚拟显示 | `agent_display`（ocu 封装） | 无等价 | macOS 侧可用 |
| 服务自启 | launchd | schtasks | 已做（core/service.mjs） |

### C. 两边都做不到或很难的

| 场景 | 原因 |
| --- | --- |
| 锁屏状态下操作 | AX/UIA 整体失效（实测 `NSPOSIXErrorDomain Code=2`） |
| SSH / 服务上下文操作 GUI | Windows 必须登录桌面会话；macOS 同理需要 Aqua 会话 |
| 自绘窗口（Electron/UWP 内部控件） | UIA/AX 只暴露一层壳，内部元素读不到 |
| 需要管理员权限的应用 | UIPI 拦截（Windows）；macOS 需要辅助功能授权 |
| 过验证码/风控 | 系统层注入能被平台识别为自动化 |

### D. 一句话总结

- **macOS**：能力最全，能做到「窗口不抬、指针不动、Space 不切」的真后台，还能把窗口搬到虚拟显示器。代价是依赖私有 SPI，系统升级可能失效。
- **Windows**：语义控件操作干净利落，但缺后台注入通道，点空白区域会退化；离屏和定向查询没有。
- **两边共同**：必须登录桌面会话、必须授权、树质量依赖应用是否规范实现无障碍。
### 补充：判断依据与反例

**它是系统层开发的直接证据**：运行时是原生可执行文件，不是浏览器插件、也不是注入页面的 JS。

```
macOS  : dist/Open Computer Use.app/Contents/MacOS/OpenComputerUse
         Mach-O universal binary（x86_64 + arm64），带 _CodeSignature
Windows: dist/windows/amd64/open-computer-use.exe
         PE32+ executable
```

一个 App Bundle + 签名的原生程序，才有资格调用 Accessibility、CGEvent、ScreenCaptureKit、SkyLight 这些接口。浏览器插件没这个权限。

**反例：什么是软件层（应用层）**

即投、各种 Boss 助手插件：它们跑在 Chrome 里，用 DOM 选择器和 CSS 定位，只能操作这一个网站的页面，站点一改版就失效，也碰不到窗口管理、输入注入这些系统能力。

| 维度 | 系统层（Codex / ocu） | 应用层（浏览器插件） |
| --- | --- | --- |
| 运行位置 | 独立原生进程 | 宿主应用内部 |
| 依赖接口 | AX / UIA / CGEvent / SkyLight | DOM、扩展 API |
| 覆盖范围 | 所有应用 | 单个网站 |
| 站点改版 | 不受影响（按控件语义定位） | 直接失效 |
| 权限要求 | 辅助功能 + 屏幕录制 | 仅扩展权限 |
| 后台能力 | 可做到窗口不抬 | 只能操作当前标签页 |

### 那我们项目算哪一层？

**我们是应用层，调系统层的引擎。** 代码是 Node + Electron：

- 系统层能力：全部委托给 ocu 的原生运行时（`ocu` CLI）
- 网页自动化：自己写的 CDP 客户端，属于应用协议层
- 小窗：Electron（应用框架层）
- 调度、任务、验收：应用层逻辑

所以准确说法是：**我们没有写系统层代码，但我们的设计是围绕系统层能力的边界来做的**——比如因为知道了 Windows 没有后台注入通道，才不会承诺 Windows 上也能“窗口不抬”。
