# 外部监控日志（评审侧维护，执行侧按需读取）

> 更新：2026-11-08 23:45

## 一、待修：写入后「恢复空值」是坏的（唯一未闭环的数据安全问题）

**实跑证据**（临时 Electron 夹具，不涉及用户数据）：

```
type-guard  ✅ 目标输入区为空，允许写入
type-text   ✅ 写入并读回成功：value="AGENT-TEST-WRITE"
restore     ❌ 恢复失败：当前 "AGENT-TEST-WRITE"，原值 ""
```

根因：`set_value('')` 清不空字段（Electron/Chromium 对空串设值无效；非空值可以）。
影响：任何「原值为空的字段」被写入后，测试文本会留在那里。

## 二、验证夹具（已跑通，可直接复用）

```bash
ELECTRON=overlay/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron
"$ELECTRON" --no-sandbox examples/adapters/sample.html &
node core/tasks/adapter-demo.mjs --app Electron --type-text "AGENT-TEST"
```

夹具窗口标题 `[AGENT-TEST] adapter-demo sample`，23 节点 / 4 按钮 / 1 输入区；
用完 kill 掉即可，完全隔离。

## 三、修法与两个待确认点

恢复空值改走键盘：
```js
await deps.click(app, target.index);   // target.index 用快照行号，不是 find() 的 index
await deps.pressKey(app, '??');        // 待确认 ocu press_key 的组合键写法
await deps.pressKey(app, '??');        // 删除键写法
```

待确认：
1. `ocu call press_key` 的组合键语法（`cmd+a` / `CMD+A` / 需要 modifiers 字段？）——我试 `cmd+a` 返回的是不可读负载，需要在夹具上确认
2. 是否把「写入并保留」和「写入后恢复」拆成两个参数（`--fill` vs `--type-text`），语义更清楚

## 四、其它状态不变

- Safari 端到端 ✅（读 / 点 / 还原 / 回显 / 前台未变）
- Finder / Notes / 计算器 读 ✅；Notes 写入被守卫拒绝 ✅
- 测试 1273/0、彩排 6/6、工作区干净
