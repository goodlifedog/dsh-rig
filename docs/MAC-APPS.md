# macOS 应用适配手册（后台控制）

> 目标：把应用在后台拉起来、读界面、点按钮、设值、抓画面，**全程不打扰前台**。
> 本文只写实测过的东西；没实测的一律标「未验证」。数据来源：`reports/app-matrix-*.md`。
>
> **支持方式不是"逐个应用适配"**：能力按运行时族（原生/Electron/Chromium 自研壳/Qt/Flutter/Java）
> 和通道（AX/CDP/AppleScript/画面坐标）设计，见 [APP-SUPPORT-ARCHITECTURE.md](APP-SUPPORT-ARCHITECTURE.md)。
> 本文的逐应用矩阵是**验证**，用来确认某一族落在哪条链上、边界在哪。

## 一、先看结论：分门类怎么控

| 门类 | 代表应用 | 后台读取 | 后台点击 | 后台输入 | 画面回显 | 关键注意点 |
| --- | --- | --- | --- | --- | --- | --- |
| 原生 AppKit | 备忘录、计算器、系统设置、访达、文本编辑、预览、iMovie | 稳 | 稳 | 设值可用 | 通常 live | iMovie 首次读取会短暂抢前台，需 `settleFront` 兜住 |
| Electron 聊天/协作 | QQ、微信、Gemini、ChatGPT、Steam | 稳 | 稳 | 设值可用 | 常见 offscreen | 有些应用 AX 操作后**异步**抢前台（QQ/微信/Gemini），读完要延迟复查 |
| 自绘界面 | Telegram | 可读但元素少 | 0 个按钮，不可点 | 不可靠 | 一般 | 对方用自绘 canvas，AX 拿不到控件，只能靠坐标/快捷键，暂不接管 |
| 浏览器 | Safari、Chrome | Safari 需已有窗口 | 可用 | 可用 | live | Chrome 会自己抢前台：用独立 headless 实例 + 专用 profile |
| 终端 | Ghostty | 读取会把应用顶到前台 | — | 键入 + 回车可用 | live | 一律走 `readSafe`；写完必须读回校验 |
| 菜单栏应用 | Clash Verge | 只读状态 | 不动 | 不动 | — | **永不退出、永不点**，用户在用代理 |
| 首启引导弹窗 | Pages Creator Studio 这类新装应用 | AX 可读 | 白名单按钮可点 | — | live | app-modal 会卡住 Apple 事件，必须靠 System Events 探窗口 + 白名单点掉 |
| 会自退的应用 | 抖音（App Store 版 8.1.1）、Antigravity | 否 | 否 | 否 | 否 | 进程启动后 <1s 自行退出（应用侧行为），不是控制层问题 |
| 多桌面/最小化 | 任意 | 可读 | 可点 | 可用 | offscreen | 窗口在别的桌面时系统只给纯色帧，操作仍然有效 |

## 二、通用适配流程（代码已内置）

```js
import { ensureAppRunning, waitForWindow, dismissOnboarding,
         readSafe, findSafe, quitApp } from './core/background.mjs';

const app = { name: 'Steam', bundle: 'com.valvesoftware.steam', process: 'steam_osx' };
const launch = await ensureAppRunning(app);        // open -g -j：不激活前台、也不闪窗口
await waitForWindow(app.name, { timeoutMs: 12000 }); // 等窗口真的建出来
await dismissOnboarding(app.name);                 // 只点「继续/开始使用」这类白名单按钮
const tree = await readSafe(app.name);             // 读前记前台、读后还原
const btns = await findSafe(app.name, { role: 'AXButton' });
await quitApp(app);                                // 只关自己拉起来的
```

矩阵任务（`core/tasks/app-matrix.mjs`）已经把这几步串好了，直接跑：

```bash
npm run matrix                                   # 默认 11 个门类
MATRIX_PRESET=im npm run matrix                  # 按预设门类跑：office/im/dev/system/media/tools
MATRIX_APPS_JSON='[{"name":"Steam","bundle":"com.valvesoftware.steam","process":"steam_osx"}]' npm run matrix
MATRIX_QUIT=0 npm run matrix                     # 探测完不关（默认会关自己开的）
MATRIX_DISMISS=0 npm run matrix                  # 不点首启弹窗
```

预设清单在 `core/app-presets.mjs`，改一行就能加应用；同一个应用不许出现在两个门类里，
条目缺字段、bundle 写错都会被单测拦住。

想知道「本机装的软件有哪些还没适配」，直接跑清点：

```bash
npm run apps:inventory                 # 扫描 /Applications，对照预设和全部历史矩阵报告，输出 reports/app-inventory-*.md
npm run apps:probe -- GarageBand,UURemote   # 按应用名临时探测（自动解析 bundle/进程名），跑完刷新清点
npm run apps:probe -- --preset tools        # 按门类探测
npm run apps:probe -- GarageBand --dry      # 只打印将要执行的命令
npm run apps:probe -- GarageBand --keep     # 探测完不关闭（排障时用）
```

报告末尾除了逐应用状态，还有一段「按运行时族看适配」：每族装了几个、几个已适配、
默认通道链是什么。回答「还有什么软件能适配」要看族而不是逐个应用——同一族共用一套通道，
族里已经有一个跑通，新装同类软件大概率直接可用；真正要补的是「整族都限制」的情况。

清点会如实区分「已适配 / 可只用画面 / 专用方案 / 不动 / 限制 / 未测 / 未安装」，
包名过期时按名字兜底并标注（不会因为应用升级换了包名就误报成没装）。

注意「专用方案」的判定口径：**必须 CDP 实测通过（端口真起来、能读到页面）才算**。
只是「运行时是 electron/chromium、理论上有 CDP 通道」不算——端口没起来照样是不可控，
这种情况会判成「限制」，并在理由里写清「下一步可带 --remote-debugging-port 试」。

报告里还有一列「建议控法」，是按探测结果自动判定的，不用人肉分析：

| 建议控法 | 判定条件 | 做法 |
| --- | --- | --- |
| 元素级驱动 | 界面树可读且至少一个可点元素 | 读树 + AX 点击/设值，最稳 |
| 只读状态 | 界面树可读但零可点元素 | 只能读状态；有输入框可试着写 |
| 画面+坐标 | 读不到树但画面能回显 | 只能按坐标/快捷键，位置一变就失效 |
| 专用通道 | 应用会抢前台（如 Chrome） | 走独立实例，不碰用户窗口 |
| 不接管 | 用户关键工具 / 宿主自己 | 只读状态或完全不碰 |
| 应用侧限制 | 启动即退、窗口起不来、什么都拿不到 | 放弃元素级接管 |

报告末尾还会直接给出「下一步补测」命令（把没测的应用拼成 MATRIX_APPS_JSON），复制就能跑。

判定规则在 `core/app-strategy.mjs`，9 项单测覆盖：关键工具不接管、专用通道、树可读有按钮、
树可读零按钮、抢前台要提示复查、画面可回显、启动失败、没装/没测、标签完整性。

## 三、每个坑的成因与对策

**1. 窗口还没建好就采集 → 假「没有窗口」**
Electron 应用 `open -g` 之后进程先起来，窗口要几百毫秒到十几秒。Steam 实测 677ms 就绪；
抖音/Antigravity 等到 40s 也没有窗口（它们随后自行退出，属应用侧问题）。
对策：`waitForWindow()` 轮询 System Events 的窗口数，拿不到再判失败。

**1.5 显示名 ≠ 进程名（很常见的坑）**
同一个应用有三个名字：`/Applications` 里的文件名、Info.plist 的 bundle id、系统里的**进程显示名**（可能本地化）。
比如 Keynote Creator Studio 的进程名是 `Keynote`，腾讯会议的窗口 owner 是「腾讯会议」。
只按一个名字查会「查不到窗口 / 查不到弹窗」，甚至会让退出保护失效、错误强杀丢数据。
对策：`windowCount()` / `waitForWindow()` / `dismissOnboarding()` / `quitApp()` 都接受候选名
（`altNames`，矩阵自动把进程名带上），按顺序问到为止；退出保护尤其要两个名字都查。

**2. 首启欢迎弹窗卡住 Apple 事件**
Pages Creator Studio 首启弹窗期间，`tell application "Pages" to count documents` 直接超时（-1712），
但 System Events 仍能读到窗口结构。
对策：用 System Events 探窗口/弹窗；`dialogs()` 读弹窗文案，`dismissOnboarding()` 只点白名单按钮
（继续/下一步/开始使用/知道了/OK…），遇到「存储/删除/取消」一律不点。

**3. 操作后应用异步抢前台**
QQ / 微信 / Gemini 是 AX 动作**完成之后**才激活的，立刻比对会漏判。
对策：`settleFront(expect, {waitMs:250, retries:3})` 延迟复查 + 还原。

**4. 读取本身就抢前台**
Ghostty、ChatGPT 读界面树会把应用顶到前台（连不截图也发生）。
对策：`readSafe()` / `findSafe()`，读前记前台、读后比对、变了立刻还原并如实标记。

**5. 元素索引会过期**
索引只活约两分钟，过期后工具返回 `isError:false` 但正文写着「expired」。
对策：同一次 MCP 会话里先 `query` 再点；`withRetry()` / `clickByText()` 自动重查；
`toolFailureText()` 扫正文识别假成功。

**6. 输入写不进去 ≠ 读不出来**
读回失败不能当「没写进去」，否则会降级重输、内容重复。
对策：`smartType()` 读不出时停在当前方式并返回 `verified:null`。

**7. 窗口在别的桌面**
系统只给纯色帧，overlay 标 offscreen；AX 操作仍然有效，只是画面抓不到。

**8. 退出也可能被弹窗卡住**
文本编辑有两个未命名文稿时，退出会弹「要存储吗」，Apple 事件同样超时。
对策：`quitApp()` 先优雅退出；退不掉时**先看一眼有没有保存/删除类弹窗**——
有就报 `needs-confirm` 并且绝不强杀（强杀会丢用户没保存的内容），没有才按进程 TERM。
探测完自动收尾，不留窗口。

## 四、实测记录（2026-11-07，同一台机器）

| 应用 | 类别 | 读界面 | 按钮 | 画面 | 前台影响 | 备注 |
| --- | --- | --- | --- | --- | --- | --- |
| 备忘录 Notes | AppKit | 125 节点级 | 有 | live | 无 | 菜单项不可查询 |
| 文本编辑 TextEdit | AppKit | 有 | 有 | live | 无 | 未命名文稿退出会弹确认 |
| 计算器 Calculator | AppKit | 有 | 40 个 | live | 无 | 后台键入可用 |
| 访达 Finder | AppKit | 有 | 有 | live | 无 | 窗口按钮可用 |
| 系统设置 | AppKit | 有 | 有 | live | 无 | — |
| Clash Verge | 菜单栏 | 只读 | 不动 | — | 无 | **不退出、不点击** |
| Ghostty | 终端 | 有 | — | live | 读取会抢，已还原 | 键入+回车实测通过 |
| ChatGPT | Electron | 有 | 有 | live | 无 | 回车不提交，要点「发送」 |
| Safari | 浏览器 | 需已有窗口 | 有 | live | 无 | 冷启动不留窗口 |
| Chrome | 浏览器 | 有 | 有 | live | 会抢 | 用独立 headless 实例 |
| WPS Office | 办公 | 有 | 有 | live | 无 | 只开首页时无文档 |
| Pages Creator Studio | 第三方办公 | 16 节点 | 2 | live | 无 | 首启弹窗卡 Apple 事件 |
| 微信 WeChat | Electron | 20 节点 | 7 | 抓不到窗口 | 异步抢，已还原 | — |
| QQ | Electron | 125 节点 | 20 | offscreen | 异步抢，已还原 | 窗口在别的桌面 |
| OrbStack | Electron | 57 节点 | 16 | live | 无 | — |
| Gemini | Electron | 68 节点 | 46 | offscreen | 异步抢，已还原 | 2 个窗口按钮 |
| iMovie | AppKit 重应用 | 有 | 有 | live | 首次读取短暂抢夺，已还原 | — |
| Steam | Electron/Chromium | 9 节点 | 0 | live（10949B） | 无 | 窗口 677ms 就绪；退出需 TERM |
| 腾讯会议 | Electron 会议 | 9 节点（不稳定，重开有时 0） | 2 | 抓不到窗口 | 无 | 窗口在系统层可见（owner 显示「腾讯会议」）但 AX 窗口数为 0 |
| FastZip | 原生压缩工具 | 51 节点 | 7 | live（34822B） | 无 | 窗口 761ms 就绪，收尾优雅退出 |
| State | 菜单栏工具 | 62 节点 | 1 | live（31454B） | 无 | AX 窗口数恒为 0，靠系统窗口层判定就绪 |
| Keynote Creator Studio | 办公文档 | 0 节点 | 0 | live（50805B） | 读取瞬间抢了一下，已还原 | 元素级不可用，只能画面+坐标 |
| Numbers Creator Studio | 办公文档 | 0 节点 | 0 | live（51925B） | 无 | 同上 |
| 抖音 | App Store 版 | 否 | 否 | 否 | 无 | 启动后 <1s 自退，应用侧限制 |
| Antigravity | Electron IDE | 否 | 否 | 否 | 无 | 启动即退出（退出码 0），应用侧限制 |

汇总口径：可读 = 界面树有内容；可点 = 至少一个 AXButton；live = 画面能直接回显；
offscreen = 窗口在别的桌面，系统返回纯色帧。

## 五、AX 为空的几类应用（只能画面 + 坐标）

有几类应用系统窗口层明明有窗口，AX 树却是空的或者时有时无，元素级操作不可靠：

- **菜单栏工具**（State）：AX 窗口数恒为 0，但界面树有 62 个节点、画面能抓到。
- **个别会议/办公应用**（腾讯会议、Keynote/Numbers Creator Studio）：窗口在系统层可见
  （腾讯会议的窗口 owner 显示成「腾讯会议」，不是进程名），AX 树时有时无、常常为 0。
- 对这类应用，后台能做的只有**抓画面 + 按坐标点**，或者走它自己的快捷键；
  不要去等 AX 元素，等到超时只会白等。

判定「窗口就绪」时因此要看两个来源：System Events 的窗口数（`windowCount()`）和
overlay 的系统窗口列表（CGWindowList）。只信 AX 会把菜单栏工具误判成「没有窗口」。

另外这类应用**启动偏慢**：Keynote Creator Studio、腾讯会议首次拉起要 5 秒以上，
原来的 3 秒判定会报「启动后仍检测不到进程」。现在 `ensureAppRunning()` 默认等 8 秒
（矩阵里给到 15 秒），`waitMs` 可调。

## 六、本机已安装应用的覆盖情况

| 应用 | 状态 | 说明 |
| --- | --- | --- |
| 备忘录 / 文本编辑 / 计算器 / 访达 / 系统设置 | 已适配 | AX 完整，可读可点可设值 |
| QQ / 微信 / Gemini / ChatGPT | 已适配 | 操作后异步抢前台，已自动还原 |
| Ghostty | 已适配 | 读取会抢前台；键入+回车可用 |
| OrbStack / FastZip / State | 已适配 | Electron / 原生工具 / 菜单栏工具 |
| Steam | 已适配 | 窗口 677ms 就绪、画面可回显、退出需 TERM |
| iMovie | 已适配 | 读取瞬间抢前台，已还原 |
| Safari | 已适配 | 冷启动不留窗口，需要已有窗口 |
| Chrome | 走独立实例 | 会自己抢前台，用专用 profile 的 headless 实例 |
| WPS Office | 已适配 | 只开首页时没有文档 |
| Pages / Keynote / Numbers Creator Studio | 限制 | 首启弹窗卡 Apple 事件；Keynote/Numbers 的 AX 树为空，只能画面+坐标 |
| 腾讯会议 | 限制 | AX 时有时无，窗口层可见，画面抓不到 |
| Telegram | 限制 | 自绘窗口，AX 拿不到按钮 |
| 抖音 / Antigravity | 限制 | 启动后自行退出（应用侧行为） |
| Clash Verge / 奇游加速器 | **不动** | 用户在用的代理/加速器，只读状态，永不退出 |
| OpenCode / GarageBand / UURemote / iRightMouse | 未测 | 已进预设清单，等解锁后跑 `MATRIX_PRESET=dev` 等 |

## 七、给一个新应用做适配的步骤

以后本机装了新软件，按这个顺序走一遍就行，不用重新想：

1. `npm run apps:inventory` 看它进了哪个状态（没装/未测/限制…），报告末尾会给补测命令
2. `npm run apps:probe -- <应用名>` 探测：自动解析 bundle、后台拉起、等窗口、点掉首启弹窗、读树、试抓画面、自动关闭
3. 看报告里的「建议控法」列：
   - 元素级驱动 → 直接用 `findSafe/click/setValue` 写任务
   - 只读状态 → 别指望点按钮，只能读文本或写输入框
   - 画面+坐标 → 元素级没戏，只能按坐标或快捷键
   - 专用通道 / 不接管 / 应用侧限制 → 别硬攻，写进文档
4. 把条目补进 `core/app-presets.mjs` 对应门类，跑 `npm test` 让 5 项预设单测兜住字段和重复
5. 再跑一次 `npm run apps:inventory` 确认状态从「未测」变成实际的结论

整个过程不激活目标应用；探测完自动关掉自己拉起的实例，用户正在用的应用不会被动。

## 八、当前进度与解锁后的待办（2026-11-07 22:20）

机器锁屏时 AX 与抓图整体不可用（`CGSSessionScreenIsLocked`），矩阵会直接标「环境跳过」，
不会产出假结论。当前卡在这里，已经做完的部分：

- 已实测 22 个应用：19 个元素级可读、2 个只能画面+坐标（Keynote/Numbers Creator Studio）、
  3 个应用侧限制（腾讯会议 AX 不稳定、抖音/Antigravity 启动即退）
- Clash Verge / 奇游加速器：明确不接管，只读状态
- Chrome：走独立 headless 实例

**解锁后按顺序做三件事：**

```bash
npm run apps:probe -- GarageBand,iRightMouse,UURemote   # 三个还没测的
npm run apps:inventory                                   # 刷新清点，看状态从「未测」变成什么
# 复验「启动后自行退出」的两个：连开两次看是否稳定自退
npm run apps:probe -- 抖音,Antigravity --keep
```

如果复验仍然是自退，就把结论写进本文「实测记录」表，状态保持「应用侧限制」；
如果这次能起来，就按「建议控法」补全它的能力数据。

## 九、已知边界

- **菜单栏命令**：备忘录这类应用菜单栏节点不可查询（AXMenuBarItem/AXMenuItem 均为 0），
  后台点菜单走不通；⌘N 快捷键会把应用顶到前台，AppleScript 控制第三方应用会触发自动化权限弹窗。
  两条替代方案都实测失败，别再试。
- **自绘界面**（Telegram）：AX 拿不到控件，只能坐标/快捷键；坐标法会依赖窗口位置，暂不接管。
- **需要登录/联网的应用**：抖音这类在未登录或受限环境会自退；Antigravity 同样。
- **Windows 实机**：本机无硬件，未验证。
- **锁屏**：锁屏下 AX 整体不可用，所有验收会标「环境跳过」，不能算通过。
- **用户正在用的应用**：不要调用 `quitApp`；矩阵的自动收尾只关 `launch === 'launched'` 的应用。