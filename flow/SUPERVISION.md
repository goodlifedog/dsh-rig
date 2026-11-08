# 外部监控日志（评审侧维护，执行侧按需读取）

> 更新：2026-11-08 23:22

## 一、Safari 端到端适配已通过（评审侧实跑，可复现）

**命令与结果**：

```
node core/tasks/adapter-demo.mjs --app Safari --click-text "边栏"
  gate            ✅ Safari 已在运行，直接读
  read-tree       ✅ 窗口="起始页"，nodes=105，按钮 40，输入区 1
  click-by-text   ✅ 点中「显示边栏 ID: SidebarButton」index=81（contains）
                     节点数 105 → 112，新增「边栏」相关元素 111 条
  echo            ✅ windowId=8767，截图 21045 字节
  front-unchanged ✅ DeepSeek Harness → DeepSeek Harness

再跑一次同命令（点「隐藏边栏」）：nodes 112 → 105，恢复原状，前台仍未变。
```

**请把这条写进 docs/ADAPTERS.md**：Safari = 已适配（读 + 按文字点击 + 回显 + 前台不变 + 状态可还原），
附上可复制命令与输出摘要。这是目前唯一一个完整闭环的真实应用证据。

## 二、仍未修：front-unchanged 的系统浮层误判

同一命令曾两次结果相反（通知横幅中途出现→假失败；横幅作基线→假通过）。
修法见上一版：系统浮层名单 + 基线校验 + 两条单测。这次 Safari 跑通时没触发，但噪声场景仍会误判。

## 三、其余候选现状（adapter-demo 会如实环境跳过）

| 应用 | 状态 | 原因 |
| --- | --- | --- |
| Safari | ✅ 已适配（见上） | — |
| Antigravity | 应用侧限制 | `open -g` 拉不起来，冷启动即退 |
| TextEdit / Preview / QQ / WPS Office / Ghostty / ChatGPT / Gemini / Telegram 等 | 读取抢前台 | 在 front-risk 名单（11 个），工具拒绝、`--allow-launch` 也不绕过 |
| OpenCode | 应用侧限制 | 二进制拒绝 `--remote-debugging-port` |

## 四、下一批适配的建议顺序

1. Chrome：CDP 通道已通，用 `--app Chrome --file examples/adapters/sample.html --click-text "[AGENT-TEST] 提交" --allow-launch` 验一次完整闭环
2. 名单外的新应用：先用只读模式跑 `adapter-demo`（不加 --click-text），确认读树不抢前台后再点
3. 任何写操作（--type-text）先等「不覆盖用户内容」的守卫落地
