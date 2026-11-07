# 评审待办（外部检查者维护）

> 只列**还没做**的。已修好的沉到底部，不复述。
> 详细理由见 [`REVIEW-2026-11-07.md`](REVIEW-2026-11-07.md)，发布流程见 [`PUBLISH-CHECKLIST.md`](PUBLISH-CHECKLIST.md)。
> 更新：2026-11-08 15:00（`flow/patch-p1.diff` = **232 行 / 7 个文件**，新增 `core/runner.mjs`：日志写入从 `void fd.write()` 改为同步写，避免退出时末行丢失。**`docs/REVIEW.md` 那份 18 条旧审查，现在全部要么已验证修复、要么已进补丁。**）
  ① `node core/cli.mjs foo` → 退出码 2，用法输出到 stderr
  ② 死进程旧锁 → 抢锁成功且内容改写成本进程；活进程旧锁 → 拒绝抢
  ③ `cli stop` 在 launchd 托管下 → 打印暂停/卸载/重启指引，**daemon 未被杀**（7789 仍 200）
  ④ `start-all` 在 daemon+overlay 都在跑时 → 打印「小窗已在运行，跳过」，不产生第二个窗口
  ⑤ daemon 未捕获异常处理：仅静态确认（难以在测试里稳定注入）

## P0 · 公开前必须处理（3 条）

### 1. BOSS 直聘内容不该出现在公开仓库

- 现状：4 个 `boss-*` 任务、1 个 `greet-inner`、3 份 BOSS 文档（582 行）、README 首页有案例、**npm 包里也带着**
- 执行方案已写好：[`BOSS-EXTRACT.md`](BOSS-EXTRACT.md)（要删哪些、验收怎么补、怎么复查包）
- 需要你决定：**摘出去** / 保留但不上首页、加免责声明、删风控章节

### 2. 发布配置（补丁已备，`git apply flow/patch-publish.diff`）

- 一次解决：包名 scoped、`bin`、`files` 白名单（1.1MB / 143 文件）、`repository`、`publishConfig`（绕开淘宝镜像）、CI 矩阵、README 徽章
- 应用后替换两处占位：`@goodlifedog/desktop-agent`、`github.com/tester/desktop-agent`
- 验证：`npm publish --dry-run` 必须显示 `Publishing to https://registry.npmjs.org ... public access`

### 3. 笔记删除缺最后一层标记

- 现状：`core/note-cleanup.mjs` 删除行时不看标题（靠「只删顶部 N 条 + `--force`」挡着）
- 建议：删除前读 `name of rr`，只删 `[AGENT-TEST]` 前缀；写入时统一加该前缀

## P1 · 影响正确性 / 用户信任（5 条）

### 4. overlay 会话回收缺「最近活动」保护（**补丁已备：`flow/patch-p1.diff`**）

- 现状：到上限 12 时回收「不可见 + 最久没活动」的会话；但 **DSH 不在前台时所有会话都不可见**
- 正在被任务使用的会话可能被误回收。建议：`Date.now() - at < 60_000` 的不回收

### 5. 资源清理外包给调用方（**复查后降级**，见下）

- 原判断：9 个任务里 `closeOcuMcp()` 在 finally 出现 0 次，担心泄漏
- **实测推翻了**：父进程正常 exit 或被 SIGTERM 杀掉时，MCP 子进程都自己退出了（stdio 关闭触发），打了 exit 钩子和没打补丁的对照结果一样干净
- 结论：这条**不用改**。真正需要 finally 的是「进程不退出但资源要释放」的场景，这里不适用

### 6. `npm stop` 谎报「已停止」（**补丁已备**：托管时给指引、非托管时杀完复查）

- launchd 托管时 `logs/daemon.pid` 不存在 → kill 静默跳过 → 仍打印「已停止」；且 `KeepAlive` 会立刻拉回
- 建议：先判断是否 launchd 托管，托管时明确提示用 `service:uninstall`/`launchctl bootout`

### 7. `npm start` 会开出两个小窗（**补丁已备**：探 7788 有响应就跳过，401 也算活着）

- `start-all.mjs` 对 daemon 有复用判断，对小窗没有；已装服务时再跑 `npm start` → 第二个 Electron 绑 7788 失败但窗口照样显示
- 注意：探 7788 必须带 `localHeaders()`，否则 401 会误判成「没在跑」

### 8. 常驻进程没有兜底异常处理（**补丁已备：`flow/patch-p1.diff`**）

- `daemon.mjs` / `runner.mjs` 无 `uncaughtException`/`unhandledRejection`；`overlay/main.js` 无 `render-process-gone`

### 8.5 `ocu` 缺失时任务会崩在未捕获异常上（**补丁已备**，实测）

- 老审查（`docs/REVIEW.md` 1.4）提过 `ocu-mcp.mjs` 的 spawn 没有 `error` 监听，至今未修
- 实测：`new OcuMcp({ bin: '/nonexistent/ocu' }).start()` → `UNCAUGHT: spawn ... ENOENT`，任务进程直接崩
- 补丁后：`start 抛错：ocu 可执行文件无法启动（...）：spawn ... ENOENT`，是一条能看懂的错误
- 影响：用户机器上 ocu 没装/路径不对时，看到的是崩溃栈而不是「请先装 ocu」
- 建议：记日志后继续服务；overlay 崩了重载并把事件写进 `/health`

## P2 · 打磨（按需，不阻塞发布）

### 8.6 overlay 折叠路径把「前台」写死成宿主 bundle（**补丁已备**）

- `overlay/main.js:1810`（从放大态还原成小窗时）调用 `attachToDsh(s, 'com.deepseek.dsh', ...)`，硬编码宿主 bundle
- 后果：`frontOk` 恒为 true，即使用户已经切到别的应用，折叠后小窗仍按「宿主在前台」处理 → 该隐藏时没隐藏
- 也绕过了 `OVERLAY_HOST_BUNDLES` 环境变量（换宿主时不生效）
- 补丁改为折叠时读真实前台：`readFrontmostBundle().then((frontNow) => attachToDsh(s, frontNow, dshBounds))`

### 9. 验收锁三个小洞（**补丁已备：`flow/patch-p1.diff`**）

- `existsSync` + `writeFileSync` 非原子（改 `{ flag: 'wx' }`）
- 无 SIGINT/SIGTERM 释放（Ctrl-C 留锁，pid 复用时会误判）
- `cleanupAfterAcceptance` 的 catch 是空的（清理失败无提示）

### 10. 文档数字会腐烂

- `README` 写「本机 27 个应用」，实测已 32 个
- 建议措辞改成「跑 `npm run apps:inventory` 看当前值」，并在 `repo:check` 里加一条数字比对

### 11. CLI 未知子命令退出码 0（**补丁已备：`flow/patch-p1.diff`**）

- `desktop-agent foo` 打印用法但 `exit=0`，脚本里 `|| die` 会误判；建议返回 2

### 12. `overlay/main.js` 1969 行 / 71 函数 / 5 类职责

- 建议拆 `thumb.js`（抓帧循环）与 `sessions.js`（会话生命周期），main 只做装配

### 12.5 文档里的「待补」标记

- `flow/CROSS-PLATFORM.md:94` 有 `Windows（待补）：`，公开仓库里看着像没写完；建议改成「Windows：未实现（计划中）」或直接删掉这段占位

### 12.6 旧审查遗留两条（不阻塞）

- `CAPABILITIES.md` 头部仍是「最后更新 2026-11-05」，内容基本仍成立，但日期该改
- `docs/REVIEW.md` 2.13「点击热区描述不完整」我无法判断是否已解决，需要作者确认
- 其余 16 条已在 `docs/REVIEW.md` 第 7 节标注状态（13 已修 / 3 进补丁）

### 13. 孤儿

- 4 个没人引用的任务（`boss-candidates` `human-demo` `parallel-demo` `parallel-real-demo`）
- 1 个没人引用的脚本（`scripts/ui-gallery.mjs`）

### 14. `repo:check` 在非 git 目录会报红

- 下载 ZIP 的用户跑会看到 `❌ git 仓库可用 / git ls-files 失败`；建议降级为「跳过（非 git 目录）」

### 15. 发布前隐私与历史

- `git config user.email` 未设置（作者是 `tester@goodlifedogdeMacBook-Pro.local`），设置成 GitHub noreply
- 历史里有 20 个 `goodlifedog@users.noreply.github.com` 自动检查点提交，公开前建议 squash

## 已修好（复核过，不用再看）

控制面 token（daemon + overlay 全接口）· Origin/跨域拦截 · pid Helper 误匹配 · 验收覆盖新通道（10 项）·
部署漂移守卫 · 进程收尾（组杀/SIGKILL/转发 TERM）· 失败归类放水（ENOENT/未送达/❌ 覆盖验收路径）·
应用锁偷锁 · doctor 误报 · USAGE curl 带票 · status 最近验收排序 · 日志轮转 · 卸载清理 ·
`open -g -j` 隐藏启动 · 弹窗守卫 · 验收互斥与空闲守卫 · 笔记盲删（已改成 force + 顶部 N 条）·
会话泄漏（任务主动 close + overlay 回收）· 小窗窗口失效自动恢复 · 还原失败信号 · 重绑并列保护 ·
锁屏死代码 · README 绝对化表述 · 命令速查表 · SECURITY 文档数字 · AGENT-COORDINATION 清理语义