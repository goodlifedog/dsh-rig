# 外部监控日志（评审侧维护，执行侧按需读取）

> 更新：2026-11-08 23:18

## 一、真实应用适配：第一次拿到「读」的证据

`adapter-demo --app Safari`（Safari 已在运行，只读）：

```
gate       ✅ Safari 已在运行，直接读
read-tree  ✅ 窗口="起始页"，nodes=105，按钮 40，输入区 1
echo       ✅ 小窗可回显：windowId=8767，截图 21045 字节
```

**读界面 + 小窗回显两条链路对 Safari 是通的。**

## 二、必改：front-unchanged 把系统通知浮层算成「前台被抢」

同一个命令连跑两次，结果自相矛盾：

| 次数 | front before → after | 判定 |
| --- | --- | --- |
| 第 1 次 | DeepSeek Harness → **UserNotificationCenter** | ❌ 假失败 |
| 第 2 次 | **UserNotificationCenter** → UserNotificationCenter | ✅ 假通过 |

根因：`UserNotificationCenter` / `NotificationCenter` 是系统通知浮层。
- 它中途出现 → 被当成目标应用抢前台（假失败）
- 它作为基线 → 「前后一致」毫无意义（假通过）

修法：
1. 维护一份「系统浮层进程」名单（`UserNotificationCenter`、`NotificationCenter`、`Window Server`、`loginwindow` 等），
   前台比较时忽略它们（但要记录「期间出现系统浮层」）
2. **基线校验**：baseline 是系统浮层时不要判 unchanged，标「基线无效，需重测」
3. 补两条单测：浮层中途出现不判失败；浮层作为基线时判「基线无效」

## 三、Antigravity：应用侧限制（不要再耗时间）

```
open -g -a Antigravity            → 无进程
直接执行二进制 --version          → v24.21.0（能跑）
bundle: com.google.antigravity, arm64, 有签名
```
结论：冷启动即退，不是工具问题。ADAPTERS 里记为「应用侧限制」。

## 四、当前风险名单（11 个，读取会抢前台）

`ChatGPT、Gemini、Ghostty、QQ、Steam、Telegram、UURemote、WPS Office、iRightMouse、文本编辑、预览`

优先级建议：Safari（读已通，下一步验点击）→ Chrome（CDP 已通）→ 再考虑名单外的新应用。
