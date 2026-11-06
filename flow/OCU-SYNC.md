# 与 ocu 上游保持同步

> 我们的控制能力来自 open-computer-use。它活跃迭代（当前 1.1.3，还在 rc 阶段），所以我们既要跟，又不能盲目跟。

## 一、效率基线（本机实测）

`node scripts/bench-ocu.mjs 4`，目标 Google Chrome：

| 方式 | list_apps | get_app_state |
| --- | --- | --- |
| 每次 spawn CLI | 414ms（160–1169） | 80ms（78–81） |
| **MCP 常驻** | **114ms（110–121）** | **22ms（21–23）** |
| 提速 | 3.6× | 3.6× |

两点值得记住：

1. **MCP 不只是快，更稳**。CLI 最慢一次 1169ms（进程冷启动），MCP 抖动只有 ±10ms。
2. 升级 ocu 后要重跑这个基线。**如果新版反而变慢，先别跟**，等下一版或只在分支里试。

## 二、版本同步检查

```bash
node scripts/check-ocu.mjs
```

对比随包版本和 npm 最新版，不一致时给出同步步骤，并以退出码 2 结束（可放进 CI 定时任务）。

## 三、同步流程

```bash
npm i -g open-computer-use@latest          # 1. 装新版
node scripts/bundle-ocu.mjs --with-binary   # 2. 重新打进 third_party
node scripts/bench-ocu.mjs 4                # 3. 对比效率基线
npm run accept                              # 4. 回归验证
```

四步都过再提交。第 3 步是硬门槛：**效率倒退就不跟**。

## 四、什么情况下要改我们自己的代码

| 上游变化 | 我们要做什么 |
| --- | --- |
| 工具名/参数变了 | 改 `core/ocu-mcp.mjs` 的调用点、`core/tasks/*` 里的 args |
| 新增能力（比如新的点击方式） | 评估是否替换现有实现，先写 demo 验证 |
| 平台支持变化 | 同步 `core/platform.mjs` 的后端判断和 `flow/CROSS-PLATFORM.md` |
| 修了我们踩过的坑 | 删掉我们自己的兜底代码，避免双重逻辑 |

## 五、打包时的一致性

- 随包的 ocu 版本记录在 `third_party/open-computer-use/package.json`
- 二进制目录（bin/dist/scripts，37MB）不进 git，打包前用 `bundle-ocu.mjs --with-binary` 生成
- 发布前跑一次 `check-ocu.mjs`，确认包里带的是预期版本

## 六、为什么不 fork

见 `THIRD-PARTY.md`：fork 意味着自己维护 macOS/Windows 两套原生构建，且小窗要从 Electron 重写成 Swift。
当前策略是「跟随 + 定期验证」，把精力放在我们自己的调度、小窗和验收上。
