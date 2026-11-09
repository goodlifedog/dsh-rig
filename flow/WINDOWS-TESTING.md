# Windows 首次运行检查清单

> 仓库里的 Windows 分支是照 Win32 API 写的，**没有在真实 Windows 上跑过**。第一次跑请按这份清单逐项确认，出问题按最后一节反馈。

## 0. 前置

- Windows 10/11，已装 Node.js 20+、Git
- PowerShell 5.1+（系统自带）
- 屏幕缩放如果是 125%/150%，打印分辨率会按缩放后的像素算，属正常

## 1. 自检

```powershell
node core\platform-smoke.mjs
```

预期：平台=win32、控制后端=uia、UIA 桥脚本存在、**UIA 自检通过**、数据目录可写。

UIA 自检失败时，可以单独跑一次看细节：

```powershell
powershell -File tools\uia-bridge.ps1 selftest
```

它会逐项报告：PowerShell 版本、UIAutomationClient/Types 程序集、能否读桌面根元素、能否枚举窗口进程、System.Drawing 是否可用。
两个服务显示未启动是正常的（还没装）。

## 2. 依赖与小窗

```powershell
npm install
cd overlay; npm install; cd ..
npm run overlay
```

预期：出现一个小窗。控制台若报 `PrintWindow 失败`，见第 5 节。

## 3. 服务安装

```powershell
npm run service:install
schtasks /Query /TN dsh-rig-daemon
```

预期：两个计划任务创建成功，`ONLOGON` 触发。

## 4. UIA 控制

```powershell
powershell -File tools\uia-bridge.ps1 snapshot -Process notepad
```

预期：返回 JSON，elements 里有记事本的菜单/文本区。
若报「拿不到应用根元素」，多半是权限问题——用管理员 PowerShell 再试。

## 5. 已知高风险点

| 位置 | 风险 | 处理 |
| --- | --- | --- |
| `PrintWindow` 抓 Chromium 窗口 | 可能全黑 | 改用 `BitBlt` 或 DWM 缩略图方案 |
| `PostMessage(WM_CHAR)` 输入 | 部分应用不认（尤其 Electron/UWP） | 退回 `SendInput`，但会占用真实输入 |
| UIA 树深度 | 大应用遍历慢 | 加 `TreeScope.Children` 逐层展开，或限制深度 |
| HWND 反查标题 | 标题带特殊字符时匹配失败 | 把标题截断到前 20 字再匹配 |
| 窗口坐标 | 多显示器 + DPI 缩放下可能偏移 | 调用 `SetProcessDpiAwareness` |

## 6. 反馈方式

把这三样贴进 issue：

1. `node core\platform-smoke.mjs` 的完整输出
2. 失败那一步的完整报错（含 PowerShell 原文）
3. `Get-ComputerInfo | Select WindowsProductName,OsVersion` 的结果