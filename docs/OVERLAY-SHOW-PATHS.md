# 小窗显示路径审查：确认不会再乱弹

- 审查对象：desktop-agent/overlay（Electron 小窗）
- 代码版本：desktop-agent@1d36951（main 分支，2026-11-08 15:30）
- 审查方式：只读静态审查 + 允许范围内单测（未启动 overlay、未启动任何应用、未截图）
- 相关背景：CHANGELOG.md:5 记录的「ready-to-show 无条件 showInactive」修复；会话标题门控见 overlay/README.md:66、验收记录见 overlay/README.md:387
- 本文只写审查结论与建议，不改业务代码

> 2026-11-08 task-27 更新：R1–R6 已修复落盘（见第 9 节）。第 3–5 节保留修复前的路径快照，行号以修复前代码为准；修复后的位置与验证点见第 9 节。

## 0. 结论（先看这里）

1. 代码里能让窗口真正可见的调用只有 3 处，全部是 win.showInactive()，没有任何 win.show() / focus() / moveTop() / restore()：
   - overlay/main.js:1619（ready-to-show 首显，四条件门控）
   - overlay/main.js:888（showOverlay，活动驱动的统一入口，缺 hostVisible 门控）
   - overlay/main.js:540（attachToDsh 的 re-show 分支，门控完整但显示序列不完整）
2. 原来「新建会话窗口瞬间无条件冒出来」的 bug 确实修掉了：默认冷启动的 default 会话没有活动，ready-to-show 判定 hasActivity=false 会直接隐藏（overlay/main.js:1603-1616）。
3. 但**还不能宣称「绝不会乱弹」**。仍存在 2 条 P1、4 条 P2 残余路径（详见第 5 节），核心是：
   - showOverlay 这条主漏斗只查「前台 + 标题」，**不查 hostVisible、也不查宿主快照是否新鲜**（overlay/main.js:868-897）。宿主最小化/隐藏（Cmd+M）后 5 秒内来一条 /log，窗口会短暂出现，等 attach 轮询（约 0.4–2.5s）再收走。
   - 冷启动第一个 attachTick 完成前，hostVisible 初值是 true（overlay/main.js:438）、frontmostBundle 是 null（overlay/main.js:611）、dshTitle 是空串，而门控对「读不到前台/标题」是 fail-open（overlay/main.js:863、overlay/main.js:525、overlay/session-gate.js:20-21、59）。此时任何活动都可能直接显示。
4. 结论一句话：**默认配置下正常切换应用/桌面不会再弹；但「宿主最小化/隐藏 + 有活动」「冷启动最初约 0–2 秒内有活动」「前台或 CGWindowList 读取失败」「会话尚未绑定 titleHint 时 /frame、/window、/visible 先到」这四种条件下仍可能短暂闪出**。建议至少修完 R1、R2（P1），再修 R3、R4（P2）后才对外说「不会乱弹」。

## 1. 审查范围与方法

- 覆盖 overlay/ 下所有 JS（main.js、session-gate.js、server.js、renderer.js、preload.js、recover.js、supervisor.js、host-select.js、session-policy.js、crash-log.js、capture-policy.js），并顺着 HTTP 调用方（core/、scripts/、flow/）确认触发场景。
- 没有运行 overlay（用户正在电脑前，禁止显示窗口）；没有运行 npm run overlay / verify:live / acceptance / monitor / ui-regression / session-scope-check / fps-check。
- 允许范围内跑的单测（全部纯函数，不启动 Electron/窗口）：
  - node --test test/overlay-session-gate.test.mjs test/session-gate.test.mjs test/overlay-recover.test.mjs test/host-select.test.mjs test/session-policy.test.mjs test/overlay-crash-log.test.mjs test/overlay-server.test.mjs → 60 条全过
  - node --test test/overlay-csp.test.mjs test/overlay-packaging.test.mjs → 5 条全过

## 2. 门控模型（判断每条路径的基准）

### 2.1 四个门控的数据来源

| 门控 | 数据来源（文件:行） | 判定语义 | 未知/读取失败时 |
| --- | --- | --- | --- |
| hostVisible | overlay/main.js:438（初值 true）；每次 attachTick 用 CGWindowList OnScreenOnly 查宿主窗口，overlay/main.js:626-640；通道失败时 fallback 读 System Events bounds，overlay/main.js:641-655 | 屏幕上真的存在宿主窗口（最小化/隐藏/别的 Space 时为 false） | 通道失败时**保持旧值**，fallback 成功则置 true（可能用陈旧 bounds，fail-open） |
| 前台 host | readHostSnapshot 每次轮询取 NSWorkspace.frontmostApplication（overlay/main.js:382-420），存到 frontmostBundle（overlay/main.js:611） | 前台 bundle 在 HOST_BUNDLES（默认 com.deepseek.dsh）里，或等于 self | front 为空时 hostFrontmostOk 返回 true（overlay/main.js:863）、attachToDsh 的 frontOk 也放行（overlay/main.js:525）；fail-open |
| 标题 title | dshTitle 来自宿主窗口标题（overlay/main.js:632/649）；titleMatches 见 overlay/main.js:511-513；纯函数在 overlay/session-gate.js:19-34 | 会话 titleHint（去后缀）与宿主标题（去后缀）一致，或只差标点/符号 | titleHint 未绑定 → 直接放行；宿主标题为空 → matchesTitle 返回 true（overlay/session-gate.js:20-21），fail-open |
| 活动 activity | state.lastActivityAt 由 markActivity 更新（overlay/main.js:925-929） | 有动作日志/状态/外帧/绑定窗口/手动显示；ready-to-show 要求 lastActivityAt 或 pinned 存在 | 没有活动 → ready-to-show 不显示（这条是原 bug 的修复核心） |

### 2.2 强制收敛循环（轮询兜底）

- attachTick：overlay/main.js:615-676，按 attachDelayMs（overlay/main.js:679-688）轮询：有窗口露头 400ms、被会话门控藏起 700ms、全隐藏 1500ms（overlay/main.js:83-86）。
- 每轮对每个会话调用 attachToDsh：overlay/main.js:515-554。hostVisible/front/标题任一不满足就 win.hide()（overlay/main.js:526-533）；条件恢复且 pinned 或活动在 idle 窗口内时 re-show（overlay/main.js:535-543）。
- 兜底：state.visible=false 但窗口实际还 visible 时强制 hide（overlay/main.js:663-670）；另有 HARD_HIDE_MS 强藏（overlay/main.js:556-599）。

## 3. 全部显示路径总表

「门控」列说明该路径是否分别经过四个条件；「结论」是本次审查判断。

| # | 路径 / 入口 | 实际显示调用（文件:行） | hostVisible | 前台 | 标题 | 活动 | 结论 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 会话窗口首次 ready-to-show（ensureSession → createWindowForSession；overlay/main.js:246、1598-1626） | win.showInactive() @ overlay/main.js:1619 | 查（但初值为 true，overlay/main.js:438） | 查（front 为空放行，session-gate.js:59） | 查（无 hint / 宿主标题空放行） | 查（hasActivity，overlay/main.js:1609） | 已修；冷启动竞态 fail-open → P1（R2） |
| 2 | POST /log（action）→ pushLog → markActivity → showOverlay | win.showInactive() @ overlay/main.js:888 | **不查** | 查（空/陈旧放行） | 仅 titleHint 存在时查 | 本身即活动 | 主漏斗缺 hostVisible/新鲜度 → P1（R1） |
| 3 | POST /status → setStatus → markActivity → showOverlay | 同上 | **不查** | 同上 | 同上 | 本身即活动 | 同上；clear:true 也算活动 → P2（R4） |
| 4 | POST /window 绑定成功 → setWindowId → markActivity | 同上 | **不查** | 同上 | 该入口**不自动绑定** titleHint（overlay/main.js:1809-1820） | 本身即活动 | 标题门控可整段跳过 → P2（R3） |
| 5 | POST /frame（外部帧）→ pushExternalFrame → markActivity | 同上 | **不查** | 同上 | 该入口**不自动绑定** titleHint（overlay/main.js:1822） | 本身即活动 | 同上 → P2（R3） |
| 6 | POST /visible {visible:true} → setVisibleManual → showOverlay | 同上 | **不查** | 同上 | 该入口**不接受 titleHint**（overlay/server.js:319-334、overlay/main.js:1821） | pinned 恒算活动 | 显式接口，但仍受前台门控；标题门控可跳过 → P2（R3） |
| 7 | attachToDsh 的 suppressBySession 恢复分支（条件恢复后 re-show） | win.showInactive() @ overlay/main.js:540 | 查（overlay/main.js:526） | 查（空放行，overlay/main.js:525） | 查（s.matched） | 查（pinned 或 withinIdle，overlay/main.js:538-539） | 门控完整；但显示序列缺 opacity/fade，可能「显示但看不见」→ P2（R5） |
| 8 | 渲染进程崩溃后 reload（overlay/main.js:1568-1586） | 不显示；只 win.reload()（overlay/main.js:1584） | - | - | - | - | ready-to-show 是 once（overlay/main.js:1598），已消费后 reload 不会重跑；无新增显示路径 |
| 9 | 放大 toggleExpand（IPC overlay:toggle-expand overlay/main.js:1946-1949；HTTP /expand overlay/main.js:1823） | 不显示；只 setBounds（overlay/main.js:1890/1893） | - | - | - | - | 隐藏态先 /expand 后，下次显示会直接是大窗 → P3（R6） |
| 10 | 窗口拖动 win.on('move')（overlay/main.js:1629-1642） | 不显示；只把窗口夹回 DSH 范围 | - | - | - | - | 无风险 |
| 11 | 抓帧失败自动找回 recoverTarget（overlay/main.js:1402-1427，recover.js:17-46） | 经 setWindowId → markActivity → showOverlay（#2） | 同 #2 | 同 #2 | 同 #2 | 同 #2 | 隐藏时抓帧暂停（overlay/main.js:1148），默认不会从隐藏态触发；OVERLAY_CAPTURE_WHILE_HIDDEN=1 时会 → P3（R8） |
| 12 | 宿主切走/最小化/别的 Space 时 attachToDsh 强制 hide（overlay/main.js:527-533、663-670） | win.hide() | - | - | - | - | 只隐藏，无显示风险；这是轮询兜底 |
| 13 | 标题变化 setTitleHint 立即 hide（overlay/main.js:501-507） | s.win.hide() | - | - | - | - | 只隐藏 |
| 14 | 空闲隐藏 hideOverlay / hideGuard（overlay/main.js:899-923、587-599） | win.hide() | - | - | - | - | 只隐藏 |
| 15 | 冷启动 default 会话（overlay/main.js:2032） | ready-to-show 判定 hasActivity=false → hide（overlay/main.js:1611-1616） | 查 | 查 | 查 | 查 | 正常冷启动不会弹（符合修复目标） |
| 16 | 第二个实例 second-instance（overlay/main.js:2052-2059） | 无任何 win 操作 | - | - | - | - | 无风险 |
| 17 | 所有窗口关闭 window-all-closed（overlay/main.js:2094-2096） | 只打日志，不退出、不再显示 | - | - | - | - | 无风险 |
| 18 | app.dock.hide / accessory（overlay/main.js:2021-2025） | 不显示 | - | - | - | - | 无风险 |
| 19 | 后台 daemon supervisor.startDaemon（overlay/supervisor.js:68-101） | 只 spawn core/daemon.mjs（overlay/supervisor.js:74-83），无窗口 | - | - | - | - | 无风险 |
| 20 | 启动入口 overlay/start.mjs:23、scripts/start-all.mjs | 只 spawn Electron；窗口仍走 #1 | - | - | - | - | 无额外显示路径 |
| 21 | 错误态按钮「打开设置」overlay/main.js:1015-1018 | shell.openExternal 系统设置（另一个 App 的窗口） | - | - | - | - | 不是 overlay 窗口；仅可见窗口按钮触发 |
| 22 | 配置 OVERLAY_ATTACH_DSH=0（overlay/main.js:42） | 走 #2/#1，但 hostFrontmostOk 恒 true（overlay/main.js:862）、attach 不 hide | **门控整体关闭** | 关 | 宿主标题空 → 放行 | 仅活动 | 仅独立使用模式；默认不开 → 配置风险（R10） |
| 23 | 浏览器内 DSH 宿主（host-select.js:22-50） | 走 #1/#2，hostVisible/标题来自浏览器窗口 | 查 | 默认 HOST_BUNDLES 不含浏览器 → fail-closed 不显示 | 查 | 查 | 默认安全（不显示）；要生效需配 OVERLAY_HOST_BUNDLES |
| 24 | 多显示器（initialWindowPosition，overlay/main.js:1519-1527） | 窗口固定建在主屏右上角 | - | - | - | - | 宿主在前台但用户在副屏时，主屏可能冒出小窗 → P3（R9） |

补充：除此之外全量 grep 未发现 win.show()、win.focus()、moveTop、restore、minimize、maximize、setVisibleOnAllWorkspaces 调用（overlay/main.js:1591 只是注释）。state.visible=true 但窗口未真正显示的中间态只出现在 showOverlay 的「还没 ready」分支（overlay/main.js:881-883），只影响 /health 与回收判定，不影响屏幕。

## 4. 重点路径逐条审查（任务点名项）

### 4.1 ready-to-show（overlay/main.js:1598-1626）

- 四个条件由 shouldShowOnReady 计算（overlay/main.js:1603-1610；纯函数 overlay/session-gate.js:47-61）。
- 不满足时：win.setOpacity(0) + win.hide() + state.visible=false + suppressBySession=true（overlay/main.js:1611-1616）；满足时：setOpacity(0) → showInactive → fade 到 1（overlay/main.js:1618-1625）。
- 已知单测覆盖：test/overlay-session-gate.test.mjs:1-40（7 条，含 front 为空放行、hasActivity=false 不显示）。
- 残余问题：hostVisible 初值 true（overlay/main.js:438）且 hostCheckedAt=0（overlay/main.js:440），front 为空放行、宿主标题为空放行；首个 attachTick 完成前（正常几十到几百毫秒，osascript 超时上限 2s）若恰好有活动，四条件实际只剩 hasActivity 是真门控 → 可能显示。归入 R2。

### 4.2 markActivity → showOverlay（overlay/main.js:925-929 → 868-897）

- 所有 HTTP 活动最终都汇到这里：/log 的 action 日志（overlay/main.js:966）、/status（overlay/main.js:981）、/frame（overlay/main.js:1136）、/window 绑定（overlay/main.js:1383）、/visible true（overlay/main.js:936）。
- 它只做两道检查：titleHint 存在且不匹配则 return（overlay/main.js:872-875）；hostFrontmostOk 为 false 则 return（overlay/main.js:877-880）。
- **没有检查 hostVisible，也没有检查 host 快照是否新鲜**（hostCheckedAt/lastAttachAt）。这是本次审查最主要的缺口 → R1。
- 具体可复现触发（静态推导）：
  1. 用户按 Cmd+M 最小化 DSH 窗口（app 仍是前台，front=com.deepseek.dsh，hostVisible=false），5 秒内 agent 推 /log → showOverlay 判定 hostFrontmostOk=true → showInactive → 窗口浮在别的窗口/桌面上，直到下一轮 attachTick（最快约 400ms，osascript 慢时可达 2s+）发现 hostVisible=false 才 hide。
  2. 冷启动后第一个 attachTick 尚未完成（frontmostBundle=null、hostVisible=true 初值、dshTitle 为空），任一带 session 的活动到达 → showOverlay 全放行 → 短暂显示。
  3. 宿主轮询读取失败（osascript/JXA 失败、TCC 限制）时，front 为空 → hostFrontmostOk=true；CG 通道失败时 hostVisible 可能保留旧 true 或由 fallback 置 true（overlay/main.js:641-655）→ 长时间不会 hide。

### 4.3 attachToDsh 的 re-show 分支（overlay/main.js:535-543）

- 进入条件：上一步 shouldHide=false（hostVisible && frontOk && s.matched，overlay/main.js:526），即四条件基本齐全。
- 再判断 pinned 或 withinIdle（overlay/main.js:538-539）才 showInactive。
- 问题：**显示序列不完整**。ready-to-show 被门控隐藏时执行过 setOpacity(0)（overlay/main.js:1612）；re-show 分支只 showInactive，没有 setOpacity/fade（overlay/main.js:540）。典型触发：宿主不在前台时调用 /visible true（pinned=true，showOverlay 被前台门控拦下），ready-to-show 因前台不满足执行 opacity=0 + hide，随后用户切回 DSH → attach 的 re-show 分支 showInactive，但 opacity 仍是 0 → 窗口「显示」但透明，/health 却报 visible=true；若之后没有新的 /log 触发 showOverlay 的 fade，pinned 窗口永远看不见。
- 结论：不是「乱弹」，是「该出现时可能不出现」（R5，P2）。最小修复：re-show 前 setOpacity(0)、showInactive、applyClickThrough、fadeWindow(s,1)，或直接复用 showOverlay 的显示序列。

### 4.4 放大（overlay/main.js:1862-1902、HTTP overlay/main.js:1823、IPC overlay/main.js:1946-1949）

- toggleExpand 只改 bounds，不调用 showInactive，所以本身不是显示路径。
- 但隐藏态下 POST /expand 会把 smallBounds 换成放大尺寸并把 flags.expanded=true；之后任何一次合法显示（#2/#7）都会以放大尺寸出现。触发：隐藏会话先被 /expand（例如外部脚本没先 /visible），随后有活动 → 用户看到的是全屏级大窗而不是 300x190 小窗。归入 R6（P3），最小修复：隐藏且非 pinned、且 lastActivity 已过 idle 窗口时，/expand 不落盘 expanded（或先记录 pending，显示时再按需生效）。

### 4.5 setWindowId 自动找回（overlay/main.js:1402-1427、recover.js:17-46）

- recoverTarget 只在抓帧连续失败时触发（overlay/main.js:1264-1275），而抓帧在隐藏态默认暂停（overlay/main.js:1148），所以正常情况下这是「已显示窗口」的维护路径，不产生新的弹出。
- 例外：OVERLAY_CAPTURE_WHILE_HIDDEN=1（自检模式，overlay/main.js:77）时隐藏态也会抓帧 → 失败 → recoverTarget → setWindowId（overlay/main.js:1413）→ markActivity（overlay/main.js:1383）→ showOverlay。此时仍受前台+标题门控，但同样缺 hostVisible → 与 R1 叠加（R8，P3，仅自检开关下）。
- 窗口重开找回本身不调用任何显示 API，风险等级取决于 #2。

### 4.6 崩溃重载（overlay/main.js:1568-1586）

- render-process-gone 时记录（crash-log.js）并限次 win.reload()（overlay/main.js:1584）。
- ready-to-show 是 win.once（overlay/main.js:1598），首次已消费；reload 不改变窗口可见性，也不会重新触发这个 once 回调。
- 若崩溃发生在首次 ready-to-show 之前，once 回调仍会在重载完成后触发一次，走同一四条件门控。
- 结论：没有发现绕过门控的崩溃重载显示路径。唯一注意：崩溃循环停止重载后窗口保持原可见性（可能停在半渲染状态），属于稳定性问题不是显示路径问题。

### 4.7 其它已确认「不显示」的路径

- attachTick 兜底 hide（overlay/main.js:663-670）、hideGuard（overlay/main.js:587-599）、cursorWatch（overlay/main.js:721-762）、setTitleHint 立即隐藏（overlay/main.js:501-507）、hideOverlay idle 立即 hide（overlay/main.js:911-915）：全部只隐藏。
- 拖动 move（overlay/main.js:1629-1642）：只 clamp 位置。
- 第二个实例（overlay/main.js:2052-2059）、window-all-closed（overlay/main.js:2094-2096）、dock.hide（overlay/main.js:2021-2025）：均无显示动作。
- supervisor 只拉起后台 daemon（overlay/supervisor.js:68-101），不创建窗口。
- renderer/preload 暴露的 IPC（preload.js:18-31）里没有「显示窗口」的能力；overlay:toggle-expand 不显示，overlay:fix 只重试抓帧或打开系统设置（另一个 App，不是小窗）。

## 5. 残余风险清单（触发条件 + 最小修复建议，不要照抄改代码）

| 编号 | 级别 | 风险 | 触发条件 | 关键位置 | 最小修复建议 |
| --- | --- | --- | --- | --- | --- |
| R1 | P1 | showOverlay 主漏斗缺 hostVisible 与快照新鲜度，活动可在宿主最小化/隐藏时把窗口露出来 | Cmd+M 最小化/隐藏宿主后 5s 内推 /log、/status、/frame、/window 或 /visible true；或 attachTick 正忙/变慢时 | overlay/main.js:868-897（showOverlay）、876-880（只有前台检查）、overlay/main.js:438（hostVisible 初值） | showOverlay 里加：if (ATTACH_TO_DSH && (!hostVisible || !hostCheckedAt || Date.now()-hostCheckedAt > 2*ATTACH_SLOW_MS)) { state.visible=false; return; }；并把 hostVisible 初值改为 !ATTACH_TO_DSH |
| R2 | P1 | 冷启动/读不到前台时四条件 fail-open | 启动后首个 attachTick 完成前（osascript 正常几十至几百 ms，上限 2s）有活动；或 osascript/JXA 读取失败（TCC/权限） | overlay/main.js:438-440、611；overlay/session-gate.js:47-61（front 空放行 59、hostVisible 默认 true 49）；overlay/main.js:525、863 | ① boot 时先 await 一次 readHostSnapshot 再创建 default 会话（或 ready 前至少等一次快照，超时则维持隐藏）；② shouldShowOnReady 增加 frontKnown/snapshotAt 入参，ATTACH_TO_DSH 且未拿到快照时返回 false；③ 同步更新 test/overlay-session-gate.test.mjs 的「front 空 → 显示」用例 |
| R3 | P2 | 新会话首个活动若是 /frame、/window 或 /visible，标题门控尚未绑定就放行 | DSH 在前台但当前是另一个会话（标题不同）时，对未绑定的会话调用 /frame /window /visible | overlay/main.js:1809-1823（三个入口都没有 setTitleHint/maybeAutoBindTitle；对比 /log 1797-1802、/status 1803-1808）；README 记载无 titleHint 为旧行为（overlay/README.md:66） | 在 onFrame/onWindow/onVisible 里也调用 maybeAutoBindTitle(s)（宿主标题可用时）；或让 showOverlay 在 titleHint 为空且 dshTitle 非空时先用当前标题做一次临时匹配 |
| R4 | P2 | /status clear:true 被当成活动，任务收尾时窗口闪一下 | 所有任务收尾序列：先 clear 再 /visible false（core/tasks/app-matrix.mjs:132-133、core/tasks/drive-agent.mjs:144-145）；若调用方只 clear 不发 /visible false，会停留 idleHideMs（默认 5000，overlay/main.js:108） | overlay/server.js:274-291 把 clear 转成 text 为空串；overlay/main.js:972-982 的 setStatus 最后仍 markActivity(s,'status') | server 把 clear 标记传给 main，或 main 在 setStatus 检测 text 为空（clear 专属路径）时跳过 markActivity，必要时直接 hideOverlay |
| R5 | P2 | attach re-show 缺 opacity/fade，pinned 或 recently-active 窗口可能「显示但透明」 | /visible true 时宿主不在前台 → ready-to-show 走 opacity=0 + hide；随后切回宿主触发 re-show | overlay/main.js:540（只 showInactive）、overlay/main.js:1612（隐藏时 opacity=0）、overlay/main.js:535-543 | re-show 分支补 win.setOpacity(0) → showInactive → applyClickThrough → fadeWindow(s,1)（或复用 showOverlay 的显示序列） |
| R6 | P3 | 隐藏态先 /expand，之后被合法显示时直接是大窗 | 隐藏会话收到 POST /expand，随后有活动/手动显示 | overlay/main.js:1862-1902、1890 | 隐藏且非 pinned、且活动已过 idle 窗口时不允许 expanded 落盘（或记录 pendingExpand，显示后再生效） |
| R7 | P3 | 打包版 self bundle 写死 com.github.Electron，点击小窗按钮可能触发「全部隐藏」 | 打包 App（appId com.goodlifedog.dsh-desktop-agent，overlay/electron-builder.yml:1）中用户点击小窗交互区，overlay 自身成为前台 → frontOk=false → attach 全部 hide | overlay/main.js:524、864、1607（self 常量） | 运行时取自身 bundle id（打包用 app.getAppPath/Info.plist，开发回退 com.github.Electron），或在 window focus 时把 frontmost 视为自身 |
| R8 | P3 | OVERLAY_CAPTURE_WHILE_HIDDEN=1 时 recoverTarget 可从隐藏态触发显示 | 自检环境变量开启 + 目标窗口失效 | overlay/main.js:77、1148、1402-1427、1383 | 自检模式下的 recover 不调用 markActivity，或 showOverlay 里区分 self-check 模式 |
| R9 | P3 | 多显示器下小窗固定在主屏 | 宿主在副屏且前台，主屏上冒出小窗 | overlay/main.js:1519-1527 | 建窗位置按宿主窗口所在显示器计算，或显示前确认宿主所在屏 |
| R10 | P2（配置） | OVERLAY_ATTACH_DSH=0 或 OVERLAY_HOST_BUNDLES 配错时门控大面积失效 | 用户显式修改环境变量 | overlay/main.js:42-47、862、525 | 文档标注为「关闭宿主门控」的独立模式；或在非默认配置启动时日志/health 明确提示「门控已关闭」 |

## 6. 单测与覆盖情况

- 已跑且通过：
  - 门控相关 7 条：test/overlay-session-gate.test.mjs:1-40（宿主前台+活动显示、切到别的应用不显示、hostVisible=false 不显示、标题不匹配不显示、无活动不显示、front 空放行、标题精确匹配）
  - 其它纯函数：test/overlay-recover.test.mjs、test/host-select.test.mjs、test/session-policy.test.mjs、test/overlay-crash-log.test.mjs、test/overlay-server.test.mjs、test/session-gate.test.mjs（合计 53 条）
  - CSP/打包：test/overlay-csp.test.mjs、test/overlay-packaging.test.mjs（5 条）
- 覆盖缺口（建议后续补，仍然不需要启动窗口）：
  - showOverlay 在 hostVisible=false 时不得 show（现在没有这个测试，也没有这段代码）。
  - 冷启动未拿到宿主快照时 ready-to-show/showOverlay 不得显示（frontKnown 用例）。
  - /status clear:true 不得触发显示。
  - attach re-show 之后窗口 opacity 必须为 1。
  - /frame、/window、/visible 首调时的标题绑定行为。
- 已有文档/记录的偏差：overlay/README.md:334 写「ready-to-show 后用 showInactive() 显示」，是修复前描述，已过时（实际 1603-1616 有条件判断），建议顺手更新文案。

## 7. 最终回答：还有没有会在别的应用/桌面闪出来的路径？

**有，但不是原来那个无条件路径了。** 默认配置下，下面这些已确认不会再弹：

- 新建任意会话窗口，只要没有活动 → ready-to-show 隐藏（overlay/main.js:1603-1616）；
- 冷启动 default 会话 → hasActivity=false → 隐藏；
- 用户切到别的应用（前台读取正常时）→ showOverlay/attach 都拦；
- 切到别的 DSH 会话且会话已绑定 titleHint → 标题门控隐藏。

仍可能短暂出现的路径（按概率/影响排序）：

1. 宿主最小化/隐藏后 5 秒内来活动（R1，hostVisible 未参与 showOverlay）——最现实，建议优先修。
2. 冷启动最初约 0–2 秒内来活动，且宿主不在前台（R2，初值/fail-open）——重启 overlay 后立刻跑任务时可能遇到。
3. 宿主前台或 CGWindowList 读取失败（R2 变体）——一旦 osascript/JXA 失败，门控会长期 fail-open。
4. 新会话首个活动是 /frame、/window 或 /visible，且没带 titleHint（R3）——DSH 前台但切到了另一个会话时可能冒头。
5. 任务收尾 /status clear:true 被算作活动（R4）——通常下一毫秒就被 /visible false 收走，但会闪一帧；若调用方只 clear 就会停留默认 5 秒。

因此，**当前版本的准确表述是：正常使用时不会乱弹；但「宿主最小化/隐藏 + 有活动」「冷启动前 2 秒」「系统读取失败」「首活动未绑定标题」「clear 收尾」这五种条件下仍可能闪出**。修完 R1 + R2 可以消除 P1，再补 R3 + R4 后，才适合对外承诺「绝不会在别的应用/桌面闪出来」。

## 8. 附录：显示相关调用全量 grep 结果

- win.showInactive()：overlay/main.js:540、888、1619（仅此三处）
- win.hide()：overlay/main.js:505、530、669、914、920、1613（全部为隐藏）
- win.setOpacity()：overlay/main.js:790、805、886、913、1612、1618（淡入淡出与隐藏前置零）
- win.reload()：overlay/main.js:1584（崩溃恢复，不显示）
- new BrowserWindow：overlay/main.js:1532（唯一建窗点，show:false，overlay/main.js:1539）
- win.show() / focus() / moveTop() / restore() / minimize() / maximize() / setVisibleOnAllWorkspaces()：0 处调用（setVisibleOnAllWorkspaces 只出现在注释 overlay/main.js:1591）

---

审查人：overlay-dev
审查时间：2026-11-08
说明：本次只读审查与写本文档，未修改 overlay 业务代码；未运行 overlay 或任何 GUI 程序。

## 9. 修复记录（task-27，2026-11-08）

状态：R1–R6 已按第 5 节的最小修复建议落盘；目标单测 26 条 + 既有 session-gate 回归 7 条全过。
**尚未重启 overlay 做真机验证**（按约束由 Lead 统一重启验证）。R7–R10 未修，仍在。

### 9.1 改动清单

| 编号 | 修复内容 | 新位置 | 行为 |
| --- | --- | --- | --- |
| R1 | showOverlay（活动驱动主漏斗）改走 shouldShowNow：宿主可见 + 快照新鲜 + 前台可信 + 标题已知且匹配，任一未知都不显示 | overlay/main.js:899-926（门控在 main.js:909-918）；纯函数 overlay/session-gate.js:98-123 | 不满足时保持隐藏、标记 suppress、并 requestAttachRefresh 立刻补一次宿主轮询，等真实快照再决定 |
| R2 | 初值 fail-closed：hostVisible 初值 false、hostBoundsStale 初值 true；前台未知用 isFrontTrusted 返回 false；标题未知（dshTitle 空）视为不可显示；attach 循环隐藏判断同步收紧 | overlay/main.js:452-453（初值）、main.js:529-550（attach 门控，含 titleKnown）、main.js:909-918、main.js:1660-1673；纯函数 overlay/session-gate.js:46-89、133-140 | 冷启动第一次 attachTick 拿到真实快照前不显示；读失败期间不会 fail-open 冒窗；独立模式 OVERLAY_ATTACH_DSH=0 保留「活动即显示」（main.js:909、main.js:1658-1659） |
| R3 | attach re-show 补完整显示序列：setOpacity(0) → showInactive → applyClickThrough → fadeWindow(1) | overlay/main.js:559-569 | ready-to-show 被门控隐藏（曾把 opacity 置 0）后，pinned/近期活动窗口条件恢复时能真正出现，不再「显示但透明」 |
| R4 | setStatus 识别 clear（server 把 clear:true 转为空 text），clear 不调用 markActivity：不刷新 lastActivityAt、不触发显示；状态本身仍复位为「待命」 | overlay/main.js:1022-1036；纯函数 overlay/session-gate.js:146-150 | 任务收尾 clear:true 不再闪一帧；若调用方只 clear 不发 /visible false，也不会因 clear 而显示 |
| R5 | /window、/frame、/visible 三个首活动入口在 ensureSession 之后调用 maybeAutoBindTitle；showOverlay 与 ready-to-show 在判定前也补一次自动绑定 | overlay/main.js:1872-1898（三个 handler）、main.js:905（showOverlay）、main.js:1656（ready-to-show）；绑定逻辑 overlay/main.js:485-493 | dshTitle 可用时首活动即绑定会话标题，不再依赖第一个 /log 或 /status；避免首活动绕过标题门控 |
| R6 | 隐藏态 /expand 忽略（返回 ignored:true），不落盘 expanded；折叠始终允许 | overlay/main.js:1941-1948；纯函数 overlay/session-gate.js:159-165 | 隐藏会话先 /expand 不会让下次显示直接变成大窗；已展开窗口仍可折叠 |
| 辅助 | 门控因宿主快照未就绪/过期而拦下显示时，立刻补一次 attachTick（避免等全隐藏时 1.5s 慢轮询）；SELF_BUNDLE / HOST_SNAPSHOT_MAX_AGE_MS 抽成常量 | overlay/main.js:58-60、705-715 | 门控恢复后更快出现；self bundle 与快照年龄集中管理（R7 仍未解决，见 9.5） |

### 9.2 修复后的显示判定（活动驱动与 ready-to-show 共用）

窗口允许显示必须同时满足：

1. hostVisible === true（宿主窗口在屏幕上，不是最小化/隐藏/别的 Space）；
2. hostBoundsStale === false；
3. hostCheckedAt > 0 且 now - hostCheckedAt <= 5000ms；
4. front 非空，且 front ∈ HOST_BUNDLES 或 front === SELF_BUNDLE（未知前台 fail-closed）；
5. dshTitle 非空（标题未知时 fail-closed）；
6. titleHint 为空或与 dshTitle 匹配；
7. ready-to-show 额外要求有活动（lastActivityAt 或 pinned）；活动驱动路径本身即活动；
8. 独立模式 OVERLAY_ATTACH_DSH=0 例外：只保留「有活动」这一条。

不满足时：保持/置为隐藏、标记 suppressBySession，并由 requestAttachRefresh + attach 循环在条件恢复后按「pinned 或活动仍在 idle 窗口内」决定补显示。

### 9.3 单测

- 目标文件：test/overlay-session-gate.test.mjs，26 条，覆盖：宿主可见/不可见、hostStale、快照超过 5s、正好 5s 边界、hostCheckedAt=0、前台为空/null/非宿主、self bundle、标题未知/不匹配、hasActivity、clear 不算活动、隐藏态 expand 忽略、折叠允许、时钟倒退、标题匹配回归。
- 回归：test/session-gate.test.mjs 7 条（标题归一/匹配/近似会话不互相点亮）。
- 结果：33 pass / 0 fail；node --check overlay/main.js、overlay/session-gate.js 通过。
- 未跑（按约束）：overlay 启动、verify:live、acceptance、monitor、ui-regression、session-scope-check、fps-check；未截图、未启动/退出任何应用、未 commit。

### 9.4 Lead 重启后的验证点（建议顺序）

1. 冷启动无活动：窗口不应出现（CGWindowList/onscreen 为空），/health hostVisible 在第一次轮询后应为 true、hostBoundsStale=false。
2. 正常任务链路：/status（带 titleHint）→ /window → /visible true，窗口应正常显示，不能被 fail-closed 永久挡住；若显示有约一次轮询的延迟，属于预期。
3. 宿主最小化/隐藏（Cmd+M）后推 /log：不应出现；恢复宿主后，pinned 或近期活动窗口应重新出现（R1/R2）。
4. 切到别的 DSH 会话：带 titleHint 的会话应隐藏；切回后按 pinned/活动恢复。
5. 任务收尾 /status clear:true：不应再闪（R4）；随后 /visible false 应正常隐藏。
6. 隐藏态 POST /expand：应返回 ignored:true、expanded 仍为 false；窗口显示后 /expand 应正常放大（R6）。
7. pinned 流程：宿主不在前台时 /visible true → 保持隐藏；切回匹配会话后应出现且 opacity 为 1（R3，不再透明）。
8. 独立模式（可选）：OVERLAY_ATTACH_DSH=0 启动，有活动仍能显示（不受宿主门控）。
9. 老回归：切换 Space 不跟随、多会话标题隔离、/visible false、会话 TTL、崩溃重载日志。

### 9.5 未修 / 剩余风险

- R7：self bundle 仍写死为 com.github.Electron（现已集中为 SELF_BUNDLE 常量 overlay/main.js:58）；打包版 appId 为 com.goodlifedog.dsh-desktop-agent，点击小窗交互区触发自身前台时仍可能被判定 frontOk=false 而隐藏（是「该显示时消失」，不是乱弹）。
- R8：OVERLAY_CAPTURE_WHILE_HIDDEN=1 时 recoverTarget 仍可从隐藏态触发 setWindowId → markActivity（有前台/标题/宿主门控兜底，但自检模式下仍可能显示）。
- R9：多显示器仍固定建在主屏。
- R10：OVERLAY_ATTACH_DSH=0 或 OVERLAY_HOST_BUNDLES 配错会整体关闭/放宽门控，属于显式配置模式。
- 结论：本轮修复覆盖了「宿主最小化/隐藏 + 有活动」「冷启动前 2 秒」「前台/标题未知」「clear 收尾」「首活动未绑标题」「隐藏态 expand」6 类路径；剩余风险集中在打包 self bundle、自检开关、多显示器与显式关闭门控的配置模式。
