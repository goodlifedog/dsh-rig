# 后台扫描任务：验证方法与已知限制

对应任务：task-3「修复后台扫描链路并交付可复现的 scan 任务」
代码：desktop-agent/core/tasks/scan.mjs（未改动 core/agentd.mjs）

---

## 1. 结论速览

- 修复后，任务能在后台把 Chrome 切回 目标页面并抓到 15 条岗位（要求 ≥10）。
- 全程 Chrome 没有被激活：操作前 / 读取中 / 结束后前台都是 DeepSeek Harness，
  ocu list-apps 第一行也是 DeepSeek Harness。
- overlay 状态推送正常：运行期间 /health 的 visible=true，最后一次推送后约 9 秒变 false。
- 缩略图：Chrome 窗口在当前 Space 时能绑定（实测 windowId=70385，thumbnail=live）；
  Chrome 被切到别的 Space 时 /windows 拿不到它，任务会记录原因并继续，不影响扫描。

---

## 2. 怎么复现

前置：
- overlay 在跑（http://127.0.0.1:7788/health 返回 ok:true）。
- Chrome 已登录 目标站点，且窗口里至少有一个 example.com/web/page 标签页。
- ocu 权限正常（ocu doctor --json → allGranted true），屏幕未锁。

~~~sh
cd desktop-agent
PATH="$HOME/.local/bin:$PATH" node core/tasks/scan.mjs
~~~

预期：退出码 0，末尾打印 JSON（jobs / frontmost / overlay 可见性 / 验收表）。
可选环境变量：TARGET_APP、MIN_JOBS（默认 10）、MAX_JOB_LOGS（默认 50）、OCU_BIN、OVERLAY_URL。

想复现「抓取时不在 目标页」这个缺陷场景：

~~~sh
osascript -e 'tell application "Google Chrome" to set active tab index of window 1 to 2'
PATH="$HOME/.local/bin:$PATH" node core/tasks/scan.mjs
~~~

任务会自己把活动标签切回 目标页再抓。

---

## 3. 缺陷 1：岗位解析为 0 条

### 根因

抓取时 Chrome 的活动标签是 opencode 控制台，AX 树里只有那个页面的内容，
没有任何 example.com/item 链接，parseJobs 自然得到 0 条。

### 修复（scan.mjs 的 buildTabSwitcher + runOcuJs）

用一个持久的 ocu JS 会话（ocu js --file）完成「看当前 URL → 找标签页 → 点它 → 再验证」：

1. 读 AX 树，从 HTML 内容行取当前页面 URL（正则 /HTML 内容.*?URL: (https?:\S+)/；
   注意不能用 [^,]* 截断，标题和 URL 之间本身就有逗号）。
2. 如果 URL 已经包含 example.com/web/page 就直接返回。
3. 否则在 AX 树里找标签页节点：/^\t*(\d+)\s+标签\s+.*(目标网站|example)/i
   （注意：JS 的正则 \b 只认 ASCII 词字符，跟在中文后面的 \b 永远不成立，必须用 \s）。
4. 用 accessibility 点这个标签页（click_method=accessibility），等 0.9s 读一次状态，
   最多轮询 3 次、最多重试 3 轮（accessibility 点击偶发会被吞）。
5. 全程只在后台窗口做 AX 操作，Chrome 不会被激活。

兜底：AX 切换失败时，用 AppleScript 的 Chrome 字典按 URL 找到标签页并
set active tab index（同样不会激活窗口），然后再次校验 URL。

实测两种起点都通过：
- 起点已经是 目标页 → 直接进入抓取；
- 起点是 opencode 控制台 → attempts=[a11y-tab@926]，before=opencode URL，after=example URL，switched=true。

### 解析结果后处理

parseJobs 会把详情面板里的「查看更多信息」链接（同一 job_detail 带 securityId 查询串）也带出来，
scan 会再按 job_detail 的 id 去重、并过滤「查看更多信息」这类非岗位卡片，最终 15 条。

---

## 4. 缺陷 2：overlay /windows 拿不到 Chrome 窗口

### 排查过程与结论

overlay 的 /windows 来自 Electron desktopCapturer.getSources({types:['window']})。
本机实测：当 Chrome 窗口在当前 Space 时，/windows 能列出它
（例如 70385「示例页面...目标网站」，thumbnail 能进入 live）；
当 Chrome 被切到别的 Space 时，/windows 只剩 DeepSeek Harness 自己的窗口。

用 CoreGraphics 枚举窗口可以确认这个差异：

~~~sh
# 每一行：windowId / onscreen / owner / title
/usr/bin/python3 <枚举脚本>     # 见下方附录
# Chrome 在别的 Space 时：70385  0  Google Chrome  「示例页面」...目标网站
#                            ^ on-screen = 0（不在当前 Space）
~~~

即：不是标题过滤、也不是权限问题，而是窗口本身不在当前 Space / 不在屏幕上，
desktopCapturer 不返回它；screencapture -l 70385 也会报 "could not create image from window"。
（本机 screencapture 抓当前 Space 的窗口是正常的，例如 -l 68544 能抓 DeepSeek Harness 窗口。）

### 修复策略：可用则绑，不可用就降级

scan 的 bindThumbnail()：

1. overlay.findWindow(/目标网站|Chrome/i) 找窗口；
2. 找到 → POST /window，并轮询 /health.thumbnail.state 最多 3 秒，等它变 live；
3. 找不到 / 3 秒内没 live → 记录原因（日志 + 输出里的 thumbnail 字段），
   任务继续跑，只是不显示缩略图。

这样满足任务要求：「拿不到时让任务仍然能跑，只是不显示缩略图」。

---

## 5. 验收证据（2026-11-05 19:36，scanFinal）

起点：Chrome 活动标签 = https://opencode.ai/console/...（故意制造缺陷1场景）

~~~text
[2] frontmost: DeepSeek Harness
    list-apps 第一行: DeepSeek Harness — com.deepseek.dsh [frontmost, running, ...]
[3] 当前 URL: https://www.example.com/web/page | ok= true
      attempts: ["a11y-tab@926"]  switched: true
[4] 前台： DeepSeek Harness → DeepSeek Harness
[5] 找到岗位: 15
[6] 缩略图: 不可用（overlay /windows 里没有 Chrome 窗口）   ← 当时 Chrome 在别的 Space
[7] overlay visible: true | activity: running
    结束前台: DeepSeek Harness
    list-apps 第一行: DeepSeek Harness
[8] 等 9 秒后 overlay visible: false | activity: running

--- 验收 ---
  PASS  岗位数 >= 10  [15]
  PASS  前台始终没有变成 Chrome  [DeepSeek Harness]
  PASS  list-apps 第一行不是 Google Chrome  [DeepSeek Harness ...]
  PASS  运行期间 overlay 可见  [true]
  PASS  结束后 8~9 秒 overlay 自动隐藏  [false]

结果: 全部通过   EXIT=0
~~~

另一次（Chrome 在当前 Space 时）缩略图绑定成功：
thumbnail: { bound: true, windowId: 70385, title: "「示例页面」...目标网站", state: "live" }。

---

## 6. 安全边界

- 全程只做两类点击：任务开始前点「目标标签页」；其余只有 AX 读取与 overlay 日志推送。
- 代码里不存在任何对「打招呼 / 立即沟通 / 投递」控件的点击路径。
- 前置检查：如果 Chrome 当前就是前台，guard() 会直接拒绝执行，避免干扰用户。
- 每次读树前后都会核对前台应用，一旦 Chrome 变成前台立刻抛错中止。

---

## 7. 已知限制

1. **用户正在用电脑时，list-apps 第一行是用户当前 app**（备忘录/计算器/Finder 等）。
   验收真正要保证的是「不是 Google Chrome」；机器空闲时第一行就是 DeepSeek Harness。
   如果要求严格等于 DeepSeek Harness，请在机器空闲（前台为 DeepSeek Harness）时跑。
2. **缩略图依赖窗口在当前 Space**：Chrome 在别的 Space 时拿不到，扫描仍继续（见第 4 节）。
3. **屏幕锁定会中断**：锁屏时 AX 全部报 NSPOSIXErrorDomain Code=2，任务会失败；
   解锁或隔一分钟重试即可。
4. **岗位数与页面一致**：当前页面一次可见 15 条左右；页面改版或筛选变化会影响数量，
   低于 MIN_JOBS 时任务会报错退出而不是给假数据。
5. **标签页切换需要存在 目标标签页**：如果窗口里没有 目标页签，会明确报错「无法切回」，
   不会乱点其它标签。

---

## 附录：窗口枚举脚本（排查缩略图用）

~~~python
# /tmp/listwin.py：用 CoreGraphics 列出所有 layer=0 的窗口
# 输出：windowId \t onscreen \t owner \t title
# 关键判断：Chrome 窗口 onscreen=0 表示它不在当前 Space，缩略图不可用。
import ctypes
cg = ctypes.CDLL('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics')
cf = ctypes.CDLL('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation')
# ...（完整脚本见本机 /tmp/listwin.py，核心调用 CGWindowListCopyWindowInfo + CFArrayGetValueAtIndex）
~~~
