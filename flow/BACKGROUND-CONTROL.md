# 后台控制：能力边界与「不切屏」的做法

> 2026-11-06 实测。目标：控制任何应用，但用户屏幕、前台、鼠标都不受影响。

## 一、能力边界在哪

控制能力来自 ocu，和 Codex 同源，所以**广度是一样的**：只要应用遵循无障碍规范，macOS 用 Accessibility、Windows 用 UI Automation 都能读和点。

我们目前的边界不在引擎，而在**我们自己刻意没启用的三种后台能力**：

| 能力 | 作用 | 我们之前为什么没用 |
| --- | --- | --- |
| `sky_click` | 窗口被遮挡、在别的 Space 也能点，不抬窗口、不动指针 | 担心私有 SPI 不稳定 |
| `sky_key` | 同上，后台键入，组合键走目标应用菜单栏 | 同上 |
| `agent_display` | 把窗口挂到一块用户看不见的虚拟显示器 | 会新增系统显示器，属敏感操作 |

结果就是：遇到「窗口被遮住」「窗口在别的 Space」「要点空白区域」时，我们只能把窗口拿到前台——这就是 Chrome 那种“强制切屏”观感的来源。

## 二、真正做不到的

| 场景 | 原因 |
| --- | --- |
| 锁屏状态 | AX/UIA 整体失效 |
| SSH / 服务上下文 | 必须有登录的桌面会话 |
| 自绘窗口内部（Electron/UWP/微信） | 只暴露一层壳 |
| 需要管理员权限的应用 | UIPI / TCC 拦截 |
| 过验证码 | 系统层注入会被识别为自动化 |

## 三、Chrome 强制切屏：根因与解法

**根因**：Chrome 的窗口必须在可见的 Space 里，AX 动作和坐标点击才有意义。我们用负坐标把窗口推出去，Chrome 会自己拉回来；某些操作（打开新标签、导航）还会主动激活窗口。

**解法（已实测通过）：`agent_display` + `sky_key` / `sky_click`**

```bash
OPEN_COMPUTER_USE_VIRTUAL_DISPLAY_ENABLED=true ocu js --file script.mjs
```

```js
var app = await cua.getApp('TextEdit', { initialState: false });
await app.getAXState({ windowPlacement: 'agent_display' });   // 挂到看不见的显示器
await app.typeText('BG-TEST-9137', { keyMethod: 'sky_key' }); // 后台键入
await app.getAXState({ windowPlacement: 'restore' });         // 还回去
```

实测结果：

```
操作前前台 = DeepSeek Harness
挂虚拟显示后树行数 = 56（窗口仍完整可读）
键入后控件 Value = BG-TEST-9137（真的写进去了）
操作后前台 = DeepSeek Harness（全程没变）
显示器数量 = 1（restore 后虚拟屏已移除）
```

## 四、用在 Chrome 上的方案

1. 自动化浏览器启动后，先 `agent_display` 挂起（用户屏幕上完全看不到它）
2. 操作用 `sky_click` / `sky_key`，或直接走 CDP（CDP 本身不抢焦点）
3. 结束、异常、会话关闭时都要 `restore`，避免窗口留在看不见的地方
4. 环境变量 `OPEN_COMPUTER_USE_VIRTUAL_DISPLAY_ENABLED=true` 必须由用户显式开启

## 五、风险与注意

- 虚拟显示器会短暂改变系统显示排列，restore 后恢复；**必须在同一会话内配对调用**
- 窗口在 restore 前会从用户桌面消失，需要明确告知
- `sky_click`/`sky_key` 是私有 SPI，macOS 升级后可能失效，需重新验证
- 我们的小窗抓图依赖窗口可见性；挂到虚拟显示器时要改用外部推帧（CDP 截图）
