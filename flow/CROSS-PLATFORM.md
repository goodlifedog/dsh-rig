# 跨平台适配（macOS / Windows）

> 目标：同一套框架，macOS 和 Windows 都能跑。当前状态见下表。

## 分层现状

| 层 | macOS | Windows | 状态 |
| --- | --- | --- | --- |
| 展示（小窗） | Electron + screencapture | Electron + PrintWindow | ✅ 已抽象，Windows 侧未实机验证 |
| 前台/窗口信息 | osascript | PowerShell + User32 | ✅ 已抽象，Windows 侧未实机验证 |
| 控制（点击/读界面） | ocu（Accessibility） | **ocu 官方同样支持 Windows**（dist/windows 有原生运行时） | ✅ 同一后端 |
| 后台输入 | sky_key（私有 SkyLight） | ocu 的窗口消息投递；UIA 桥的 PostMessage 作为兜底 | ✅ |
| 浏览器 | 离屏 Chrome + CDP | 同样可用（Chrome 跨平台） | ✅ 逻辑通用 |
| 常驻服务 | launchd | 任务计划程序 schtasks | ✅ core/service.mjs 已支持两边 |

## 已经做完的抽象

**overlay/platform.js**（CommonJS）

```js
const { isMac, isWindows, readFrontmostApp, readWindowBounds, readWindowTitle, captureWindow } = require('./platform');
```

- macOS：osascript 取前台/窗口，screencapture 按窗口抓图
- Windows：PowerShell 调 User32 取前台/窗口矩形，PrintWindow 抓图

**core/platform.mjs**（ESM）

```js
import { controlBackend, requireOcu, dataDir, runPowerShell } from './platform.mjs';
```

## 一条命令验证控制通路

```bash
npm run demo:platform        # macOS 读 Chrome 的 AX 树；Windows 读记事本的 UIA 树
```

这是跨平台控制层的冒烟测试：同一份任务代码，macOS 走 ocu、Windows 走 UIA，输出格式一致。

## Windows 上还缺什么

### 1. 控制后端（最关键）

**更正**：ocu 官方支持 macOS / Windows / Linux，安装包里 `dist/windows/{amd64,arm64}` 就是 Windows 原生运行时。所以 Windows 应该优先用 ocu，而不是自研。

已保留的自研部分：`tools/uia-bridge.ps1` + `core/backends/uia.mjs`，作为没有 ocu 时的兜底方案。，提供 snapshot / click / type / key 四个动作，接口形状对齐 ocu：

```js
import * as uia from './core/backends/uia.mjs';
const app = await uia.getApp('notepad');
await app.getAXState();
await app.click(3);
```

底层实现：

```powershell
Add-Type -AssemblyName UIAutomationClient
$root = [System.Windows.Automation.AutomationElement]::RootElement
# 遍历 FindAll(TreeScope.Descendants, Condition.TrueCondition) 拿控件树
# 点击：InvokePattern -> SelectionItemPattern -> 聚焦+回车 三级兜底
# 输入：PostMessage(WM_CHAR) 逐字符，不抢焦点
```

需要封装成和 ocu 同形的接口：`getApp / getAXState / click / typeText / pressKey`，这样任务层不用改。

### 2. 后台输入

`sky_key` 是 macOS 私有能力。Windows 两条路：

- `PostMessage(hwnd, WM_CHAR, ...)`：不抢焦点，但部分应用不认
- `SendInput`：兼容性好，但会占用真实输入，前台会被打扰

优先 PostMessage，失败再退回 SendInput，并在文档里标明局限。

### 3. 服务自启（已实现）

```bash
node core/service.mjs install    # macOS 写 launchd，Windows 建计划任务
node core/service.mjs uninstall
```

Windows 侧用 `schtasks /SC ONLOGON`，等价于 macOS 的 RunAtLoad。

## 验证方式

macOS：

```bash
npm run accept
```

Windows（待补）：

```powershell
node core\platform-smoke.mjs   # 检查 PrintWindow / UIA 可用性
```

## Windows 抓图的关键坑：窗口句柄

macOS 的 `screencapture -l` 直接吃 desktopCapturer 给的窗口序号，Windows 的 `PrintWindow` 要的是 HWND，两者不是一回事。

现在的处理：`POST /window` 支持同时传 `title`，Windows 侧用 `Get-Process | Where MainWindowTitle -like` 反查出真正的 HWND；传不了标题时才退回把序号当 HWND 用（大概率失败）。

调用方（agentd/任务）在 Windows 上应带上标题：

```js
await fetch('http://127.0.0.1:7788/window', {
  method: 'POST',
  body: JSON.stringify({ windowId, title: 'BOSS直聘 - Google Chrome' }),
});
```

## 诚实说明

Windows 分支代码是照着 Win32 API 写的，**没有在真实 Windows 上跑过**。当前开发机是 macOS 26.5.1，无法验证。
首次在 Windows 上使用时，预期需要调试：窗口句柄获取、PrintWindow 对 Chromium 的兼容性（可能需要换成 `BitBlt` 或 DWM 截图）、UIA 树深度与性能。
