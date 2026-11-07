# 评审待办（外部检查者维护）

> 每次复查后更新。**只看这一页就够**，详细理由见 `REVIEW-2026-11-07.md`。
> 更新：2026-11-08 03:20

## 现在就做（会让人得出错误结论 / 会被用户直接看到）

1. **应用锁会被后来的任务偷走**：锁只按 mtime 判过期，没有心跳、不发 pid 存活性检查；长任务（>3 分钟）会被第二个任务抢锁，两个任务同时控制同一个应用。复现和改法在评审文件第 25 轮。
3. **`docs/USAGE.md` 四个 curl 示例会 401**：第 243/273/283/296 行，给用户复制粘贴的，现在全部被 token 挡住。
4. **发布配置不合格**：包名 `desktop-agent` 已被 npm 占用（必然 403）；缺 `bin`/`files`/`repository`；CI 矩阵跑三平台但只支持 macOS；README 徽章还是 `USER` 占位。补丁已备：`git apply flow/patch-publish.diff`。

## 下一批（不影响现在用，但迟早出事）

5. **`status.mjs` 的「最近验收」按文件名排序**：显示的是 11 月 6 日的报告，掩盖当天那次失败。改成按文件名里的 ISO 时间戳，且只认 `acceptance-*`。
6. **app-matrix 抢前台被记成「环境跳过」**：它自己报告写「前台被 Calculator 抢占」，验收却记 PASS。要么修抢前台，要么把原因区分开（锁屏/被抢/自身起不来）。
7. **日志与报告无轮转**：logs 188 个文件 3.3M、reports 152 个，跑久了会堆几千个。加个 `npm run prune`（日志 7 天、报告 200 个），daemon 启动时跑一次。
8. **卸载不清 token、不管游离进程**：`service:uninstall` 只删 plist；占着端口的游离 daemon 和 `~/.desktop-agent/api-token` 会留下。

## 已经修好的（不用再看）

- 控制面 token（daemon + overlay 都 401）
- Origin/跨域防护（403）
- pid 复核把 Helper 当主应用
- 验收覆盖新通道（10 项）
- 部署漂移守卫（service:status / service:restart）
- 进程收尾（detached + 组杀 + SIGKILL + runner 转发 TERM）
- 失败归类放水（ENOENT / 未送达）
- 启动应用把窗口丢到用户桌面（改成 `open -g -j` 隐藏启动）
- 软件自身弹窗（新增 `core/dialog-guard.mjs`，权限类只提醒不代点）
- 小窗圆角随尺寸自适应
- `npm run doctor` 误报小窗红叉（platform-smoke 补了 localHeaders，实测已恢复 ✅）