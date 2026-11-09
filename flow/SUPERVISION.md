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

- 仓库对外化：无站点专用能力、无隐私（含历史）、无内部台账；名字 DSH Rig / dsh-rig / 0.8.0
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

## 十、必须处理：README 三张截图仍暴露已删的 BOSS 功能（2026-11-09 11:34）

评审侧逐张看了 README 引用的三张图，**删除 BOSS 不彻底——证据还在图片里**：

| 文件 | 图上可见 | 问题 |
| --- | --- | --- |
| overlay/docs/ui-live-small.png | 小窗胶囊「正在后台读取**岗位列表**」 | BOSS 残留字样 |
| overlay/docs/ui-live-expanded.jpg | 胶囊「正在后台读取**岗位列表** · 拟人节奏 1m36s」；顶部还有用户自己的会话标题「规划布局探讨…」 | BOSS 残留 + 用户工作内容 |
| overlay/docs/multi-session.png | 右侧会话「alpha · 正在读**职位列表**」 | BOSS 残留字样 |

README 正文已经把「岗位列表」改成「示例页面」，图却还是旧图——**图文不一致，而且图片是公开可读的**。
grep 搜不到字面量，只有看图才能发现；发布前必须处理。

建议修法（任选一种，优先第一种）：
1. 用中性目标页重新截：打开 examples/adapters/sample.html 或任一公开文档站，胶囊文案自然会变成通用描述；
   同时把 DSH 窗口标题挪出画面或换成不含个人会话名的标题；
2. 直接裁掉底部胶囊区域（保留画面主体），但会丢掉「状态胶囊」这个卖点展示；
3. 若要保留胶囊，至少把文案改成中性（需要重新截图，不能靠改图）。

范围确认：README 只引用了这 3 张（grep overlay/docs 只有 3 处）；其它图片未被 README/docs 引用。

## 十一、剩余 BOSS 残留（评审侧 11:34 复查，逐条可查）

| 位置 | 内容 | 建议 |
| --- | --- | --- |
| overlay/smoke-http.js:146,148 | 自检脚本仍用「正在筛选职位」做 /status 测试文本并断言它 | 换成中性文本（例如「正在读取示例页面」） |
| overlay/docs/multi-session.png | 仍显示「alpha · 正在读职位列表」；仓库里没有生成脚本，只能重截/重做 | 重截或裁掉文字 |
| core/run-classify.mjs | 环境跳过规则 /已联系/ 只是改了文案，判据仍是招聘业务状态 | 删除，或改成通用表述并说明为什么通用分类器需要它 |

已修好的（确认）：
- scripts/ui-gallery.mjs 的状态文案改为「示例页面」，并把 launchctl 旧标签 com.desktop-agent.overlay 换成 com.goodlifedog.dsh-rig.overlay（不改的话改名后抓图脚本重启不了小窗）
- README 两张图已重截（ui-live-small.png / ui-live-expanded.jpg）

新增观感问题：重截用的目标页是 example.com 占位页，页面正文写着「请勿将其用于测试和监控目的」——
桌面监控工具的 README 图里印着这句很别扭，建议改用 examples/adapters/sample.html 这类我们自己的本地页面重截。

## 十二、执行会话的「cleanup 0 残留」结论不成立（评审侧实测，2026-11-09 11:47）

它在 ADAPTERS 里写：备忘录实测「写入并读回 → cleanup 后 0 残留（带标记 0 条、空笔记 0 条）」。
评审侧复核发现**不成立**：

- 现场 1 条：Notes 文件夹里仍有 1 条 `[AGENT-TEST] adapter demo` 的笔记（活笔记）；
- 现场 2 条：Recently Deleted 里躺着 24 条 `后台控制验证：HH:MM:SS` 的测试笔记（11-08 凌晨创建，全部空正文）；
- 说明 `npm run cleanup:test -- --force` 只统计/清理活笔记，**没有清 Recently Deleted**。

这正是用户反复强调过的那类问题：删进「最近删除」等于没删。

评审侧已处理：删除 1 条活测试笔记 + 永久删除 24 条最近删除里的测试笔记；当前 Notes / Recently Deleted 均为 0 条、AGENT-TEST 命中 0。

**修法要求**：
1. `cleanup:test --force` 结束后要同时检查 Recently Deleted 并永久删除带标记/测试标题的笔记；
2. 报告里必须写清「活笔记/最近删除」两个数字，不能只报一个；
3. 加一条集成断言：清理后两处计数都为 0，否则判失败。

## 十三、独立复核通过的（正面结论）

- 计算器点击：`--click-text "7"` → 显示 0→7（AX 出现「4 文本 7」）→ `--click-text "清除"` → 回到 0；两次前台都是 DeepSeek Harness 未变。ADAPTERS 的 S 级结论成立。
- 新增 `docs/assets/demo.gif`（165KB / 18 帧 / 480×304）：抽查第 1、7、13、18 帧，内容是「等待目标窗口」与小窗胶囊「专用浏览器运行中/已关闭」的状态变化，没有个人信息、没有用户窗口内容。

## 十四、发布前检查表（评审侧 2026-11-09 12:14 实跑）

### 已通过（都有可复跑证据）

| 项 | 结果 | 复跑命令 |
| --- | --- | --- |
| 单测 | 1280 项 / 0 失败 | `npm test` |
| 发布自检 | 全部通过 | `npm run verify` |
| 仓库体检 | 全部通过 | `npm run repo:check` |
| 发布彩排 | 6 PASS / 0 SKIP / 0 FAIL | `node scripts/release-rehearsal.mjs --quick` |
| 包内容 | 173 文件 / 压缩约 600KB，无 flow/test/_archive 泄漏 | `npm pack --dry-run --json` |
| 隐私 | 跟踪文件无真实姓名/用户名/主机名/简历（命中项都是检查器自身与其测试） | 见 repo-check 隐私规则 |
| 服务 | 健康项 19 条全绿、daemon/overlay 代码新鲜度 ok | `npm run health`、`npm run service:status` |
| 包身份 | name=dsh-rig、bin=dsh-rig、repo=goodlifedog/dsh-rig、README 图片已换绝对地址 | `package.json` / `README.md` |
| 适配证据 | Safari/计算器/访达/备忘录/Chrome(CDP) 五个 S 级均已独立复现 | `adapter-demo`、`npm run cdp:channel` |

### 发布前必须由人决定的四件

1. **配置 remote 并推送**：仓库当前分支 main 但没有 remote；README 图片/徽章指向 raw.githubusercontent.com/goodlifedog/dsh-rig/main，不推就是 404。
2. **CI 矩阵**：`.github/workflows/ci.yml` 是 ubuntu/macos/windows 三平台、且没有 `npm ci` 步骤。本机模拟「无 node_modules 干净副本」跑 `npm test` 是通过的（1278/0），但 ubuntu/windows 的 macOS 依赖测试无法本地验证，徽章大概率红。建议收窄为 macos-latest，或给非 macOS job 加 continue-on-error。
3. **flow/SUPERVISION.md 去留**：这是评审侧监控日志，无个人信息与绝对路径，但属于过程记录；发布前建议移入 `_archive/`（已 gitignore）。
4. **微信适配**：需要登录态，建议用户在场时只读验证一次。

### 发布动作（用户确认后）

```
git remote add origin git@github.com:goodlifedog/dsh-rig.git
git push -u origin main
npm publish        # 0.8.0，publishConfig 已指向 npmjs，access=public
```
