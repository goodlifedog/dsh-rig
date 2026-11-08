# 桌面代理能力矩阵

> 最后更新：2026-11-08 · 本机实测（macOS 26.5.1, arm64）；应用数量以 `npm run apps:inventory` 为准

## 一句话

通过 ocu（Accessibility 驱动）在**后台**操控 macOS 应用：读界面、点按钮、填表单，
不激活目标应用、不移动鼠标、不切换前台。Electron 类应用走 CDP 兜底。

## 能力

| 能力 | 状态 | 说明 |
| --- | --- | --- |
| 读取应用界面树 | ✅ | 后台可读，含 Chrome 网页内容 |
| 点击按钮/链接/标签页 | ✅ | accessibility 点击；被吞时重试 |
| 文本框输入 | ✅ | 点击聚焦 → cmd+a → sky_key 键入 |
| contenteditable 输入 | ✅ | 同上 |
| 下拉选择（select） | ✅ | 点开菜单 → 点 AX 菜单项；set_value 无效 |
| 复选框切换 | ✅ | AXPress 直接切换 |
| 多应用并行 | ✅ | 按应用加锁，Finder+Calculator 并行 2.9s |
| 小窗展示/空闲隐藏 | ✅ | 有活动即出现、5 秒空闲隐藏、不跟随 Space |
| 专用浏览器（不碰用户窗口） | ✅ | 独立 profile + 离屏窗口 + CDP，用户前台完全不受影响 |
| Electron 应用控制 | ✅ | electron-task.mjs 封装，离屏宿主，10/10 验收 |
| 多应用并行 | ✅ | 按应用加锁 |
| 原生无 AX 应用（如 Telegram） | ❌ | AX 只有 20 节点，只能坐标点击兜底 |

## 关键约束（安全）

1. 绝不激活目标应用：每次动作前后校验前台，一旦被控应用变前台立即中止。
2. 不可逆动作（发送/投递/删除/支付）默认拒绝，必须任务显式声明 + 人工确认。
3. 不绑定 DeepSeek Harness 自身窗口（overlay 返回 403）。
4. 不用全局指针兜底（OPEN_COMPUTER_USE_ALLOW_GLOBAL_POINTER_FALLBACKS 永远不开）。

## 已知坑（实现时注意）

- element index 只在同一个 ocu 会话内有效（约 120s），跨调用必须重新取状态。
- AX 树有 0.5~2s 延迟，动作后要轮询判定。
- 点击可能被吞，需要重试；关闭弹层要点 ×，不是再点开它的按钮。
- 内层 JS 模板不要用普通模板字符串，\n/\t 会被提前转义 → 用 String.raw。
- 锁屏后所有 AX 读失败（NSPOSIXErrorDomain Code=2）。
- 窗口在别的 Space 时拿不到 CGWindow，缩略图绑不上。

## 验收

```bash
cd desktop-agent && node core/acceptance.mjs
```

当前结果：全部通过（明细见 `reports/acceptance-<时间戳>.md`；环境不具备的项会标「环境跳过」，不算失败）。
