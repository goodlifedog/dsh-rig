# 桌面代理架构（desktop-agent）

目标：让 DSH 能在 macOS 后台控制绝大多数软件，全程不抢用户焦点、不动鼠标；
有操作时小窗出现，空闲自动消失。

## 一、分层

```
┌─────────────────────────────────────────────┐
│ 任务层  core/tasks/*.mjs                     │  声明式脚本：读 → 判断 → 动作 → 校验
├─────────────────────────────────────────────┤
│ 编排层  core/agentd.mjs                      │  应用锁、安全护栏、overlay 客户端
├─────────────────────────────────────────────┤
│ 能力层  ocu (open-computer-use)              │  AX 读 / click / set_value / type_text
├─────────────────────────────────────────────┤
│ 展示层  overlay/ (Electron)                  │  状态、日志、缩略图，空闲隐藏
└─────────────────────────────────────────────┘
```

## 二、安全护栏（硬规则）

1. **绝不激活被控应用**。每次动作前后 `ocu list-apps` 检查 frontmost；一旦被控应用变成前台，立即中止并上报。
2. **绝不使用全局指针兜底**（`OPEN_COMPUTER_USE_ALLOW_GLOBAL_POINTER_FALLBACKS` 永远不开）。
3. **动作分级**：
   - 只读（snapshot / get_app_state）：随时可做
   - 可逆写（set_value / 点击筛选、切换标签）：可直接做
   - 不可逆（发送消息、投递、删除、支付）：**必须任务层显式声明 + 人工确认**，默认拒绝
4. **应用白名单**：任务必须声明目标应用，未在名单内不做。
5. **不碰 DeepSeek Harness 自身窗口**（overlay 已拦截绑定）。

## 三、并发模型（多应用同时控制）

- ocu 每次调用是独立会话，天然可以并行 bind 不同应用。
- **按应用加锁**：`/tmp/agentd-<bundleId>.lock`，同一应用的多个任务串行，不同应用可并行。
- 锁必须带超时（默认 120s），避免僵尸锁。
- 禁止两个任务同时往同一应用输入文本——这是唯一会互相破坏的操作。

## 四、展示层契约

overlay 监听 `127.0.0.1:7788`：

| 接口 | 用途 |
|---|---|
| `POST /status {text}` | 状态行 |
| `POST /log {text}` | 动作日志 |
| `POST /window {windowId}` | 缩略图目标 |
| `POST /visible {visible}` | 手动显隐 |
| `GET /health` | 状态查询（含 visible / activity） |
| `GET /windows` | 可绑定窗口列表 |

行为：有活动 → 淡入；最后一次活动后 8 秒 → 淡出隐藏（`OVERLAY_IDLE_HIDE_MS` 可调）。

## 五、覆盖率（2026-11-05 本机实测）

| 应用 | 节点数 | 可交互 | 结论 |
|---|---|---|---|
| Google Chrome | 893+ | 630+ | 好，网页内容完整可读 |
| Finder | 139 | 47 | 好 |
| Notes | 46 | 12 | 好 |
| Calculator | 39 | 24 | 好 |
| Telegram | 20 | 0 | 差（Electron，AX 暴露极少） |
| WeChat | - | - | 失败（cgWindowNotFound，需重试/激活一次） |
| App Store | 17 | 1 | 差 |

结论：**原生 AppKit 应用覆盖良好；Electron 类和部分 Catalyst 应用 AX 稀薄，需要兜底方案**
（CDP for Chromium 类，或 sky_click 坐标点击）。

## 六、已知失败模式

1. **锁屏**：macOS 锁屏后所有 AX 读取失败（`NSPOSIXErrorDomain Code=2`）。解决：解锁，或用 ocu locked-use。
2. **窗口在别的 Space / 被遮挡**：AX 可能读不到内容，缩略图也抓不到。
3. **前台被抢**：某些应用在 AX 动作时自我激活，护栏会中止任务。
4. **索引失效**：element index 只在同一 ocu 会话内有效（约 120s），跨调用必须重新取状态。

## 七、进展（2026-11-05）

- [x] 能力层：ocu 安装、权限、后台读/点/写全部实测通过
- [x] 任务层：BOSS 扫描（后台切标签页 → 读 15 条岗位 → 前台不变）
- [x] 展示层：手机画中画风格小窗，Space 固定、空闲 8 秒隐藏、拒绝绑定自身窗口
- [x] 并发：按应用加锁（withAppLock），Finder + Calculator 并行读取 2.9s 完成
- [x] 文档：ARCHITECTURE.md / flow/RECIPE.md / flow/SCAN.md

## 八、进展（2026-11-05 晚）

- [x] 写操作：文本框 / contenteditable / select / checkbox 四类控件后台可写，已闭环校验
- [x] 生产运行器：core/runner.mjs（注册表 / 重试 / JSONL 日志 / overlay 状态推送）
- [x] 端到端验收：core/acceptance.mjs，当前 6/6 PASS
- [x] CDP 兜底：core/cdp.mjs（零依赖 CDP 客户端），Electron 应用 13 项验收全过
- [x] 能力文档：CAPABILITIES.md

## 八点五、专用运行环境（关键设计）

用户的诉求是「像 Codex 一样在后台控制，不动我的前台」。要做到这点，自动化**不能复用用户正在用的窗口**。

| 目标类型 | 自动化环境 | 实现 |
| --- | --- | --- |
| 浏览器网页 | 专用 Chrome 实例 | `core/browser.mjs`：独立 user-data-dir + 屏幕外窗口 + 随机调试端口 + CDP |
| Electron 应用 | 离屏宿主实例 | `core/electron-task.mjs`：accessory + 透明 + 屏幕外 + CDP |
| 原生 App | 用户自身的窗口 | ocu AX（只在应用不在前台时操作） |

原则：**能用独立实例的，绝不碰用户的实例。** 用户的 Chrome 只读不写、不切标签页。

## 八点六、常驻部署（launchd）

两个服务都已注册为 LaunchAgent，登录自启、崩溃自动拉起：

| Label | 进程 | 端口 | plist |
| --- | --- | --- | --- |
| com.desktop-agent.daemon | node core/daemon.mjs | 7789 | ~/Library/LaunchAgents/ |
| com.desktop-agent.overlay | Electron overlay | 7788 | ~/Library/LaunchAgents/ |

管理：

```bash
launchctl print gui/$(id -u)/com.desktop-agent.daemon | head -20
launchctl kickstart -k gui/$(id -u)/com.desktop-agent.daemon   # 重启
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.desktop-agent.daemon.plist  # 停用
```

坑：launchd 给的进程没有登录 shell 环境，必须写 **node 的绝对路径** 并显式设置 HOME；否则会卡在模块加载阶段。

## 九、下一步

- [ ] CDP 兜底接入任务层（Electron 应用可直接用）
- [ ] 覆盖率补测：微信、系统设置（bundle id）、App Store
- [ ] 任务成功率统计与失败自动截图
- [ ] 用户可配置的任务白名单/黑名单
