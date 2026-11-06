# ocu 后台操作配方（macOS + Chrome）

> 目标：在不抢焦点、不移动真实鼠标的前提下，操作后台 Chrome 里的网页（读 AX 树、点元素、填输入框），
> 并且能用客观证据证明「页面真的变了」且「Chrome 没有被激活」。
>
> 适用：ocu 1.1.3 / macOS 26.5.1 (arm64) / Google Chrome 156。
> 本文结论全部来自 2026-11-05 的本机实测，未验证的部分会明确标注「未验证」。

---

## 0. 一句话配方

用 **ocu 的持久 JS 会话**（ocu js --file）在一次原生会话里完成
「getAXState → 正则解析元素 index → click click_method=accessibility → 等待 → getAXState 校验」，
前后用 **System Events 读真实前台应用**确认不是 Chrome。
坐标点击只在元素点击不奏效时用 **sky_click**（且必须先在同一会话里取过截图）。

---

## 1. 环境与前置检查

ocu 本体：

~~~sh
~/.local/bin/ocu --version          # 1.1.3
~/.local/bin/ocu doctor --json      # {"accessibilityTrusted":true,"allGranted":true,...}
~~~

动手前必须确认两件事，否则后面所有 AX 操作都会失败：

1. **屏幕没有锁**（这是最大的坑，见第 8 节）。
2. Chrome 正在运行，且目标页面已登录、已加载。

~~~sh
# 锁屏状态：<true/> 表示已锁屏
ioreg -n Root -d1 -a | grep -A1 CGSSessionScreenIsLocked
~~~

---

## 2. 元素定位：index 是什么、能用多久

### 2.1 index 是「这次 AX 树渲染的节点序号」

- ocu snapshot / get_app_state 输出的每一行开头的数字（0、1、2 ...）就是 element_index。
- 它是**这次渲染**的树序号，**不是稳定 id**。页面一变（弹出下拉、滚动、加载更多、侧边栏展开），
  后面的节点会整体位移。
  - 实测：搜索建议列表收起（输入框失焦）后，「武汉」按钮 index 从 69 变成 64（整体 -5）。
  - 实测：城市弹层出现后，主页面筛选项 index 不变，但弹层内部元素插入树中，总行数 873 → 897。
- **结论：每次动作前重新 getAXState + 重新解析 index，绝不跨动作硬编码数字。**

### 2.2 index 只在「同一个原生会话」里有效

- 一次独立的 ocu call / ocu snapshot 是独立进程，**下一次调用拿不到上一次的 index**。
- 必须在同一会话内串联：
  - 命令行：ocu call --calls-file（同一进程内共享 index，默认每次操作间 sleep 1s）
  - 脚本（推荐）：ocu js --file，Node 风格的持久 JS 会话，可在会话里解析再点击
- 文档给出的 query 是另一套句柄：index 形如 1000001+，同一原生会话内保留 120 秒（5000 个句柄），
  动作前会重新校验窗口/控件/几何；失败就重新 query。

### 2.3 怎么稳定找到目标控件

不要按固定 index 找，按「role + 可见文本 + Frame 坐标范围」找，例如左侧筛选栏的城市按钮：

~~~js
// 一行形如： 64 button  武汉 Frame: x=52, y=273, w=72, h=32
var m = /^\t*(\d+)\s+button\s+\S*\s*武汉\s+Frame: x=(\d+), y=(\d+), w=(\d+), h=(\d+)/.exec(line);
~~~

- 用 Frame 的坐标范围（y 在筛选栏区域）排除页面里其它同名文本。
- 命中的那行原文要记进证据里，方便回看「到底点了什么」。

---

## 3. 点击：click_method 实测结论

ocu 的 click_method 可选 auto / accessibility / app_post / sky_click / global。
以下全部为本机实测（Chrome 窗口被 DeepSeek Harness 窗口覆盖、非前台）：

| click_method | 结果 | 说明 |
| --- | --- | --- |
| accessibility | ✅ 主页面元素有效 | 点「武汉」城市按钮成功弹出「请选择城市」弹层 |
| accessibility（弹层内 × 按钮） | ✅ 有效（需重试） | 弹层右上角 × 是带 Frame 的无文本 button，accessibility 点击可关闭；实测点 1~2 次才生效 |
| accessibility（筛选按钮当开关） | ❌ 关不掉 | 弹层打开后再点筛选按钮不会关闭，它只负责打开；关闭必须点 × |
| app_post | ❌ 无效 | 按窗口内坐标点关闭按钮或页面其它位置，返回成功但页面无变化；文档也说明 Chromium 被覆盖时会忽略 app_post |
| sky_click | ⚠️ 时灵时不灵 | 同一坐标（944,302）少数情况能关掉，多数无效；**必须先在同一会话里取过截图**，否则报 "request a screenshot before screenshot-coordinate actions"；坐标超出截图缩放后的边界还会报 "outside the snapshot window bounds" |
| global | ❌ 禁用 | 会移动真实指针/改变前台焦点，违反本任务硬约束 |

### 推荐策略

1. 首选 **accessibility + 动态解析 index**（无副作用、不需要截图）。
2. accessibility 无效时才用 **sky_click**，坐标取 AX 的 Frame 中心（窗口内坐标），
   并且同一会话里先 getAXState（默认会截图）。
3. 永远不要启用 global。

### 坐标语义

- AX 的 Frame 是**窗口内坐标**（实测 Chrome 窗口在屏幕 (0,33)，页面筛选按钮 Frame y=273，
  换算到屏幕约 306，和页面布局一致）。
- sky_click / app_post 的 x,y 也用窗口内坐标。
- 窗口移动/缩放后坐标失效，要重新取状态。

---

## 4. 键盘：key_method

- 平台支持：sky_key 仅 macOS；global 仅 Windows press_key。
- 文档口径：sky_key 会把目标窗口在「它自己的 app 内」设为 key window（不抬升、不移动指针、不切换
  Space、不取消前台 app），因此能在后台窗口里输入；**它输入到当前已聚焦的元素**，所以要先
  click 或 AX focus 目标输入框。
- 实测：sky_key 发送 Escape **没能**关闭网页里的城市弹层（网页未响应或事件被覆盖层吞掉）。
  所以「用 Esc 关弹层」不可靠，别把它当主路径。
- 输入框赋值：优先 set_value（元素级、最稳，无键盘焦点问题）；需要模拟真实键入再考虑 sky_key。

---

## 5. 时序：别省等待

- ocu call --calls / --calls-file 的默认节奏是**每次成功操作之间 sleep 1 秒**。
- 网页下拉/弹层是异步渲染的：点击后立刻读 AX 可能读到「没变化」。
  - 实测：accessibility 点城市按钮后，默认 1s 间隔的读取**没看到**弹层；把间隔加到 1.2s 才看到。
  - **更关键的坑：第一次点击经常被「吞掉」**。实测连续点 4 次，可能只有 1~2 次真正生效；
    所以打开/关闭都要写成「点击 → 轮询 3 次（每次约 0.8~1s）→ 状态不对就重新取状态再点」，最多 4 轮。
  - 弹层节点在 AX 树里出现/消失都有 0.5~2s 延迟，判定必须轮询，不能点完立刻下结论。
  - 结论：点击后至少等 1.2~1.5s；重要动作用「轮询最多 3 次、每次 1s」确认。
- 大页面把树预算调大：max_tree_nodes=3000、max_tree_depth=96；否则长列表会被截断。

---

## 6. 失败重试策略

按这个顺序排错，不要盲目重试同一步：

1. **先看错误类型**
   - NSPOSIXErrorDomain Code=2 "No such file or directory" → 屏幕锁定/屏保（见第 8 节），停手。
   - "element index ... not found / stale" → index 过期，重新 getAXState 重新解析。
   - "request a screenshot before screenshot-coordinate actions" → 同一会话里先 getAXState 再点。
2. 动作前重新取状态、重新解析 index（每次动作都是）。
3. 动作后校验「预期标志文本」是否出现；没出现就重试一次（重新取状态）。
4. 仍失败 → 换 click_method（accessibility → sky_click），或换坐标（Frame 中心）。
5. 连续失败 → 重新 snapshot 整棵树，确认页面/窗口是否已变化（导航、弹窗、加载中）。
6. 校验不通过就不要继续后面的步骤，直接报失败并保留前后状态作为证据。

---

## 7. 怎么证明「Chrome 没有被激活」

### 7.1 真实前台应用（权威）

~~~sh
osascript -e 'tell application "System Events" to get name of first application process whose frontmost is true'
~~~

实测：操作前、操作后、操作期间采样都是 DeepSeek Harness，从未出现 Google Chrome。

### 7.2 重要更正：ocu list-apps 第一行不是前台应用

任务描述里把 list-apps 第一行当作前台，这在实际输出里不成立：

- list-apps 的输出按「最近使用日期 + 使用次数」排序，running 的应用排在前面。
- 实测常驻首行是 Google Chrome（uses=628），而真实前台是 DeepSeek Harness。
- 但 list-apps **会给真正前台的 app 打 [frontmost] 标记**，例如：
  DeepSeek Harness — com.deepseek.dsh [frontmost, running, last-used=...]。
- 所以：判定前台要么用 System Events，要么在 list-apps 里找带 [frontmost] 的那一行；
  **不能用第一行**。

### 7.3 鼠标没动

~~~sh
osascript -l JavaScript -e 'ObjC.import("AppKit"); var e=$.NSEvent.mouseLocation; JSON.stringify({x:e.x,y:e.y})'
~~~

实测探针全程鼠标坐标不变（734.24, 454.66 → 734.24, 454.66）。

### 7.4 防瞬时激活漏检

探针运行期间每 700ms 采样一次 frontmost，只要 Chrome 曾出现过就判失败——避免
「瞬间激活又切回」被前后两次快照漏掉。

---

## 8. 最大的坑：锁屏会让 AX 全线失败

### 现象

- 任何 snapshot / get_app_state 立即失败：
  Error Domain=NSPOSIXErrorDomain Code=2 "No such file or directory"
- 但 ocu list-apps 仍然正常（它走 NSWorkspace，不走 AX）。
- 同时 System Events 也读不到其它 app 的窗口（窗口列表为空），frontmost 属性仍可读。

### 本机实际发生

- 2026-11-05 16:52:56，屏保空闲触发锁屏（loginwindow 日志：kLWLockFromScreenSaverIdleLaunch）。
- 之后 ocu 的所有 AX 读取全部报上面的错误，直到解锁。

### 检测与预防

~~~sh
# 检测
ioreg -n Root -d1 -a | grep -A1 CGSSessionScreenIsLocked
# 预防显示器休眠（不解除锁屏，但可减少闲置锁屏）
caffeinate -d
~~~

脚本里必须把「锁屏」当成环境不可用（退出码 2 + 人话提示），不要当成普通重试失败。

---

## 9. 安全边界

- 只允许：筛选器、搜索框、收藏、标签页这类无害控件。
- 绝对禁止：打招呼、投递、发送消息、修改账号资料、任何外发动作。
- 探针只做两件事：点左侧「武汉」城市筛选按钮（打开弹层）、点弹层关闭按钮（恢复现场）。
- 不启用 global 指针通道；不动真实鼠标。

---

## 10. 交付脚本用法

~~~sh
cd desktop-agent/flow
node probe.mjs
~~~

- probe-inner.mjs 是内层脚本（占位符由 probe.mjs 注入），不要单独运行。
- 退出码：0 全部通过；1 业务验证失败；2 环境不可用（锁屏 / ocu 异常 / 页面不对）。
- 可覆盖的环境变量：OCU_BIN、OCU_APP、EXPECTED_FRONTMOST、PROBE_JS_TIMEOUT_MS。
- PROBE_SKIP_LOCK_CHECK=1 只用于离线自测（配合假 ocu 验证包装逻辑），真实运行不要设置。

### 探针做的事（按顺序）

1. 预检：ocu 是否存在、版本、屏幕是否锁定。
2. 记录操作前的真实前台应用 / 鼠标坐标 / list-apps 第一行。
3. 后台读 AX 树，确认是 BOSS 职位页（zhipin.com/web/geek/jobs），并确认城市弹层未打开
   （若上次残留了弹层，先关掉）。
4. 正则定位左侧筛选栏「武汉」按钮，accessibility 点击。
5. 等 1s 后读 AX，最多轮询 3 次，校验「请选择城市」「热门城市」出现、URL 未跳转，
   记录新增的 AX 行作为证据。
6. 依次尝试 sky_click 关闭按钮 / accessibility 点回筛选按钮 / sky_key Esc，尽量恢复现场。
7. 记录操作后的前台应用与鼠标坐标，期间每 700ms 采样前台。
8. 打印 PASS/FAIL 明细并给出退出码。

---

## 11. 实测证据（2026-11-05）

### 11.1 accessibility 点击打开城市弹层

操作前 AX 873 行 → 操作后 897 行，新增节点（文本级 diff）：

~~~
+ 标题 请选择城市 Value: 3
+ 文本 请选择城市
+ button Frame: x=932, y=290, w=24, h=24        ← 弹层关闭按钮
+ button 热门城市 Frame: x=178, y=352, w=130, h=39
+ button ABCDE  Frame: x=308, y=352, w=130, h=39
+ button 全国   Frame: x=178, y=411, w=158, h=40
+ button 北京   Frame: x=335, y=411, w=158, h=40
+ button 武汉   Frame: x=807, y=459, w=157, h=40
...
- container 测试abc 开发        ← 搜索建议列表：因为点击使输入框失焦而收起
~~~

目标控件（点击前那次快照的 AX 树原文）：69 button  武汉 Frame: x=52, y=273, w=72, h=32
URL 未跳转（仍是 zhipin.com/web/geek/jobs）。
前台：DeepSeek Harness → DeepSeek Harness；鼠标坐标不变。

### 11.2 关闭弹层

- 正确方式：accessibility 点弹层右上角 × 按钮（element 313，Frame x=932,y=290,w=24,h=24）。
  实测需要点 1~2 次（第一次常被吞），点完轮询 0.8~2s 确认「请选择城市」消失。
- 反例：再点筛选按钮**不会**关闭弹层（它只负责打开）。
- 反例：sky_click 点 (944,302) 少数情况能关、多数无效；app_post 两次都无效；
  sky_key Escape 无效。→ 别把这几条当主路径，且必须校验结果。

### 11.2.1 最终全 PASS 记录（2026-11-05 17:35）

node probe.mjs 输出：12 项检查全部 PASS，退出码 0。关键行：

~~~
AX 行数: 868 -> 897
目标控件: 64 button  武汉 Frame: x=52, y=273, w=72, h=32
步骤: ensure-closed-before(closed) -> open-city-dialog(a11y-city@64 x2) -> restore(a11y-close@313 x2)
运行期间采样: 22 x DeepSeek Harness
Chrome 是否曾成为前台: false
鼠标坐标是否一致: 是
结果: 全部通过
~~~

注意：探针运行期间如果用户自己动鼠标/切应用，前台判定会失败（那是人工干扰，不是自动化抢焦点）。
probe.mjs 已把这种场景降级成 WARN（检测到鼠标移动即视为人工干扰）。

### 11.3 list-apps vs 真实前台

~~~
ocu list-apps 第一行: Google Chrome — com.google.Chrome [running, last-used=2026-11-05, uses=628]
真实前台(System Events): DeepSeek Harness
~~~

### 11.4 锁屏导致 AX 失效

~~~
$ ~/.local/bin/ocu snapshot "Google Chrome"
Error Domain=NSPOSIXErrorDomain Code=2 "No such file or directory"

$ ioreg -n Root -d1 -a | grep -A1 CGSSessionScreenIsLocked
<key>CGSSessionScreenIsLocked</key>
<true/>
~~~

---

## 12. 已知限制 / 待复核

1. **页面/弹层的 AX 树有延迟**：弹层节点出现和消失都比视觉慢 0.5~2s；判定必须轮询，
   不要点完立刻下结论（早期误判就是这么来的）。
2. **点击会被吞**：accessibility 点击偶发无效（连续 4 次可能只有 1~2 次生效），
   打开/关闭都要做重试状态机；参考 probe-inner.mjs 的 ensureOpen / ensureClosed。
3. **用户在用机器时探针会误报**：probe 采样前台，若用户中途切到 Chrome/Finder，
   前台判定会失败；已按「鼠标位移 = 人工干扰」降级为 WARN。想拿全 PASS 需机器空闲 15~20 秒。
4. **锁屏时 AX 全挂**：NSPOSIXErrorDomain Code=2，隔一分钟重试或解锁后再跑；
   probe.mjs 会把锁屏当环境不可用（退出码 2）。
5. **sky_key 实际键入**：未做「聚焦输入框 + sky_key 输入 + 读回 value」的完整验收；
   输入优先用 set_value。
