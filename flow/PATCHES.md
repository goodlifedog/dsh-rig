# 外部评审提供的补丁（按需应用）

> 这些不是必须打的。每个都独立可应用、互不冲突，打过之后 `npm test` 全绿。
> 最后更新：2026-11-08 04:05。**当前只剩 1 个**（`patch-publish.diff`，涉及包名/仓库地址，等用户决定）；
> 死代码合并与代码新鲜度两个补丁已应用并删除，其余都已被主会话自行实现。

## 应用程序

```bash
git apply flow/patch-publish.diff            # 发布配置（发布前必打）
git apply flow/patch-prune-consolidate.diff  # prune 死代码合并（建议打）
# patch-title-gate 已应用（标题门控去掉裸子串匹配），文件已删
# patch-watchdog-hid 已应用（看门狗 HID 判据），文件已删
npm test && npm run repo:check
```

## 1. `patch-publish.diff`（78 行 / 3 个文件）— 发布前必打

- 包名换 scoped（`@goodlifedog/desktop-agent`，原名在 npm 被占）
- 补 `bin` / `files` 白名单 / `repository` / `publishConfig`（绕开本机淘宝镜像指向官方源）
- `files` 额外排除评审与补丁类文档（`flow/REVIEW-*.md`、`flow/patch-*.diff` 等），并把 `ARCHITECTURE.md` 纳入
- CI 矩阵收窄到 macOS；README 徽章 `USER` → 真实用户名

应用后手动改两处：npm 用户名、GitHub 仓库地址。

验证：
```bash
npm publish --dry-run   # 必须显示 Publishing to https://registry.npmjs.org ... public access
npm pack --dry-run      # 约 138 files / 1.1 MB
```

## 2. ✅ `patch-prune-consolidate.diff`（120 行 / 3 个文件）—— 已应用，补丁文件已删除

`core/prune.mjs` 的四个导出全仓零引用，真实逻辑在 `scripts/prune.mjs` 里另有一份。
补丁把 `planPrune` 归位到 `core/prune.mjs`，`scripts/prune.mjs` 只留 CLI，测试改 import。

验证：`node scripts/prune.mjs`、`node --test test/prune.test.mjs`

## 3. ✅ `patch-deploy-freshness.diff`（191 行 / 3 个文件）—— 已应用，补丁文件已删除

给 `npm run service:status` 加「代码新鲜度」：把每个常驻进程启动时加载的模块 mtime 与进程启动时间比，
落后就提示 `npm run service:restart`（只提示，不自动重启）。

验证：`touch core/agentd.mjs && npm run service:status` 应出现「落后 —— core/agentd.mjs 比进程新 N 分钟」。

## 4. ✅ `patch-watchdog-hid.diff`（103 行 / 2 个文件）—— 已应用，补丁文件已删除

**问题**：`front-watch` 判断「用户自己在切」只看次数——同一应用在 1.5 秒内抢 3 次就认账、不再还原。
但「应用自己反复 activate」与「用户手动切」在代码里长得一样，前者会导致该还原时不还原。

补丁：`hidIdleMs()` 读 `ioreg -c IOHIDSystem` 的 `HIDIdleTime`（纳秒→毫秒），
**最近 1.5 秒内有键鼠输入才算用户意图**；读不到 HID 时才退回旧的「反复切」启发式。
配 2 条新测试：用户刚动过（idle 120ms）→ 一次就认账、不还原；用户一分钟没动 → 应用反复自激活也继续还原。

验证：
```bash
node --test test/front-watch.test.mjs   # 7 项全过
```

## 5. ✅ `patch-textedit-guard.diff`（146 行 / 3 个文件）—— 已应用，补丁文件已删除

**数据安全问题**：`background-control` 第 6 步直接 `setValue('文本编辑', textAreas[0].index, '后台写入：…')`，
而 `set_value` 是**覆盖**语义——用户开着有内容的文稿时跑验收，内容直接被盖掉，清理脚本也救不回。

补丁新增 `core/text-edit-guard.mjs`：用 AppleScript 取「每个文稿的名字 + 文本长度」，
**只有全部是「未命名 + 空」时才允许写**；有命名文稿、有内容、读不到状态都跳过并记 SKIP。
配 5 条单测（解析、放行、三种拒绝、读不到状态、空文稿）。

验证：
```bash
node --test test/text-edit-guard.test.mjs
```

## 4. ✅ patch-title-gate.diff（40 行 / 2 个文件）—— 已应用，补丁文件已删除

**问题**：会话标题门控用 host.indexOf(hint) 裸子串匹配，实测：
  hint 规划布局探讨 vs host 规划布局探讨（二） → true（误判），
  同时开两个名字相近的会话时，A 的小窗会跑到 B 里显示。

补丁：全等直接通过；否则允许「去掉 hint 后只剩标点/符号/空白」（宿主标题带状态点、装饰符的情况），
其余一律不匹配。配 2 条测试（相近名字互不点亮、装饰后缀仍算同一会话）。

验证：
```bash
node --test test/session-gate.test.mjs   # 7 项全过
```

## 已采纳并删除的补丁（留档，不要再找）

| 补丁 | 落地情况 |
| --- | --- |
| `patch-p1.diff` | 七项修复由主会话自行实现（含测试），补丁作废 |
| `patch-classify.diff` | `envSkipReason` 的 ❌ 覆盖已落地 |
| `patch-electron-task-test.diff` | 5 条单测已落地 |
| `patch-ensure-app-window-test.diff` | 与 `test/app-window-ready.test.mjs` 重复，未采纳 |
| `patch-chromium-applescript.diff` | chromium 通道链已加 applescript |
| `patch-token-permissions.diff` | 主会话的 `hardenDataDir` 更完整 |
| `patch-host-check.diff` | `isLoopbackHost` 已落地 daemon 与 overlay |
| `patch-dialog-i18n.diff` | 主会话改成结构判定 + `unknown` 不点，比补丁更稳 |
| `patch-retry-unify.diff` | `retry-policy` 已复用 `ENV_RULES` |
| `patch-health-queue.diff` | `health` 队列显示已改读 `queueLength` |
| `patch-formfill-restore.diff` | 主会话改成「catch 里补一次 restore-after-error」，语义等价且不会在成功路径重复写 |
| `patch-textedit-guard.diff` | 已采纳：core/text-edit-guard.mjs 落地，background-control 写入前先判空文稿 |
| `patch-cleanup-idle.diff` | 主会话做得更全：launchedByUs + shouldQuitApp + HID 空闲，三条件都判 |
| `patch-deploy-freshness.diff` | 已采纳：core/deploy-freshness.mjs + service.mjs 接线，并补了单测 |