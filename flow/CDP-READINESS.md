# 本机 Electron/Chromium 应用的 CDP 可接入性（只读盘点）

> 生成时间：2026-11-08 · 分析人：cdp-bridge（第三方视角）
> 硬约束：**全程只读，没有启动、退出、激活任何应用**（没有 open/osascript/launchctl 启停），没有 commit。
> 数据来源：① /Applications 包结构与二进制只读检查（Info.plist、Contents/Frameworks、app.asar、otool -L、strings）；② reports/cdp-driver-*.json 里已有的 10 次 CDP 实测；③ reports/app-matrix-*.json 里的 AX 树实测（用来对照「为什么需要 CDP」）。
> 本机：macOS 26.5.1 arm64，用户正在电脑前。

## 0. 结论摘要

- 本机 /Applications 下 **Electron 系共 6 个**：Antigravity、ChatGPT、DeepSeek Harness、OpenCode、抖音、QQ（QQ 是 Electron 内核但框架/入口改名成 QQNT）。
- **已实测支持（①）**：ChatGPT（cdp-ok，2 次成功）；Google Chrome 的「独立 profile 离屏实例」路径也已实测可用（browser-demo 验收 PASS），但**不能接管用户正在用的 Chrome 实例**。
- **理论支持但未实测（②）**：Antigravity、QQ；DeepSeek Harness 也满足静态条件，但它是承载本会话的宿主 App，明确列为「不用于实验」。
- **不支持或无法判断（③）**：OpenCode 与抖音是「静态支持、实测端口没起来」——按三档定义归到无法判断；TencentMeeting、Telegram、WeChat、Gemini、Safari 是**结构性不支持 CDP**（没有完整 Chromium 运行时）。
- 最重要的一条判断依据：**strings 里能搜到 remote-debugging-port，只能证明代码里保留了这个开关，不能证明应用会尊重它**。OpenCode 和抖音就是反例（静态全有、10 次实测全失败）。
- 下一步最值得实测的两个：**OpenCode**（静态支持 vs 实测 10/10 失败，信息价值最高）和 **Antigravity**（零历史实测、AX 只有 0 节点、非沙盒）。

## 1. 主表：三档清单

| 应用（bundle id / 版本） | 运行时族 | 结论 | 证据 | 启动参数建议 | 对用户的影响评估 |
| --- | --- | --- | --- | --- | --- |
| ChatGPT（com.openai.codex / 26.1103.41825） | Electron fork：Codex Framework 157.0.8103.39（浏览器报 Chrome/157.0.8103.39） | **① 已实测支持** | reports/cdp-driver-2026-11-07T21-13-27-981Z.json：port 9381、Browser Chrome/157.0.8103.39、title ChatGPT、url app://-/index.html；10 次运行 = 2 次 cdp-ok、5 次 read-failed（连接被应用侧断开）、1 次 attach-failed、1 次端口没起、1 次应用在跑跳过。包结构：Codex Framework.framework + app.asar（726MB）+ Codex Renderer/GPU/Service 等 Helper；framework 二进制含 remote-debugging-port / DevToolsActivePort / remote-debugging-pipe；app-sandbox=false | 先完全退出（单实例锁），再 open -g -n -b com.openai.codex --args --remote-debugging-port=<非默认端口>；连上后按 url 选 app://-/index.html 这个 target | 需重启应用；历史实测启动会抢一次前台（多次 frontStolen=true，退出后恢复）；登录态在 userData，一般保留；端口无鉴权，只绑回环、用完退出 |
| Google Chrome（com.google.Chrome / 156.0.8078.80） | Chromium（原生多进程，非 Electron） | **① 已实测支持（仅独立 profile 实例）** | core/browser.mjs:202-218 用 --remote-debugging-port=0 + --user-data-dir=独立目录；:40-57 从 DevToolsActivePort 读端口并等 /json/version；reports/acceptance-2026-11-08T05-55-35-287Z.md 里 browser-demo PASS；framework 二进制含 remote-debugging-port / DevToolsActivePort / remote-allow-origins | 必须给独立 --user-data-dir，不要操作默认 profile；用户正在跑的 Chrome（pid 660）加不了端口，只能退出重开，不建议 | 独立实例离屏/headless，不影响用户；不要碰用户当前实例 |
| Antigravity（com.google.antigravity / 2.25.0） | Electron 44.4.3（Electron Framework.framework，Chrome/152.0.7977.130） | **② 理论支持，未实测** | 包结构：Electron Framework.framework + app.asar（4.3MB）+ Antigravity Helper (GPU/Renderer/Plugin).app；主二进制 otool 链接 Electron Framework；framework 二进制含三个调试串；codesign 无 app-sandbox entitlement；reports 里没有任何 CDP 实测；AX 矩阵 0 节点 | 退出后：open -g -n -b com.google.antigravity --args --remote-debugging-port=<port>，轮询 /json/version，再 evaluate document.title | 需重启 IDE（未保存工作区/终端会丢）；启动是否抢前台未实测 |
| QQ（com.tencent.qq / 7.0.2） | Electron 40.0.0（QQNT.framework，Chrome/144.0.7559.60） | **② 理论支持，未实测** | 包结构：QQNT.framework + QQ Helper (GPU/Renderer/Plugin).app + Resources/app/application.asar；QQNT 二进制含 Electron/40.0.0、Chrome/144.0.7559.60、remote-debugging-port（未搜到 DevToolsActivePort 串，说明可能被裁剪，不代表不支持）；App Store 版：MAS receipt + app-sandbox=true（含 network.server 权限）；AX 可读 125 节点/20 按钮 | 同上 Electron 套路；沙盒版优先用固定端口轮询 /json/version | 需重启（聊天端，可能有未发送草稿）；沙盒应用可能弹权限或限制端口 |
| DeepSeek Harness（com.deepseek.dsh / 0.2.2-rc.1） | Electron 44.7.0（Chrome/152.0.7977.130） | **② 理论支持，但明确不用于实验** | Electron Framework.framework + app.asar（203MB）+ Helper 全套；framework 二进制含三个调试串；**当前正在运行**（分析时刻 pid 94953，本会话宿主） | 不建议：这是承载当前对话的宿主 App，带调试端口重启会直接杀掉本会话 | 高：中断当前会话/任务；列入「不动」名单 |
| OpenCode（ai.opencode.desktop / 2.0.30） | Electron 44.4.5（Chrome/152.0.7977.130） | **③ 无法判断（静态支持，实测 10/10 失败）** | 包结构：Electron Framework.framework + app.asar（168MB）+ OpenCode Helper 全套；framework 二进制含三个调试串；reports/cdp-driver-*.json 共 10 次运行全部 cdp-unavailable，统一报「12s 内 ECONNREFUSED 127.0.0.1:9349」 | 先只读排查：启动后看主进程 argv 是否带 flag、是否被单实例转交、是否 re-exec 到别的二进制；可试直接执行 Contents/MacOS/OpenCode | 需重启；详见第 5 节的排查计划 |
| 抖音（com.bytedance.douyin.desktop / 8.1.1） | Electron 36.4.0-rs.30（字节定制，Chrome/136.0.7103.59） | **③ 无法判断（静态支持，实测 10/10 失败）** | 包结构：Electron Framework.framework + app.asar（6.9MB）+ 抖音 Helper (GPU/Renderer/Plugin).app；framework 二进制含三个调试串；**App Store 版**：MAS receipt + app-sandbox=true（含 network.server）；10 次实测全部 cdp-unavailable（12s 内 ECONNREFUSED 127.0.0.1:9379） | 同上；考虑沙盒与参数过滤，优先级低于 OpenCode | 需重启；App Store 客户端登录/草稿风险；建议暂不实测 |
| TencentMeeting（com.tencent.meeting / 3.47.2） | 自绘 native（WeMeetFramework 407.3.47） | **③ 不支持 CDP** | 无 Electron/Chromium framework；WeMeetFramework 二进制无 remote-debugging-port、无 Chromium 串；otool 只链 wemeet_base/wemeet_process/WeMeet | 不适用 | — |
| Telegram（ru.keepcoder.Telegram） | 原生 Swift/Cocoa（Sparkle 1.21.0） | **③ 不支持 CDP** | 无 Electron Framework；主二进制无 remote-debugging-port；AX 实测 26 节点/0 按钮（reports/app-matrix） | 不适用，走 AX/坐标 | — |
| WeChat（com.tencent.xinWeChat） | 原生 + Cronet 网络栈 | **③ 不支持 CDP** | 无 Electron/Chromium framework；mmcronet 等二进制无 remote-debugging-port / Chromium 串；AX 20 节点/7 按钮。注：reports/app-inventory 把它标成 chromium，依据应是 Cronet（Chromium 网络库），不是完整 Chromium 运行时 | 不适用，走 AX | — |
| Gemini（com.google.GeminiMacOS） | 原生 Swift + WKWebView | **③ 不支持 CDP** | 无 Frameworks 目录；主二进制只链系统库；字符串有 WKWebView、无 Chromium/Electron；无 remote-debugging-port | 不适用，走 AX | — |
| Safari（com.apple.Safari） | 系统 WebKit | **③ 不支持 CDP** | 系统浏览器，不提供 CDP（另有 WebDriver/Web Inspector 通道） | 不适用 | — |

> 表中未列出的应用（Finder、备忘录、WPS、FastZip、OrbStack、Steam、Clash Verge、奇游加速器等）都没有 Chromium/Electron 运行时，不在 CDP 候选范围内；它们按现有 AX/坐标方案处理。

## 2. 判据：一个应用「可 CDP」看什么

本次用四类只读证据，按强弱排序：

1. **历史实测（最强）**：reports/cdp-driver-*.json 里有没有 cdp-ok 记录（端口真的开了、/json/version 真的答了、target 真的读到了）。本机只有 3 个应用进过这份实测：ChatGPT / OpenCode / 抖音。
2. **包结构（强）**：Contents/Frameworks 里有 Electron Framework.framework（或同构的改名框架，如 Codex Framework、QQNT.framework）+ Contents/Resources 里有 app.asar + Contents/Frameworks 里有 *Helper (GPU/Renderer/Plugin).app。这三样同时出现基本可以确定是 Electron/Chromium 多进程架构。
3. **二进制字符串（中）**：framework 二进制里能搜到 remote-debugging-port、DevToolsActivePort、remote-debugging-pipe。搜到只说明「这个开关的代码在」，不代表应用会尊重它（见 OpenCode/抖音）。
4. **链接关系（弱）**：otool -L 主二进制是否链接 Electron/Chromium framework。

本次盘点的具体命令（全部只读）：

~~~bash
# 包结构
ls "/Applications/<App>.app/Contents/Frameworks"
ls "/Applications/<App>.app/Contents/Resources/app.asar"
# framework 版本
/usr/libexec/PlistBuddy -c "Print :CFBundleVersion" \
  "/Applications/<App>.app/Contents/Frameworks/Electron Framework.framework/Resources/Info.plist"
# 调试串与版本
strings -a "<framework 二进制>" | grep -E "remote-debugging-port|DevToolsActivePort|Electron/|Chrome/"
# 链接关系
otool -L "/Applications/<App>.app/Contents/MacOS/<exe>"
# 沙盒/签名
codesign -d --entitlements :- "/Applications/<App>.app"
~~~

实测结果（Electron 系 6 个 + Chrome）：

| 应用 | Electron Framework 版本 | 二进制里的 Chrome 版本 | app.asar | Helper | 三个调试串 | 沙盒 |
| --- | --- | --- | --- | --- | --- | --- |
| Antigravity | 44.4.3 | Chrome/152.0.7977.130 | 4.3MB | 有（GPU/Renderer/Plugin） | 全有 | 否 |
| ChatGPT | Codex Framework 157.0.8103.39 | Chrome/157.0.8103.39（/json/version 实测） | 726MB | 有（Renderer/GPU/Service/Alerts…） | 全有 | 否 |
| DeepSeek Harness | 44.7.0 | Chrome/152.0.7977.130 | 203MB | 有 | 全有 | 否 |
| OpenCode | 44.4.5 | Chrome/152.0.7977.130 | 168MB | 有 | 全有 | 否 |
| 抖音 | 36.4.0-rs.30（字节定制） | Chrome/136.0.7103.59 | 6.9MB | 有 | 全有 | 是（App Store） |
| QQ | 40.0.0（QQNT.framework） | Chrome/144.0.7559.60 | Resources/app/application.asar | 有 | remote-debugging-port 有，DevToolsActivePort 未搜到 | 是（App Store） |
| Google Chrome | —（原生 Chromium） | Chrome/156.0.8078.80 | 无 | — | remote-debugging-port / DevToolsActivePort / remote-allow-origins 都有 | 否 |

> 说明：ChatGPT 的 framework 里没有 Electron/x.y.z 字样（它在自己的 fork 里改名/裁剪了），但 DevTools 三件套齐全，且 /json/version 实测返回 Chrome/157.0.8103.39 —— 以实测为准。

## 3. AX 对照：为什么 CDP 对其中几个应用特别重要

把 reports/app-matrix-*.json 的历史最佳读数拉出来对照（AX 读得到多少，决定 CDP 值不值得做）：

| 应用 | AX 节点 | AX 按钮 | AX 输入区 | 说明 |
| --- | --- | --- | --- | --- |
| Antigravity | 0 | 0 | 0 | 启动后等 13.6s 仍无窗口/无树；CDP 是唯一可能的高层通道 |
| 抖音 | 0 | 0 | 0 | 同上；CDP 实测也没通，目前两条路都断 |
| OpenCode | 未测 | — | — | 从未进过 app-matrix |
| ChatGPT | 132 | 44 | 1 | AX 可读，但 reports 之间差异极大（inventory 记 13 节点/3 按钮）；读数随版本/时机波动 |
| QQ | 125 | 20 | 0 | AX 够用，CDP 是备选 |
| Telegram | 26 | 0 | 0 | 只有窗口壳；CDP 不支持，只能坐标兜底 |
| WeChat | 20 | 7 | 0 | 同上 |

结论：**AX 节点为 0 的 Antigravity / 抖音**最需要 CDP；QQ/ChatGPT 目前 AX 尚可读，CDP 属于「更稳的备选」。ChatGPT 的 AX 数字在 reports 之间差 10 倍，说明 AX 通道本身不稳定，这也是它历史上最终选 CDP 的原因。

## 4. 对用户的影响评估（统一风险清单）

1. **必须重启应用**：所有 Electron/Chromium 应用都只认启动参数；macOS 单实例锁意味着第二个实例会把参数转交后自己退出（本仓库在 overlay 上实测过「带端口的第二个实例被忽略」）。
2. **启动会抢前台**：ChatGPT 历史实测多次 frontStolen=true（有几次退出后恢复，最后一次 frontUnchanged）；对「用户正在电脑前」的场景，这一点必须提前告知。
3. **未保存内容风险**：IDE（Antigravity/OpenCode）、聊天客户端（QQ/抖音）重启可能丢草稿/工作区。
4. **端口无鉴权**：CDP 端口一旦存在，本机任何进程都能连上执行 JS。只绑 127.0.0.1、用非默认端口、用完立即退出应用；不要把端口暴露到 0.0.0.0。
5. **App Store 沙盒**：抖音、QQ 是沙盒应用（都有 network.server 权限，理论上能绑回环端口），但沙盒 + 参数过滤可能解释「端口起不来」；需要实测确认。
6. **用户正在运行的应用不要碰**：当前运行中的有 DeepSeek Harness（宿主，分析时 pid 94953）和 Google Chrome（pid 660）。前者绝对不能重启；后者只允许开独立 profile 实例。
7. **不碰账号数据**：只读 DOM / evaluate 不会改账号，但任何 click/输入都应视为写操作；本次盘点没有执行任何 CDP 动作。

## 5. 下一步值得实测的 1-2 个应用

### 5.1 首选：OpenCode（信息价值最高）

**为什么**：静态证据完整（Electron 44.4.5、Chrome 152、三个调试串齐全、非沙盒），但历史上 10 次实测全部端口没起来。这是「静态说支持、实际不生效」的唯一样本，搞清楚原因能直接回答「第三方 Electron 都能接吗」。

**建议的排查顺序（先只读）**：

1. 记录当前是否运行（本机现在没运行）。
2. 退出后 open -g -n -b ai.opencode.desktop --args --remote-debugging-port=9349，立刻用 ps -axo pid,command 看**真实 Electron 主进程的 argv 里有没有这个 flag**。
3. 若 argv 里没有 → 应用/启动器吃掉了参数，改直接执行 /Applications/OpenCode.app/Contents/MacOS/OpenCode --remote-debugging-port=9349 再试。
4. 若 argv 里有但端口没起 → 应用内部清掉了开关（或 userData 被重定向），改试 --remote-debugging-port=0 后去 ~/Library/Application Support/OpenCode/DevToolsActivePort 找端口。
5. 全程记录 frontmost，收尾用 quit。

**预期产出**：要么拿到 cdp-ok（OpenCode 可进 ① 档），要么明确「应用侧改写/清除参数」，这个结论对其它第三方 Electron 都适用。

### 5.2 次选：Antigravity（零历史实测）

**为什么**：Electron 44.4.3、非沙盒、有完整 Helper 进程；AX 只有 0 节点，CDP 是唯一可能的高级控制通道；从未进过 cdp-driver 实测。

**建议流程**：退出 → open -g -n -b com.google.antigravity --args --remote-debugging-port=9341 → 轮询 curl 127.0.0.1:9341/json/version → listTargets + Runtime.evaluate document.title → 记录 frontmost → quit。风险是 IDE 可能有未保存工作区，测试前应让用户确认。

**暂不建议**：抖音（App Store 沙盒 + 登录态，收益低）、QQ（AX 已可读，CDP 收益一般）、DeepSeek Harness（宿主，禁止）。

## 6. 复现本报告（只读）

~~~bash
cd dsh-rig
# 1) 已有的 CDP 实测结论
ls reports/cdp-driver-*.json
# 2) AX 对照
ls reports/app-matrix-*.json
# 3) 包结构
ls /Applications/*.app/Contents/Frameworks 2>/dev/null
# 4) 调试串（以 Antigravity 为例）
strings -a "/Applications/Antigravity.app/Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework" \
  | grep -E "remote-debugging-port|DevToolsActivePort"
~~~

## 7. 边界与未验证项

- 只扫了 /Applications（含 Utilities）；~/Applications 只有两个游戏，未展开分析；/System/Applications 全是原生应用，不在范围。
- **没有启动任何应用**，所以第 ② 档的结论只有静态证据，没有运行时验证；「应用是否尊重参数」只能引用历史实测。
- Google Chrome「136+ 默认 profile 开远程调试受限」是 Chromium 上游策略，本机未实测（禁止启动），写进建议时已标注为「需独立 profile，未验证」。
- 没有检查 Electron fuses（ELECTRON_FUSES）；fuses 里与调试相关的是 Node CLI inspect，不影响 --remote-debugging-port，但不同发行版是否裁剪 DevTools 未逐一验证。
- reports 之间 ChatGPT 的 AX 节点数（132 vs 13）和 CDP 成功率（2/10 cdp-ok，其余多为读取中断）存在波动，说明「同一个应用不同版本/不同时机结果不同」，本报告按最新一次实测（2026-11-07T21:13）记结论。
- 所有路径、字符串和 JSON 结论均来自本机当前文件；应用升级后需要重跑第 6 节的只读命令复核。