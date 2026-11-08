# 后台写操作结论（form-fill）

对应任务：task-5「后台写操作任务：完成一次真实表单填写并校验」
交付代码：

- desktop-agent/core/tasks/form-fill.mjs —— 真实应用（Chrome + 页面输入框）
- desktop-agent/core/tasks/form-fill-local.mjs —— 本地对照（file:// + 最小 HTML 表单）
- 本文 —— 四类控件可写性结论、复现方法与限制

---

## 1. 结论表：哪些控件能后台写

| 控件 | 后台可写 | 方法 | 实测证据 |
| --- | --- | --- | --- |
| 文本输入框 input[type=text] | ✅ | click(accessibility) 聚焦 → pressKey cmd+a(sky_key) → typeText(sky_key) | Value: 原值A → OCU-TEXT-9527 |
| contenteditable div | ✅ | 同上 | Value: 原始简介文本 → OCU-EDIT-9527 |
| select（下拉 / popup） | ✅ | click(accessibility) 展开 → 等 AX 出现「菜单项」→ click 目标菜单项 | 武汉 Wuhan → 上海 Shanghai |
| select（列表 / listbox，size>1） | ✅ | 直接 click AX 里的「菜单项」 | 选中态从 武汉 移到 北京 Beijing |
| checkbox | ✅ | click(accessibility) 直接切换 | Value: off → on，再点回 off |
| 全选/清空输入 | ✅ | pressKey cmd+a（sky_key） | 覆盖前先全选，实测有效 |

补充事实：

- **set_value 对文本/可编辑区只在目标应用是前台时有效**；后台（应用非前台）点它返回成功但值不变。
  后台必须走「聚焦 + sky_key 键入」。
- **set_value 对 select 无效**：传 上海 / sh / 2 都返回成功但 Value 不变，必须展开菜单点选项。
- **checkbox 只能点数（AXPress）**，没有可写的 value。

---

## 2. 真实应用验证（Chrome + 目标站点）

命令：

~~~sh
cd desktop-agent
PATH="$HOME/.local/bin:$PATH" node core/tasks/form-fill.mjs
~~~

实测输出（2026-11-05 22:00）：

~~~text
[1] 初始前台: DeepSeek Harness
[2] 确认/切回 目标页面 … ok= true url= https://www.example.com/web/page
[3] 后台改写搜索框 + 读回校验 + 恢复 …
    前台: DeepSeek Harness -> DeepSeek Harness
    原值: "测试ABC"
    新值: "Java开发工程师"
    恢复: "测试ABC"
    步骤: ["setNew attempt1 -> \"Java开发工程师\"","restore attempt1 -> \"测试ABC\""]
[4] 结束前台: DeepSeek Harness

--- 验收 ---
  PASS  搜索框定位成功
  PASS  改成了指定关键词
  PASS  已恢复原值
  PASS  全程前台不是 Chrome
结果: 全部通过   EXIT=0
~~~

做法：

1. 先用 AX 读当前标签页 URL，不是 example.com/web/page 就点对应标签页切回来
   （切不动时用 AppleScript set active tab index 兜底，同样不激活 Chrome）。
2. 在 AX 树里按 Placeholder「搜索职位、公司」定位搜索框，记录原值。
3. click 聚焦 → cmd+a 全选 → sky_key 键入新关键词 → 读回 AX 校验。
4. 用同样方式写回原值 → 再读回校验。
5. 全程不按 Enter、不点搜索按钮，所以不会触发跳转/请求；不提交任何东西。

---

## 3. 本地对照验证（最小 HTML 表单）

命令：

~~~sh
cd desktop-agent
PATH="$HOME/.local/bin:$PATH" node core/tasks/form-fill-local.mjs
~~~

实测输出（2026-11-05 22:01）：

~~~text
[1] 初始前台: DeepSeek Harness
[2] 本地宿主 App: /tmp/OCUFormHost.app OK（复用）
[3] 后台启动本地宿主（独立 bundle、透明窗口在屏幕外，不弹窗/不抢焦点）…
    窗口就绪: true
    启动后前台: DeepSeek Harness
[4] 执行后台写入 + 读回校验 …
[5] 结束前台: DeepSeek Harness

--- 验收 ---
  PASS  文本框写入成功  [10 文本栏 ... Value: OCU-TEXT-9527, Placeholder: 请输入姓名]
  PASS  contenteditable 写入成功  [13 文本输入区 ... Value: OCU-EDIT-9527]
  PASS  下拉(select popup) 选中上海  [18 弹出式按钮 ... Value: 上海 Shanghai]
  PASS  列表(select listbox) 选中北京  [22 菜单项 (selected) Value: 北京 Beijing]
  PASS  复选框勾选成功  [25 复选框 ... Value: on]
  PASS  全程前台不是 Chrome  [DeepSeek Harness]
结果: 全部通过   EXIT=0
~~~

表单里没有 submit，按钮是 type=button 且无事件，点了也不会提交。

---

## 4. 怎么做到「不弹窗、不抢焦点」

### 4.1 为什么不让 Chrome 开本地页

实测：无论是 open -g -a "Google Chrome" file://… 还是 AppleScript make new tab，
Chrome 都会把自己带到前台（打开新标签/加载页面时自动激活）。Safari 用 open -g 确实不抢焦点，
但 Safari 后台不把网页内容暴露给 AX（只能看到地址栏），没法做控件写入。

结论：本地对照用一个 Electron 宿主页，它在后台创建、完全不可见。

### 4.2 Electron 宿主的三个关键点

1. **独立 bundle id**：overlay 本身也是 Electron（com.github.Electron），同名会和它撞车
   （ocu 会绑到 overlay 窗口上，找不到我们的表单）。所以脚本首次运行会从
   overlay/node_modules/electron/dist/Electron.app 复制一个副本到 /tmp/OCUFormHost.app，
   改 CFBundleIdentifier=com.local.ocuformhost、CFBundleName/DisplayName=OCU Form Host，
   再 ad-hoc 签名。之后 ocu snapshot / ocu js 用 "OCU Form Host" 就能唯一绑定。
   （一次性成本：约 263MB 复制；已存在则复用。）
2. **窗口不可见**：BrowserWindow { show:false, frame:false, opacity:0, x:-5000, y:-5000 }，
   ready-to-show 后 showInactive()（只显示不激活）。用户完全看不到窗口，也不会抢焦点。
3. **必须 showInactive，不能一直 show:false**：纯隐藏窗口没有 CGWindow，AX 直接报
   cgWindowNotFound；透明+屏幕外窗口则有 CGWindow，AX 可读，也能被 sky_key 设为 key 接收键盘。

### 4.3 防打扰验证

每次运行都检查操作前/启动后/结束后前台应用；实测三次都是 DeepSeek Harness，Chrome 从未被激活。

---

## 5. 实现细节与坑（写操作用得上）

1. **element index 会位移**：下拉展开后，同一个按钮的 index 会 +1（17 → 18），
   所以每次动作前重新 getAXState、重新按 role+文本定位，绝不跨步骤复用 index。
2. **点击可能被吞**：accessibility 点击偶发无效；写操作统一做成「点击 → 等 → 读回校验 →
   不通过就重新取状态再点」，最多 3~4 次。
3. **AX 有 0.5~2s 延迟**：展开下拉后要等它出现「菜单项」再点；点完选项要再读一次确认 Value。
4. **JS 正则的坑**：JS 的 \b 只认 ASCII 词字符，中文后面的 \b 永远不匹配；
   匹配中文标签要用 \s 而不是 \b。
5. **模板字符串吃转义**：内层 JS 当成普通模板字符串写时，\n、\t、\d 会被提前解释掉，
   导致 ocu js 拿到坏代码、只报一个空 Error。内层脚本模板必须用 String.raw。
6. **输入前必须聚焦**：直接 typeText 会打到当前焦点元素上；先 click 目标控件再用 cmd+a + typeText。
7. **select 展开后的菜单项**：AX 里会出现「菜单 (settable, string)」+ 多个「菜单项」，
   点对应菜单项即可选中并收起；未展开时 AX 只暴露当前选中项。

---

## 6. 复现与环境变量

~~~sh
cd desktop-agent
PATH="$HOME/.local/bin:$PATH" node core/tasks/form-fill.mjs        # 真实应用
PATH="$HOME/.local/bin:$PATH" node core/tasks/form-fill-local.mjs  # 本地对照
~~~

可覆盖的环境变量：

- TARGET_APP（默认 Google Chrome）
- FILL_KEYWORD（真实应用要写入的关键词，默认 "Java开发工程师"）
- OCU_BIN（ocu 路径）
- FORM_HOST_APP（本地宿主 .app 路径，默认 /tmp/OCUFormHost.app）
- FORM_HOST_ELECTRON（Electron.app 源路径，默认 overlay/node_modules/electron/dist/Electron.app）
- FILL_JS_TIMEOUT_MS（内层 JS 超时，默认 90000）

运行前置：屏幕未锁（锁屏时 AX 全挂，报 NSPOSIXErrorDomain Code=2）；Chrome 不是前台。

---

## 7. 已知限制

1. **首次运行要复制 Electron（约 263MB）**到 /tmp/OCUFormHost.app；之后复用。
   如果 /tmp 被清掉会重新复制。
2. **下拉选中后 AX 可能短暂显示 (expanded)**：值已经改对（已校验），这只是 AX 状态标记滞留；
   脚本选完会补一次 Esc。窗口本身是透明不可见的，不会弹到用户面前。
3. **后台写依赖 sky_key**：目标窗口要能被设成 key（Electron 宿主可以；Chrome 后台窗口也可以）。
   如果应用被系统限制无法成为 key，键入会失败，需退回前台 set_value（会激活应用，不推荐）。
4. **只验证了 Chromium 系（Chrome/Electron）**；Safari 后台不暴露网页 AX，未覆盖。
5. **本次没有触碰任何发送类按钮**：真实应用只改搜索框并恢复原值；本地表单没有 submit。
