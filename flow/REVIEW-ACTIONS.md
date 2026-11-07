# 评审待办（外部检查者维护）

> 每次复查后更新，**只看这一页就够**。详细理由见 `REVIEW-2026-11-07.md`。
> 更新：2026-11-08 03:45

## 本轮我直接改的（请审 diff 再提交）

- `core/agentd.mjs`：应用锁加「持锁 pid 存活性判断」+「持锁期间 mtime 心跳续期」
  - 修复前：持锁超过 staleMs(180s) 的任务会被后来者抢锁，两个任务同时控制同一个应用
  - 修复后实测：死进程的旧锁 1ms 接管；活进程的旧锁不抢（等超时）
  - 配 `test/app-lock.test.mjs` 两项回归；全量 346 项全绿
- `core/platform-smoke.mjs`：补 `localHeaders()`，`npm run doctor` 不再误报小窗红叉（实测 ✅）
- `core/dialog-guard.mjs` + `test/dialog-guard.test.mjs`：软件自身弹窗守卫（权限类只提醒不代点）

## 现在就做

1. **发布配置不合格**：包名 `desktop-agent` 已被 npm 占用（发布必然 403）；缺 `bin`/`files`/`repository`；CI 矩阵跑三平台但项目只支持 macOS；README 徽章还是 `USER` 占位。补丁已备：`git apply flow/patch-publish.diff`。

## 下一批

3. **`status.mjs` 的「最近验收」按文件名排序**：显示的是 11 月 6 日的报告，掩盖了当天那次失败。改成按文件名里的 ISO 时间戳排序，且只认 `acceptance-*`。
4. **app-matrix 抢前台被记成「环境跳过」**：它自己报告写「前台被 Calculator 抢占」，验收却记 PASS。要么修抢前台，要么把原因区分开（锁屏 / 被抢 / 自身起不来）。
5. **日志与报告无轮转**：logs 188 个文件 3.3M、reports 152 个，长期跑会堆几千个。加 `npm run prune`（日志留 7 天、报告留 200 个），daemon 启动时跑一次。
6. **卸载不清 token、不管游离进程**：`service:uninstall` 只删 plist，占端口的游离 daemon 和 `~/.desktop-agent/api-token` 会留下。
7. **README 那句「全程不抢焦点」**：个别 Electron 应用启动瞬间会自己跳到前台（app-matrix 报告里有实据）。建议改成「不主动抢，抢了会立刻还回去」。

## 已修好（不用再看）

- 控制面 token（daemon + overlay 都 401）、Origin/跨域防护（403）
- pid 复核把 Helper 当主应用
- 验收覆盖新通道（10 项）、部署漂移守卫、进程收尾（组杀 + SIGKILL + runner 转发 TERM）
- 失败归类放水（ENOENT / 未送达）
- 启动应用把窗口丢到用户桌面（改 `open -g -j` 隐藏启动）
- `npm run doctor` 误报小窗红叉
- `docs/USAGE.md` 的 curl 示例已全部带票（现在 0 处无票，15 处带票）
- 应用锁会被偷
- 小窗圆角随尺寸自适应、软件自身弹窗守卫