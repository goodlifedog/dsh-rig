# macOS 应用 AX 覆盖率报告

探测脚本：desktop-agent/core/tasks/coverage-probe.mjs
探测时间：2026-11-05 22:00（本机 macOS 26.5.1，ocu 1.1.3，树预算 6000 节点）
原始 JSON：/tmp/coverage-latest.json（脚本输出），原始快照：/tmp/coverage-raw/

---

## 1. 结论速览

本轮探测了 12 个正在运行的应用（覆盖任务要求的微信 / 系统设置 / App Store / 备忘录 / 访达 / Safari，另加 Chrome、DeepSeek Harness、计算器、Clash Verge、Telegram、Electron overlay）。
另有 2 个目标（终端、iTerm2）未运行，未测。

| 分档 | 数量 | 应用 |
| --- | --- | --- |
| 可用 | 6 | 系统设置、App Store、访达、Google Chrome、DeepSeek Harness、Clash Verge |
| 勉强可用 | 6 | 微信、备忘录、Safari、计算器、Telegram、Electron(overlay) |
| 不可用 | 0（本轮） | — |
| 未测（未运行） | 2 | 终端、iTerm2 |

一句话结论：

- **原生 App（系统设置/App Store/访达/备忘录/计算器）AX 都很完整**，能直接读到按钮、文本栏、弹出按钮等。
- **Chromium 系（Chrome / DSH / Clash / overlay）也都能读**，只是 AX role 是英文（button / text field / toggle），解析要中英双语兼容。
- **Safari 只能读到浏览器壳**（地址栏、工具栏），网页内容不在 AX 树里。
- **微信/Telegram 这类 IM 的窗口壳可读，但控件很少**（微信当前停在登录页，只有「进入微信/切换账号/仅传输文件」等按钮）。

---

## 2. 覆盖率表

| 应用 | bundle id | 分档 | 节点 | 可交互 | 窗口标题 | 典型控件例子 |
| --- | --- | --- | --- | --- | --- | --- |
| 系统设置 | com.apple.systempreferences | 可用 | 96 | 45 | 通知 | 搜索文本栏（Placeholder: 搜索）、按钮 搜索、弹出式按钮 show-previews |
| App Store | com.apple.AppStore | 可用 | 162 | 75 | App Store | 搜索文本栏、按钮 搜索、按钮 探索 |
| 访达 | com.apple.finder | 可用 | 77 | 22 | iCloud云盘 | 按钮 返回、按钮 前进(disabled)、按钮 新建文件夹 |
| Google Chrome | com.google.Chrome | 可用 | 946 | 114 | 模型 & 价格 \| DeepSeek API Docs | 按钮 返回/重新加载、地址栏、55 个 link |
| DeepSeek Harness | com.deepseek.dsh | 可用 | 732 | 237 | 规划布局探讨 | button 收起侧边栏 / 新建会话 / 插件，18 个 toggle |
| Clash Verge | io.github.clash-verge-rev.clash-verge-rev | 可用 | 65 | 45 | Clash Verge | button 首页 / 代理 / 订阅 |
| 微信 | com.tencent.xinWeChat | 勉强可用 | 20 | 7 | 微信（登录页） | 按钮 进入微信 / 切换账号 / 仅传输文件 |
| 备忘录 | com.apple.Notes | 勉强可用 | 46 | 15 | 备忘录 | 文本输入区 Note Body Text View、按钮 添加文件夹 |
| Safari | com.apple.Safari | 勉强可用 | 32 | 12 | OCU Form Write Test | 按钮 显示边栏、标签页组选择器、返回(disabled) |
| 计算器 | com.apple.calculator | 勉强可用 | 39 | 25 | 计算器 | 按钮 全部清除 / 删除 / 百分比 |
| Telegram | ru.keepcoder.Telegram | 勉强可用 | 20 | 11 | Telegram @ good | button Contacts / Add Contact、search text field |
| Electron(overlay) | com.github.Electron | 勉强可用 | 122 | 2 | Desktop Agent | 按钮 关闭、按钮 状态（其余多为容器/文本） |
| 终端 | com.apple.Terminal | 未测 | — | — | — | 未运行 |
| iTerm2 | com.googlecode.iterm2 | 未测 | — | — | — | 未运行 |

---

## 3. 分级规则

脚本按「节点数 + 可交互控件数」自动分档（阈值在脚本里可改）：

- 可用：节点 ≥ 60 且 可交互 ≥ 10
- 勉强可用：节点 ≥ 15 且 可交互 ≥ 2，但没到「可用」标准
- 不可用：节点 < 15 或 可交互 < 2，或直接报错
- 未测：应用未运行（见第 5 节的副作用说明）

可交互角色识别同时兼容中英文 role：按钮/文本栏/复选框/弹出式按钮/菜单项/文本输入区/列表框/滑块/单选框/开关/link，
以及 button / text field / text area / check box / pop up button / menu item / list box / toggle / tab / combo box / search field 等。

---

## 4. 读操作验证（只读，不改状态）

脚本对每个应用做的是纯读取：

1. 读窗口标题（上表「窗口标题」列全部来自 AX 的 Window 行）；
2. 枚举并统计节点、可交互控件；
3. 抓 1~3 个具体控件作为「能定位到有意义控件」的证据（上表最后一列）。

全程没有点击任何控件，没有改任何应用数据。

---

## 5. 失败模式与不可读原因

### 5.1 本轮实际遇到的

- **未运行**：终端、iTerm2 没有启动，脚本跳过（原因见 5.2）。
- **节点过少**：微信 20 节点 / 7 可交互（停在登录页）；Telegram 20 / 11。分档为「勉强可用」，
  能读窗口壳和少量按钮，但列表/聊天内容读不到。
- **只有浏览器壳**：Safari 32 节点 / 12 可交互，全部是地址栏/工具栏；网页内容不在 AX 树里。
  （对比 Chrome 的同一个 file:// 页面：Chrome 能读到完整网页表单。）
- **overlay 窗口隐藏时 cgWindowNotFound**：不是本轮表格里的那一行（本轮它刚好可见，读到 122 节点/2 可交互）；
  在早前实验里，Electron overlay 窗口隐藏/不在当前 Space 时，ocu 会报
  cgWindowNotFound（应用在跑但没有可读窗口）。

### 5.2 重要副作用：snapshot 未运行的应用会把它启动起来

实测：对未运行的微信 / App Store 执行 ocu snapshot，**应用被拉起**（进程出现在 pgrep 里，
WeChat pid 18425、App Store pid 18444），并不是只读失败。

因此脚本默认只探测 ocu list-apps 里标记为 running 的应用；未运行的直接标「未测」，
避免探测动作本身打扰用户。如果确实要覆盖未运行应用，请手动先打开它。

### 5.3 其它已知失败原因（脚本会归类）

- appNotFound：bundle id 不对 / 应用未安装 / 无法绑定；
- cgWindowNotFound：应用在跑但没有可读窗口（窗口隐藏、在别的 Space、尚未创建）；
- NSPOSIXErrorDomain Code=2：屏幕锁定，AX 全部不可用（锁屏时所有应用都会落到这一条）；
- 节点过少：能连上但没有有效 AX 树（常见于登录页、纯自绘 UI）。

---

## 6. 建议：哪些走 AX、哪些走 CDP、哪些只能坐标兜底

| 应用类型 | 建议 |
| --- | --- |
| 原生 App（系统设置、App Store、访达、备忘录、计算器） | **直接走 AX**。节点多、role 本地化中文、控件可精确定位，后台可读写。 |
| Chromium 系（Chrome、DSH、Clash、overlay） | **AX 可用**（英文 role）。网页内容多、要注入 JS/读 DOM 时走 CDP 更稳（见 CDP-FALLBACK.md）。 |
| Safari | AX 只能操作浏览器壳；网页内容必须走 CDP/AppleScript（Safari 的 AX 网页内容后台不暴露）。 |
| 微信 / Telegram | AX 只覆盖窗口壳。要操作聊天/列表，优先坐标 + 截图兜底，或应用内快捷键；不建议依赖 AX 深度。 |
| 终端 / iTerm2 | 未测。若要做命令执行，直接 shell 更合适；AX 只用于读窗口文本。 |
| 锁屏时 | 所有 AX 都不可用，先解锁或改用其它通道。 |

---

## 7. 复现方法

~~~sh
cd desktop-agent
PATH="$HOME/.local/bin:$PATH" node core/tasks/coverage-probe.mjs
~~~

输出：终端表格 + JSON 文件（默认 /tmp/coverage-latest.json）+ 每个应用的原始 AX 快照
（默认 /tmp/coverage-raw/<bundle>.txt）。

可用环境变量：

- COVERAGE_NODES：树预算，默认 6000
- COVERAGE_JSON：JSON 输出路径
- COVERAGE_RAW_DIR：原始快照目录
- OCU_BIN：ocu 路径

---

## 8. 已知限制

1. **只覆盖正在运行的应用**：未运行的会跳过（见 5.2 的副作用）。
2. **浏览器只读当前活动标签页**：Chrome/Safari 的 AX 树只包含活动 tab 的页面内容；
   要覆盖多个标签页需要先切换（后台切标签页的方法见 RECIPE.md）。
3. **role 名称本地化不一致**：同一台机器上中文应用用中文 role、Electron/英文应用用英文 role，
   统计脚本必须中英双语匹配，否则会把「有按钮」误判成「0 可交互」。
4. **树预算会截断**：超大页面把 max-tree-nodes 调大后节点数会变；本表统一 6000。
5. **窗口在别的 Space / 隐藏时**会报 cgWindowNotFound，属于环境问题不是应用问题。
6. 本轮微信停在登录页，**登录后控件数量会明显增加**，建议登录后再复测一次。
