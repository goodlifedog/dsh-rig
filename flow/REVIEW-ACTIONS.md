# 评审待办（外部检查者维护）

> 每次复查后更新，**只看这一页就够**。详细理由见 `REVIEW-2026-11-07.md`。
> 更新：2026-11-08 05:05

## 本轮我直接改的（请审 diff 再提交）

- `core/run-classify.mjs`：**有 ❌ 的轮次不再被「环境跳过」整轮豁免**（这就是上轮那个 10/10 假绿的根因）
  - 改完实测：`background-control` 那份日志从 `envSkip=true` 变成 `真实失败`
  - 新增 2 项单测；全量 355 项全绿
  - ⚠️ 副作用：`npm run accept` 现在会把 `background-control` 判红（这是对的），
    要么修那一项（`后台点击计算器按钮`），要么在任务里明确标成 SKIP 并写清原因

- `core/agentd.mjs`：应用锁加「持锁 pid 存活性判断」+「持锁期间 mtime 心跳续期」
  - 修复前：持锁超过 staleMs(180s) 的任务会被后来者抢锁，两个任务同时控制同一个应用
  - 修复后实测：死进程的旧锁 1ms 接管；活进程的旧锁不抢（等超时）
  - 配 `test/app-lock.test.mjs` 两项回归；全量 346 项全绿
- `core/platform-smoke.mjs`：补 `localHeaders()`，`npm run doctor` 不再误报小窗红叉（实测 ✅）
- `core/dialog-guard.mjs` + `test/dialog-guard.test.mjs`：软件自身弹窗守卫（权限类只提醒不代点）

## 现在就做


1. **发布配置不合格**：包名 `desktop-agent` 已被 npm 占用（发布必然 403）；缺 `bin`/`files`/`repository`；CI 矩阵跑三平台但项目只支持 macOS；README 徽章还是 `USER` 占位。补丁已备：`git apply flow/patch-publish.diff`。

## 下一批

2. **`flow/BACKGROUND-CONTROL.md` 第 140 行对 `-j` 的描述太绝对**：原文「窗口仍建出来、AX 树照样可读写、画面能抓」。实测：计算器隐藏后 AX 25 个按钮照常在（对），但文本编辑隐藏时 ocu 看不到「标准窗口」节点（要显示后才有），画面也确实抓不到（只有纯色帧）。建议改成「多数应用 AX 可读，部分应用窗口节点需显示后才出现；画面抓不到，需要画面时设 AGENT_LAUNCH_HIDDEN=0」。


2. **找到「窗口来回切」的来源：Telegram 一读 AX 就跳前台**（app-matrix 实测：11 个应用里只有它，读树/读元素两步前台变成 Telegram，看门狗还回去所以用户看到「闪一下」）。建议建「AX 访问即激活」的已知应用名单，并在矩阵报告里输出打扰度。
4. **README 那句「全程不抢焦点」**：个别 Electron 应用启动瞬间会自己跳到前台（app-matrix 报告里有实据）。建议改成「不主动抢，抢了会立刻还回去」。

## 已修好（不用再看）

- 控制面 token（daemon + overlay 都 401）、Origin/跨域防护（403）
- pid 复核把 Helper 当主应用
- 验收覆盖新通道（10 项）、部署漂移守卫、进程收尾（组杀 + SIGKILL + runner 转发 TERM）
- 失败归类放水（ENOENT / 未送达）
- 启动应用把窗口丢到用户桌面（改 `open -g -j` 隐藏启动）
- `npm run doctor` 误报小窗红叉
- `docs/USAGE.md` 的 curl 示例已全部带票（0 处无票）
- `status.mjs` 的「最近验收」排序（已改成只认 acceptance-* 并按时间戳取最新）
- 日志无轮转（`scripts/prune.mjs` + `npm run prune`，默认 dry-run，配 2 项单测）
- 卸载不清 token / 不管游离进程（已修，我复看过实现）
- `-j` 隐藏启动带来「窗口抓不到画面但 AX 可读」，需要在文档里说明这是预期
- 应用锁会被偷
- 小窗圆角随尺寸自适应、软件自身弹窗守卫