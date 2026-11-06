# 按 Codex 标准对齐

> 依据：open-computer-use 是对 Codex Computer Use 的开源复刻，其 ARCHITECTURE.md 描述了 Codex 的实际做法。

| Codex 的做法 | 我们的实现 | 状态 |
| --- | --- | --- |
| 用 Accessibility 语义树控制，不是截图猜坐标 | ocu + AX，click 走 accessibility 语义点击 | ✅ 已有 |
| 屏幕上的软件光标指示操作点 | 小窗内的虚拟箭头（不污染桌面） | ✅ 已有（桌面全局光标已关） |
| 目标窗口可移到 agent 专用显示区，不占用户屏幕 | 离屏 Chrome / 离屏 Electron 宿主 | ✅ 已有 |
| 每轮结束清理浮层、恢复现场 | 空闲 5 秒自动隐藏、DSH 不在前台隐藏 | ✅ 已有 |
| 动作有语义边界，不误点静态文本 | 详情标题校验后才点沟通 | ✅ 已修 |
| 会话级隔离 | 每个会话一个窗口 | 🚧 overlay-multi 在做 |

## 关键差异（我们比 Codex 更克制的地方）

- Codex 的软件光标画在**整个桌面**上；我们只画在**小窗预览**里，桌面保持干净。
  （桌面全局光标已用 OPEN_COMPUTER_USE_VISUAL_CURSOR=0 关闭）
- Codex 需要用 agent display 搬窗口；我们优先用**独立实例**，根本不碰用户的窗口。

## 待办

- [ ] 点击时把落点同步到小窗预览的虚拟光标（现在只有拟人鼠标轨迹会更新它）
- [ ] 会话隔离（overlay-multi）
