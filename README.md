# Desktop Agent

[![CI](https://github.com/USER/desktop-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/USER/desktop-agent/actions/workflows/ci.yml)

> 后台电脑控制 + 小窗回显。所有操作在你的真实应用里完成，但全程不抢焦点、不动你的鼠标、不切你的窗口。

一个自用的 macOS 桌面自动化框架：**控制层**用 Accessibility 语义树驱动真实应用，**展示层**用一个贴在 DSH 窗口里的小窗实时回显它在干什么，**调度层**是常驻后台的 daemon 加任务运行器。

## 它解决什么问题

浏览器自动化脚本会弹窗、抢焦点、切标签页，人在电脑前就没法干活。这个项目的前提是：**自动化必须在后台跑，人能同时正常用电脑**。

所以它做了三件事：

1. **不打扰**：用 Accessibility 语义动作点击，不移动系统指针；窗口用 `showInactive` 显示，不激活应用。
2. **看得见**：需要时浮现一个小窗，实时显示被控窗口画面和当前动作；空闲 5 秒自动消失。
3. **可验证**：每个任务都有明确的成功判据，不是「跑完了」就算成功。

## 架构

```
┌─────────────────────────────────────────────┐
│ daemon (127.0.0.1:7789)                     │
│  · 串行任务队列  · 重试  · JSONL 日志        │
└───────────────┬─────────────────────────────┘
                │ 调度
┌───────────────▼─────────────────────────────┐
│ 任务层 core/tasks/                          │
│  · AX 控制真实应用  · 离屏浏览器  · CDP      │
└───────────────┬─────────────────────────────┘
                │ 状态 / 帧
┌───────────────▼─────────────────────────────┐
│ overlay (127.0.0.1:7788)                    │
│  · 多会话小窗  · 实时缩略图  · 点击穿透      │
└─────────────────────────────────────────────┘
```

## 快速开始

环境要求：macOS 14+、Node.js 20+、[open-computer-use](https://github.com/iFurySt/open-computer-use)（`ocu`）。

```bash
# 0. 环境自检（换机器先跑这个）
npm run doctor

# 1. 装依赖
npm install
cd overlay && npm install && cd ..

# 2. 装成开机自启（macOS launchd / Windows 计划任务）
npm run service:install

# 或者只临时启一下
npm run daemon

# 3. 看状态
npm run status

# 4. 跑任务
npm run run browser-demo
```

## 跨平台

目标是一套代码同时支持 macOS 和 Windows。当前进度：

| 层 | macOS | Windows |
| --- | --- | --- |
| 小窗展示 | ✅ screencapture | ✅ PrintWindow（未实机验证） |
| 前台/窗口信息 | ✅ osascript | ✅ PowerShell + User32（未实机验证） |
| 控制（点击/读界面） | ✅ ocu | ❌ UI Automation 待实现 |
| 后台输入 | ✅ sky_key | ❌ 待实现 |
| 浏览器 | ✅ 离屏 Chrome + CDP | ✅ 逻辑通用 |

平台差异都收在 `overlay/platform.js`（渲染侧）和 `core/platform.mjs`（逻辑侧），业务代码不再直接调 osascript。
详细缺口和移植路线见 [flow/CROSS-PLATFORM.md](flow/CROSS-PLATFORM.md)。

**诚实说明**：Windows 分支是照 Win32 API 写的，没在真实 Windows 上跑过——当前开发机是 macOS。

## 目录

```
core/
  agentd.mjs        # ocu 封装 + overlay 客户端 + 互斥锁 + 前台守卫
  runner.mjs        # 任务注册、重试、日志
  daemon.mjs        # 常驻 HTTP 服务，串行队列
  acceptance.mjs    # 端到端验收
  browser.mjs       # 离屏 Chrome 管理（后台启动、恢复前台）
  cdp.mjs           # 零依赖 CDP 客户端
  human.mjs         # 拟人鼠标轨迹与输入
  frames.mjs        # 实时帧推送
  tasks/            # 具体任务
overlay/            # Electron 小窗（多会话、缩略图、穿透）
flow/               # 每个流程的方法论与踩坑记录
```

## 小窗

- 贴在 DSH 窗口右上角，跟随 DSH；DSH 失焦自动隐藏
- 空闲 5 秒淡出，鼠标悬停时暂停隐藏
- 默认点击穿透：只有右上角 `⤢` / `✕` 和顶部 8px 拖拽条接管鼠标
- `⤢` 按画面比例放大到屏幕中央，再点还原
- 支持多会话：每个会话一个独立窗口，按 DSH 当前对话标题门控

![小窗](overlay/docs/multi-session.png)

## 控制层

我不用截图猜坐标，走 Accessibility 语义树：

| 动作 | 实现 |
| --- | --- |
| 读界面 | `ocu` 拉 AX 树，按角色/文本定位元素 |
| 点击 | `accessibility` 语义动作，不移动系统指针 |
| 输入 | `sky_key` 后台键入，不激活窗口 |
| 截图 | `screencapture -l <windowId>` 按窗口抓，不受遮挡影响 |

离屏场景（浏览器、Electron）另走 CDP，用独立 profile 起一个后台实例，抓完再恢复原前台。

## 安全边界

这是给「操作自己的账号」设计的工具，不是爬虫框架。约定写死在代码里：

- 目标应用变成前台就中止任务（`guard()`）
- 同一应用加文件锁，禁止并发操作（`withAppLock()`）
- 不自动过验证码：命中验证页立即中止并报告
- 高频操作要限速，风控权重是累积的

## 案例：BOSS 直聘投递

`flow/BOSS-GREET.md` 记录了完整方法论，其中一条最有价值：

> **平台弹窗「已发送」不代表真的送达。** 唯一可信的判据是消息列表前后差集。

这个项目早期正是因为拿弹窗当成功信号，连续 8 次误报。修好后的判定链是：详情 id 精确比对 → 按钮文案判断是否已联系 → 消息列表差集验收。

## 打包上传

```bash
bash scripts/export.sh    # 生成 dist/desktop-agent-<version>.tar.gz，排除依赖与运行时产物
```

首次在 Windows 上运行，请按 [flow/WINDOWS-TESTING.md](flow/WINDOWS-TESTING.md) 的清单逐项确认。

## 测试与验收

```bash
npm test          # 单元测试（打分、薪资解析、平台探测）
npm run check     # 语法检查
npm run accept    # 端到端验收（需要本机服务在跑）
```

CI 在 Ubuntu / macOS / Windows 三平台跑 `npm test` 与 `npm run check`。

会跑一遍端到端检查：服务在线、小窗显隐、各任务是否通过，输出 Markdown 报告到 `reports/`。

已知问题：`form-fill` 在 overlay 同时运行时可能失败——本机 Electron 宿主抢不到窗口句柄（`cgWindowNotFound`），属于环境冲突，不是逻辑错误。

## Roadmap

- [ ] Windows 控制后端（UI Automation），补齐 click/typeText/pressKey
- [ ] Windows 服务自启（schtasks 安装脚本）
- [ ] 任务参数化（筛选标准可配置，先出清单再执行）
- [ ] 小窗支持更多会话元信息（任务进度、耗时）
- [ ] 更完整的失败重试策略

## 变更记录

见 [CHANGELOG.md](CHANGELOG.md)。

## License

MIT