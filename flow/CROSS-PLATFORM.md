# 跨平台适配（macOS / Windows）

> 目标：同一套框架，macOS 和 Windows 都能跑。当前状态见下表。

## 分层现状

| 层 | macOS | Windows | 状态 |
| --- | --- | --- | --- |
| 展示（小窗） | Electron + screencapture | Electron + PrintWindow | ✅ 已抽象，Windows 侧未实机验证 |
| 前台/窗口信息 | osascript | PowerShell + User32 | ✅ 已抽象，Windows 侧未实机验证 |
| 控制（点击/读界面） | ocu（Accessibility） | UI Automation（未实现） | ❌ 待实现 |
| 后台输入 | sky_key | SendMessage(WM_CHAR) / SendInput | ❌ 待实现 |
| 浏览器 | 离屏 Chrome + CDP | 同样可用（Chrome 跨平台） | ✅ 逻辑通用 |
| 常驻服务 | launchd | 任务计划程序 schtasks | ⏳ 需补安装脚本 |

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

## Windows 上还缺什么

### 1. 控制后端（最关键）

ocu 只支持 macOS。Windows 需要等价物：读 UI 树 + 语义点击。推荐路径：

```powershell
Add-Type -AssemblyName UIAutomationClient
$root = [System.Windows.Automation.AutomationElement]::RootElement
# 遍历 FindAll(TreeScope.Descendants, Condition.TrueCondition) 拿控件树
# 点击：InvokePattern / TogglePattern / SelectionItemPattern
```

需要封装成和 ocu 同形的接口：`getApp / getAXState / click / typeText / pressKey`，这样任务层不用改。

### 2. 后台输入

`sky_key` 是 macOS 私有能力。Windows 两条路：

- `PostMessage(hwnd, WM_CHAR, ...)`：不抢焦点，但部分应用不认
- `SendInput`：兼容性好，但会占用真实输入，前台会被打扰

优先 PostMessage，失败再退回 SendInput，并在文档里标明局限。

### 3. 服务自启

```powershell
schtasks /Create /TN desktop-agent /TR "node C:\path\core\daemon.mjs" /SC ONLOGON
```

## 验证方式

macOS：

```bash
npm run accept
```

Windows（待补）：

```powershell
node core\platform-smoke.mjs   # 检查 PrintWindow / UIA 可用性
```

## 诚实说明

Windows 分支代码是照着 Win32 API 写的，**没有在真实 Windows 上跑过**。当前开发机是 macOS 26.5.1，无法验证。
首次在 Windows 上使用时，预期需要调试：窗口句柄获取、PrintWindow 对 Chromium 的兼容性（可能需要换成 `BitBlt` 或 DWM 截图）、UIA 树深度与性能。
