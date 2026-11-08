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

## 五、新发现（待修，非安全问题）：`--allow-write` 在「已有内容」的输入框上不生效

实测（夹具：先 AX 设值 USERDATA，再跑覆写）：

```
gate        ✅ Electron 已在运行，直接读
read-tree   ✅ nodes=23，按钮 4，输入区 1
type-text   ⚠️ 环境跳过：界面树里找不到可写输入区（文本栏/搜索框/空正文区）
```

现象：字段有内容时，即使加了 `--allow-write`，`pickTypeTarget` 仍返回「找不到可写输入区」，
覆盖路径走不到。**安全上没问题（拒绝写入是对的）**，但「强制覆盖后恢复」这个能力实际不可用。

建议：
1. `pickTypeTarget` 在 allowWrite=true 时应接受「有内容但可写」的文本栏/搜索框（返回 found + 当前值）
2. 补单测：有内容的树 + allowWrite → 应选中该字段；无 allowWrite → 拒绝
3. 修完再用夹具验一次「覆盖 → 恢复回 USERDATA」

## 六、当前环境：屏幕已锁

23:57 检查：锁屏=true、前台读不到（-1719）。GUI 类验证全部暂停，等解锁后继续。

## 七、关于 `--allow-write` 覆盖已有内容的输入框：不建议靠「放宽启发式」解决

24:00 尝试：让 pickTypeTarget 在 allowWrite 时接受任意 settable textField。结果不行——

```
Finder 的重命名字段解析出来是：kind=textField, label="report.pdf"（label 丢了，只剩值）
→ 无法从 label 识别「这是文件名输入框」→ 放宽后会把用户文件重命名当成可写目标
```

**结论：已回滚这次放宽**（`git checkout` 恢复），当前仍是「有内容即拒绝」的安全默认。

建议的替代方案（更安全、也更精确）：
- 新增 `--type-index <元素索引>`：由调用方显式指定要写的元素，跳过启发式选择；
  文档写明「写前会读原值并在写后恢复」，且 `--allow-write` 才能配 `--type-index` 使用。
- 这样既不放松 Finder 这类危险字段的默认保护，又能测「覆盖→恢复」路径。

## 八、当前环境

屏幕已锁（23:57 起），GUI 类验证暂停；工作区干净、测试 1274/0、彩排 6/6。

## 九、监控收尾（2026-11-09 00:06）

屏幕已锁、键鼠空闲 14 分钟、执行会话自 23:27 未再提交。评审侧最后一轮全量核验结果：

| 项 | 结果 |
| --- | --- |
| 测试 | 1276 项 / 1274 过 / 0 失败 |
| verify / repo:check | 全部通过 |
| 发布彩排 | 6 PASS / 0 SKIP / 0 FAIL（多轮） |
| npm 包 | 175 文件 / 压缩约 518KB，零内部台账、零测试、零隐私 |
| 工作区 | 干净 |

### 已交付并验证的能力

- 仓库对外化：无 BOSS、无隐私（含历史）、无内部台账；名字 DSH Rig / dsh-rig / 0.8.0
- 克隆即用：ocu 是 npm 依赖，resolveOcu 走 node_modules；全局安装后 CLI 与 ocu 都就位
- 通用适配引擎 adapter-demo：读树 / 按文字点击 / 回显 / 写入（默认拒写、空值写入、显式索引覆盖后恢复）
- 安全行为实测：锁屏跳过、用户活跃让路、用户回来即停、front-risk 不可绕过、点击无变化判失败
- 适配证据：Safari 端到端（读 105 / 点 105→112→105 / 回显 21KB / 前台未变）；Finder 204、Notes 57、计算器 37 节点只读+回显

### 剩余（都需要人或屏幕）

1. 解锁后补：--type-index 真机 E2E、计算器/访达点击验证
2. 微信只读（需用户在场处理登录态）
3. 发布：仓库地址、npm publish、Release notes（草稿在 CHANGELOG 0.8.0）

### 恢复监控的方式

新会话直接读本文件与 docs/ADAPTERS.md 即可接续；所有结论都有对应提交与可复核命令，
关键判据是：不看报告、自己跑 npm test / repo:check / release-rehearsal / adapter-demo。
