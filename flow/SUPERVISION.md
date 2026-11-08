# 外部监控日志（评审侧维护，执行侧按需读取）

> 更新：2026-11-08 23:49

## 一、已修复并复验：写入后「恢复空值」

修复（提交 e592865）：抽出 clearFieldByKeyboard（聚焦 → cmd+a → DELETE），恢复原值为空时不再用 set_value('')。

夹具 E2E 复验通过（评审侧实跑，夹具为自建 Electron + examples/adapters/sample.html）：

    type-guard  ✅ 目标输入区为空，允许写入
    type-text   ✅ 写入并读回成功：value="AGENT-TEST-WRITE"
    restore     ✅ 已恢复原值：""
    user-return ✅ 用户回到电脑前（键鼠 1 秒前动过），已立即停止，不再操作应用

额外收获：user-return 中途让路逻辑也在实机验证通过。

## 二、当前适配证据矩阵

| 应用 | 读 | 点击 | 回显 | 写入 | 前台未变 |
| --- | --- | --- | --- | --- | --- |
| Safari | ✅ 105 | ✅ 105→112→105 | ✅ 21KB | 空栏可写+清空 | ✅ |
| Finder / 访达 | ✅ 204/87 | 未试 | 如实跳过 | — | ✅ |
| Notes / 备忘录 | ✅ 57 | 未试 | 如实跳过 | ✅ 有内容时拒写 | ✅ |
| 计算器 | ✅ 37 | 未试 | ✅ 57KB | — | ✅ |
| Electron 夹具 | ✅ 23 | 未试 | — | ✅ 写+恢复空值 | ✅ |
| Chrome | ❌ AX 不可读 | — | — | — | 应走 CDP |

## 三、剩余工作

1. 计算器/访达补点击验证（读已通）
2. 微信只读（需用户在场，登录态相关）
3. 发布：仓库地址、npm 名、四个决定

## 四、待验证清单（下一空闲窗口，用户离开 ≥180s）

1. **非空恢复**：先往夹具字段写 USERDATA，再 `--type-text AGENT-TEST --allow-write`，
   预期：允许覆盖 → 写入成功 → 恢复回 USERDATA（当前只验过「恢复为空」）
2. 计算器 / 访达 点击验证（读已通）：`--click-text` 后比对节点数变化，确认后还原
3. 微信只读（需用户在场）：`--app 微信`，只读不点

夹具命令（自建、用完即杀、不碰用户数据）：

```bash
ELECTRON=overlay/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron
"$ELECTRON" --no-sandbox examples/adapters/sample.html &
node core/tasks/adapter-demo.mjs --app Electron --type-text "AGENT-TEST" --allow-write --min-idle 0
```

旁证：`--help` 已列出 `--allow-write` / `--min-idle`，参数不是暗桩。
