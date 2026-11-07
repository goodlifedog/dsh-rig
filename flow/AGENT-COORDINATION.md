# 多会话 / 多 agent 协作约定

> 这个仓库会被多个会话、外部评审 agent 同时使用。为了不互相踩、不打扰用户，定几条硬规矩。

## 1. 验收同一时刻只能跑一个

`npm run accept` 会启动应用、切前台、操作窗口。两个验收同时跑 = 界面反复跳、应用互相抢。

- 验收启动时会写 `reports/.acceptance.lock`（内含 pid），第二个会直接退出并提示"另一个验收正在进行"。
- 不要删这个锁文件；进程异常退出留下的旧锁，下次启动会自动判定失效并接管。

## 2. 用户在用电脑时不要跑验收

验收入口会检查系统空闲时间（HIDIdleTime）：

- 空闲 < 180 秒 → 直接拒绝运行，并提示"检测到你正在使用电脑"。
- 确实需要（例如你在旁边看着它跑）：`ACCEPT_FORCE=1 npm run accept`。

这条是硬性体验保护：用户抱怨过"屏幕被反复切"。

## 3. 跑完必须清理，不要留测试数据

- `npm run accept` 结束会自动调用 `npm run cleanup:test`；注意清理脚本**默认只报告不删**，
  笔记要真删需要 `npm run cleanup:test -- --force`，而且只删标题带 `[AGENT-TEST]` 标记的笔记；
  历史测试词和「标题读不到时按条数删」都要 `--force-all` 才放开——误删用户笔记不可恢复，所以默认不动手。
- 手动跑任何会写用户数据的新任务后，也执行一次 `npm run cleanup:test`。
- **不要和别的会话同时跑验收类任务**：acceptance / bg:verify / 矩阵 / 后台控制会互相抢前台、互相关应用，
  两边的报告都会变成假失败（实测踩过）。现在 bg:verify 和 acceptance 启动前会扫进程表，
  发现别的同类任务在跑就直接拒绝（bg-verify 退出码 3），等它跑完再试。
  单个任务（app-matrix / background-control / background-stability）启动时也会检查验收锁：
  锁被「别的」验收持有时打印「环境跳过」直接返回，不会被误算成失败。
- 清理范围：备忘录里标题匹配「后台控制验证 / 后台写入 / 后台测试」的笔记、文本编辑里未命名且空/含标记的文稿、计算器等测试应用。
- 用户自己的内容（聊天记录、Chrome 标签页、真实文档）**一律不删**，清理脚本只报告。

## 4. 服务用 launchd 管理，别手工起

- 状态：`npm run service:status`（会查端口监听者与 launchd 受管 pid 是否一致）
- 重启：`npm run service:restart`（只杀确认属于本项目的进程，再 kickstart）
- 手工 `nohup node core/daemon.mjs` 会占着端口，导致 launchd 拉不起来、代码改了不生效。

## 5. 外部评审 agent

- 评审可以跑只读检查（`flow/review-watch.mjs`、`npm test`、`npm run repo:check`），这些不切窗口。
- 不要并发跑 `npm run accept`；不要用 `pkill` 批量清理应用进程。
- 发现问题写进 `flow/REVIEW-ACTIONS.md`，由主会话实现；改动请走正常提交，别直接改用户数据。
