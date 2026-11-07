# 按运行时支持：从底层适配任意 macOS 应用

> 结论先说：**支持能力按「运行时族 + 控制通道」设计，不按应用一个个适配。**
> 新装一个软件，只要能归到已知的运行时族，就自动获得那一族该有的控制通道；
> 归不进去也还有兜底通道。逐个应用试只是验证手段，不是支持方式。

## 一、为什么不做逐应用适配

逐应用适配是线性工作量：装一百个软件就要摸一百遍，而且应用一升级（重写、换框架）之前的结论就废了。
真正决定"能不能控、怎么控"的是两件事：

1. **它是什么运行时**（原生 AppKit / Electron / Chromium 自研壳 / Qt / Flutter / Java…）——决定界面树长什么样
2. **它开了哪些通道**（无障碍树、调试端口、脚本字典、能否抓到窗口）——决定用哪条路操作

这两件都是有限集合。运行时就那么几类，通道就四条。按这两维设计，覆盖是组合出来的，不是一应用一策。

## 二、三层结构

```
识别层（不启动应用，只看包）      → 运行时类型 + 自带脚本字典
        ↓
通道层（运行时协商，逐条验前提）  → AX / CDP / AppleScript / 画面坐标
        ↓
驱动层（按链降级，失败换下一条）  → core/background.mjs 里的函数族
```

识别层完全不启动应用，所以可以在应用没运行、甚至屏幕锁着的时候跑。

## 三、识别层：怎么判断运行时

只看 `Contents/Frameworks`、`Contents/Resources`、`Info.plist` 和主二进制的链接库：

| 运行时 | 识别依据（命中任一） | 说明 |
| --- | --- | --- |
| electron | `Electron Framework.framework` / `app.asar` | 标准 Electron 应用 |
| chromium | `Chromium (Embedded) Framework` / `libmmmojo.dylib` / `* Helper (Renderer).app` | 含微信、QQ 这类自研壳：内部是 Chromium 多进程架构 |
| qt | `QtCore/QtGui/QtWidgets` 或链接 Qt 库 | WPS 这类 |
| flutter | `FlutterMacOS.framework` | Flutter 桌面端 |
| java | 包内有 JVM 运行时 / `libjvm` | Java 桌面应用 |
| native | 以上都没有 | 原生 AppKit，界面树通常最完整 |

注意两个容易误判的点（都已踩过）：

- **链接系统 `WebKit.framework` 不代表界面是 Web 做的**。GarageBand 也链接 WebKit（显示帮助文档），
  误判成 Web 应用会让通道顺序排错；现在只当线索记录，类型仍按原生。
- **自研 Chromium 壳不叫 Chromium**。微信/QQ 包里没有 `Chromium Framework`，但有 mojo IPC 和
  Renderer Helper 子进程，本质仍是 Chromium 多进程架构，识别后能走 CDP 一族通道。

另外读应用包里的 `.sdef` 文件统计脚本命令数（不依赖 Xcode 的 `sdef` 命令，本机只有 Command Line Tools），
有字典的应用多一条 AppleScript 语义通道。

## 三点五、通道协商：先问"现在哪条真的能用"

识别层给的是"默认该走哪条"，但应用当下可能根本没运行、没授权、没开调试口。
所以控制之前先协商一次（`core/driver-resolution.mjs`）：

```bash
npm run app:resolve -- Finder          # 看这个应用现在能用哪几条通道、按什么顺序
npm run app:resolve -- --all-user      # 把 /Applications 里的应用逐个协商
```

协商只做只读探测：应用在不在跑、AX 树有没有内容、CDP 端口开没开、AppleScript 授没授权、窗口在不在。
输出每条通道的"可用/不可用 + 原因"，以及实际执行顺序。实测 Finder：

```
[可用] ax：界面树可读（3605 字符）
[不可用] cdp：调试端口没开（connect ECONNREFUSED 127.0.0.1:9340）
[可用] applescript：已授权（25 条命令）
[可用] visual：有窗口可抓（AX 0 / 系统窗口层 1）
协商结果：Accessibility 语义驱动 → AppleScript 脚本字典 → 画面 + 坐标
```

这里又踩到一个具体的坑：Finder 明明有窗口，System Events 报的 AX 窗口数是 0。
所以判断"有没有窗口"时补了一次系统窗口层（CGWindowList）的证据，并且给 overlay 的窗口列表加了 `pid`——
窗口 owner 名是本地化的（Finder → 访达），按名字匹配必然漏，按 pid 匹配才可靠。

## 四、通道层：四条路，各有前提

| 通道 | 前提（运行时协商） | 代价 / 风险 | 失败长什么样 |
| --- | --- | --- | --- |
| AX（Accessibility） | 进程有可读的界面树 | 部分应用动作后会异步抢前台，需要延迟复查还原 | 树为空或窗口数为 0（自绘界面） |
| CDP（调试端口） | 进程真的开着调试端口 | Electron/Chromium 得允许开；不是所有应用都行 | 端口连不上、`/json/version` 无响应 | 已实现：`core/cdp-driver.mjs` + `npm run cdp:channel`（自建 Chromium 实例 4/4 通过：连端口读页面、按文字点、往输入框写） |
| AppleScript 字典 | 包内有 `.sdef` 且系统已授权自动化 | 第三方应用首次会弹自动化授权框，不能自动点 | 授权被拒、Apple 事件超时。已实现：`core/applescript-driver.mjs` + `npm run as:channel`（权限静默查询，Finder/Chrome 实测通过） |
| 画面 + 坐标 | 能抓到目标窗口画面 | 坐标依赖窗口位置，窗口一动就失效 | 窗口在别的桌面时只有纯色帧 |

**通道链就是按上表顺序尝试、失败降级**，不是写死用哪条。降级链体现在运行时类型上：

| 运行时 | 默认链 | 理由 |
| --- | --- | --- |
| native | ax → (applescript) → visual | 原生树最完整，字典按有无决定，最后画面兜底 |
| electron | ax → cdp → visual | Electron 桥接 AX，但页面内容靠 CDP 更准 |
| chromium | cdp → ax → visual | 自研壳 AX 往往只露出外壳，页面还得走 CDP |
| qt | ax → (applescript) → visual | Qt 的无障碍桥通常可用但不全 |
| flutter | ax → visual | Flutter 自绘，AX 覆盖有限 |
| java | ax → visual | JVM 无障碍桥可用性看实现 |

括起来的 applescript 表示"只有包里有脚本字典才排进链里"。

## 五、本机实测归类（`npm run app:runtime -- --all --user`）

`/Applications` 里 27 个应用：**electron 5、chromium 2、qt 1、native 19**。

| 应用 | 运行时 | 脚本命令 | 驱动链 |
| --- | --- | --- | --- |
| Antigravity / ChatGPT / DeepSeek Harness / OpenCode / 抖音 | electron | 0 | ax > cdp > visual |
| QQ / WeChat | chromium | 0 | cdp > ax > visual |
| wpsoffice | qt | 0 | ax > visual |
| Ghostty | native | 19 | ax > applescript > visual |
| Google Chrome | native | 23 | ax > applescript > visual |
| Keynote Creator Studio | native | 28 | ax > applescript > visual |
| Numbers Creator Studio | native | 16 | ax > applescript > visual |
| Pages Creator Studio | native | 10 | ax > applescript > visual |
| Safari | native | 10 | ax > applescript > visual |
| 其余 13 个（Clash Verge、FastZip、GarageBand、Gemini、iMovie、iRightMouse、OrbStack、State、Steam、Telegram、TencentMeeting、UURemote、奇游加速器） | native | 0 | ax > visual |

结论很直接：**同一族应用共用一条链**。给 Electron 族做的驱动，ChatGPT / OpenCode / 抖音 / 宿主自己一次全部受益；
Chromium 自研壳一族修好，QQ 和微信一起受益。

## 六、识别层之上的"运行后校正"

识别层给的是默认链，真正跑起来还要看实际表现（`core/app-strategy.mjs`）：

- 树可读且有可点元素 → 元素级驱动
- 树可读但零按钮 → 只读状态
- 树读不到但画面能回显 → 画面 + 坐标
- 启动即退 / 窗口起不来 → 应用侧限制，放弃

所以即使识别层判错（比如某应用理论上该有 AX，实际是自绘），运行时也会降级到画面通道，不会卡死。

## 七、代码在哪

| 关注点 | 文件 | 入口 |
| --- | --- | --- |
| 运行时识别、通道定义、驱动链 | `core/app-runtime.mjs` | 纯函数，13 项单测 |
| 从包结构采集证据（框架/asar/JVM/.sdef） | `scripts/app-runtime.mjs` | `npm run app:runtime -- <应用>` |
| 运行后降级判断 | `core/app-strategy.mjs` | 9 项单测 |
| 通道的实际实现（AX 点击/设值/输入、前台保护、等窗口、关应用） | `core/background.mjs` | 22 个 API |
| 批量验证（不是支持方式，是验收） | `core/tasks/app-matrix.mjs` | `npm run apps:probe` |

## 八、怎么加一族新运行时

以 Flutter 为例（现在只有识别和链，没有专门驱动）：

1. `classifyRuntime()` 里已经有 `FlutterMacOS.framework` 识别；
2. `RUNTIME_CHAINS.flutter` 定义默认顺序；
3. 如果 Flutter 的 AX 覆盖太差，就在通道层加一条新通道（比如基于 Vision OCR 的元素定位），
   在 `DRIVER_INFO` 里写清前提，然后把它排进 Flutter 的链；
4. 加单测（识别、链顺序、前提说明）。

整个过程不需要动任何"应用白名单"——这正是按运行时设计的意义。

## 八点五、CDP 通道的实现与实测（2026-11-07）

通道代码在 `core/cdp-driver.mjs`：给应用分配稳定端口（bundle id 哈希到 9330-9389）、
带 `--remote-debugging-port` 后台拉起、探测 `/json/version`、挑页面 target、读页面 / 按文字点 / 往输入框写。
底层复用仓库里已有的零依赖 CDP 客户端（`core/cdp.mjs`，自带 RFC 6455 帧实现）。

**能力验证（自己起的 Chromium 实例，headless + 独立 profile，不碰用户 Chrome）：**

```bash
npm run cdp:channel
# PASS 连上调试端口并找到页面
# PASS 读页面标题与正文：title=CDP 通道测试页 textLen=12
# PASS 往输入框写文字：verified=后台写入
# PASS 按文字点按钮：matched=提交 out=已点击:后台写入
```

**第三方应用实测（`npm run cdp:apps`）：**

| 应用 | 运行时 | 结果 | 说明 |
| --- | --- | --- | --- |
| ChatGPT | electron | 端口开放、能连上、能读标题/URL，约 1.2 秒后连接被应用断开（code 1006） | 应用侧主动关闭调试会话，读不到正文；属于应用限制，不是通道实现问题 |
| OpenCode | electron | 端口没起来 | 应用不认 `--remote-debugging-port` 开关 |
| 抖音 | electron | 端口没起来 | 同上，且应用本身启动即退 |

也就是说：**通道本身可用（自己起的实例 4/4 通过），但"应用愿不愿意开调试端口"是应用侧的事**，
按架构设计这时降级到 AX / 画面通道即可，不需要为单个应用改代码。
验证脚本不会硬重启正在运行的应用——已经在跑的应用直接跳过，避免打断用户。

## 八点六、AppleScript 通道的实现与实测（2026-11-07）

通道代码在 `core/applescript-driver.mjs`。这条通道最大的风险不是技术，是**授权弹窗**：
控制第三方应用需要「自动化」权限，没授权时 `osascript` 会弹系统授权框，弹框会打断用户，
而且替用户点"允许"是越权操作。

所以实现里先静默查权限：调用系统 API `AEDeterminePermissionToAutomateTarget`
（`askUserIfNeeded=false`，不会弹框），只有状态是 `granted` 才真正发 Apple 事件。
查询用一个小 C 程序（clang 是系统自带），首次使用时编译并缓存到 `~/.desktop-agent/bin/ae-permission`。

**权限状态含义：** `granted` 已授权 / `needs-consent` 授权后会弹框（不发）/ `denied` 被拒 /
`app-not-running` 应用没运行（查不到，也不为了测试去启动它）/ `unknown` 查不到。

**实测（`npm run as:channel`）：**

| 应用 | 脚本命令 | 权限 | 结果 |
| --- | --- | --- | --- |
| Finder | 25 条 | granted（0） | 只读命令成功：取到主目录名 |
| Google Chrome | 23 条 | granted（0） | 只读命令成功：取到当前标签地址（报告里脱敏成域名） |
| Safari | 10 条 | app-not-running | 没运行，不发命令 |
| TextEdit | 0 条 | - | 没有脚本字典，通道不适用（对照组） |

顺带修了一个会影响很多判断的 bug：原来判断"应用是否在运行"用 `pgrep -f bundleId`，
会命中 `com.apple.SafariPlatformSupport.Helper` 这类辅助进程，把没运行的 Safari 当成在跑；
现在优先用 LaunchServices（`application id ... is running`），只有拿不到明确答案才退回进程名匹配，
且要求路径里有 `/Contents/MacOS/`。

## 九、已知限制（类型级，不是应用级）

- **锁屏**：AX 和抓图整体不可用，所有通道失效，任何应用都无法后台操作（工具会标"环境跳过"，不会假装成功）。
- **CDP 不是默认开的**：Electron/Chromium 应用需要允许远程调试端口，未开时这条通道直接跳过。
- **AppleScript 首次授权**：第三方应用第一次用脚本字典会弹系统授权框，属于用户手动步骤，不能自动点。
- **画面通道依赖窗口可见位置**：窗口在别的桌面、被最小化时只能拿到纯色帧。
- **菜单栏命令**：当前工具链下菜单项不可查询（AXMenuItem 恒为 0），这是通道级缺口，跟具体应用无关。
