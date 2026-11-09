# examples/web-click —— 通用网页点击最小示例

演示「通用网页点击」：**按可见文字找到按钮 → 后台点击 → 读回结果并断言**，
全程 **headless Chrome（没有可见窗口）**，不移动系统指针、不激活任何应用、不写用户数据。

## 怎么跑

~~~sh
cd dsh-rig
node examples/web-click/run.mjs
~~~

前置：本机有 Google Chrome（默认 /Applications/Google Chrome.app；可用 CHROME_BIN 覆盖）。

预期输出（实测）：

~~~text
[1] Chrome: /Applications/Google Chrome.app/Contents/MacOS/Google Chrome （headless，无可见窗口）
[2] 页面: file:///…/examples/web-click/fixture.html
    launch: {"step":"launch","pid":70464,"port":59367,"headless":true}
    find-button-by-text: {"step":"find-button-by-text","text":"提交","index":0,"x":75,"y":231,"w":70,"h":41}
    type-into-input: {"step":"type-into-input","value":"测试用户"}
    background-click: {"step":"background-click","x":75,"y":231,"method":"CDP Input.dispatchMouseEvent"}
    read-result: {"step":"read-result","expected":"提交成功：测试用户","actual":"提交成功：测试用户"}
[3] 前台应用: DeepSeek Harness → DeepSeek Harness （未变）
PASS  examples/web-click：按文字找到「提交」→ 后台点击 → 读回 "提交成功：测试用户"（1382ms）
~~~

失败退出码 1；环境不可用（找不到 Chrome / headless 启动失败）退出码 0 并打印
SKIP 环境跳过：… ，**不会假绿**：真正的断言失败一定 exit 1。

## 它做了什么

1. 用独立临时 profile 启动 **headless Chrome**（core/browser.mjs 的 launch，--headless=new）；
2. CDP 连接页面，加载 examples/web-click/fixture.html（file://）；
3. 在 DOM 里遍历 button，按 **可见文字** 找到「提交」（不是写死坐标/选择器）；
4. focus 姓名输入框，用 CDP Input.insertText 输入「测试用户」；
5. 用 **CDP Input.dispatchMouseEvent** 在按钮中心派发 mouseMoved/mousePressed/mouseReleased
   （isTrusted=true，走浏览器输入管线，等同真实点击）；
6. 读回 #result 文本，断言等于「提交成功：测试用户」；同时校验页面标题与输入框 value；
7. 关闭 Chrome、删除临时 profile，并比较前后前台应用。

## 为什么这不抢前台

- headless Chrome 没有窗口（无可见窗口，不会把 Chrome 顶到前台）；
- 点击走 CDP Input 域，不经过系统指针（不移动鼠标、不产生真实屏上事件）；
- 前台校验用 core/front-read.mjs 的 ObjC/NSWorkspace 读取（不发 AppleEvent、不需要自动化授权），
  脚本会在结束时断言「前台应用前后一致」，被抢就判 FAIL。

## 文件

- fixture.html —— 本地测试页（姓名输入框 + 「提交」「重置」按钮 + #result 结果区）；
- run.mjs —— 可执行脚本，同时导出 runWebClick()/chromeAvailable() 供测试复用；
- 测试：test/examples-web-click.test.mjs（Chrome 不可用时自动 skip）。