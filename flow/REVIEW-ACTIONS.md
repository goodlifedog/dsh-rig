# 评审待办（外部检查者维护）

> 每次复查后更新，**只看这一页就够**。详细理由见 `REVIEW-2026-11-07.md`。
> 更新：2026-11-08 08:20
>
> 注：复查时机器处于锁屏状态（ioreg `CGSSessionScreenIsLocked = true`），GUI 类任务一律没跑。

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

0. **✅【出口关卡已补上，但请审一处我可能过时的描述】**
   - 第 56 轮我在 `envSkipReason()` 里加了 `if (/❌/.test(raw)) return '';`，验收现在会把带 ❌ 的轮次判成真实失败
   - **更正**：我之前写「验收清理走 dry-run 安全阀」，现在代码里已经没有 `--dry-run` 了——你们改成了清理脚本内部默认不删（要 `--force` 才动手），这个更彻底，我的描述作废


1. **发布配置不合格（补丁 `flow/patch-publish.diff` 我刚复验过，仍可干净应用）**：包名 `desktop-agent` 已被 npm 占用（发布必然 403）；缺 `bin`/`files`/`repository`；CI 矩阵跑三平台但项目只支持 macOS；README 徽章还是 `USER` 占位。补丁已备：`git apply flow/patch-publish.diff`。

## 下一批

11. **`flow/AGENT-COORDINATION.md` 第 23 行的说法要补一句**：现在写「`npm run accept` 结束会自动调用 `npm run cleanup:test`」，但清理脚本默认**只报告不删**（要 `--force` / `NOTES_CLEANUP_FORCE=1` 才真删）。读者会以为测试数据已经被自动清干净了，实际不会。建议改成：「自动调用清理，但默认只报告；要真删需 `npm run cleanup:test:apply`（或加 `--force`），因为误删用户笔记不可恢复」。

10. **窗口失效后不会自动恢复**（10 次巡检里 2 次失败就是它）：`overlay/main.js` 抓帧连续失败到阈值后只把 `thumbnail.state` 切成 `error`，**不清空失效的 windowId、也不重新解析窗口**，于是会话一直停在 error 直到外部重新 `/window` 绑定。建议阈值时核对窗口：原 id 还在就保持；同进程有唯一新窗口就自动改绑；都没有就清空 windowId 回 `no-window`。同时 monitor 的「画面」检查要区分「未绑定（设计内）/ 自动恢复过 / 真失效」，否则指标虚高。

9. **发布前隐私/历史检查（我扫了 170 个提交）**：
   - 没发现任何密钥、token、私钥（`sk-` / `ghp_` / `AKIA` / PRIVATE KEY 全部零命中）——这项可以放心
   - 但历史里有 **20 个 `goodlifedog@users.noreply.github.com` 的自动检查点提交**，公开仓库里会显得杂乱。建议发布前 squash 成一个初始提交，或至少把这些 checkpoint 提交去掉
   - `git config user.email` 没设，提交作者是 `tester@goodlifedogdeMacBook-Pro.local`：公开后这个机器名会跟着出现在每条提交上，而且不会关联到你的 GitHub 主页。发布前改成本地配置：`git config user.email "<id>+<username>@users.noreply.github.com"`、`git config user.name "<你的名字>"`
   - 当前工作区是干净的（`/Users/tester` 只出现在 gitignore 的 `reports/` 里），历史里有 5 处（都是文档示例），影响很小

8. **命令发现性**：`package.json` 现在有 **52 个脚本**，README 只列了 26 个。文档本身覆盖得很好（49/52 有说明），但缺一张「一屏看完」的分类速查表。建议在 `docs/USAGE.md` 开头加三列：**日常用**（start/status/health/accept/doctor）、**排查用**（service:status、service:restart、prune、review-watch）、**内部工具**（其余）。另外补两个漏掉的别名：`npm run dialogs:guard`（文档里只写了 `node core/dialog-guard.mjs`）和 `npm start`（等于 `scripts/start-all.mjs`，一条命令起 daemon + 小窗，Ctrl+C 一起停）。

7. **`docs/SECURITY.md` 里的测试数字**：还写着 `npm test # 322 项`，实际 365 项。（第三节的重复段我复查时已经没了，这条已修）

5. **文档里的测试数字又飘了**：`docs/SECURITY.md:57` 写「npm test # 322 项」，实际已经 **365 项**。建议在 `repo:check` 里加一条：解析文档里 `N 项` 的说法，和 `npm test` 实际输出比对，不一致就报错（这个仓库已经有很全的体检，加这条成本很低）。
6. **孤儿脚本 `scripts/ui-gallery.mjs`**：全仓库没有任何地方引用它。要么接进文档/验收，要么挪到 `examples/`，要么删掉。

2. **验收锁三个小洞**（只读复查发现）：① 锁用 `existsSync` + `writeFileSync` 非原子，两个验收同时启动可能都进去，改成 `{ flag: 'wx' }`；② 没有 SIGINT/SIGTERM 释放，Ctrl-C 会留锁（pid 被复用时会误判「另一个验收正在进行」）；③ `cleanupAfterAcceptance` 的 catch 是空的，清理失败用户完全不知道。

2. **`flow/BACKGROUND-CONTROL.md` 第 140 行对 `-j` 的描述太绝对**：原文「窗口仍建出来、AX 树照样可读写、画面能抓」。实测：计算器隐藏后 AX 25 个按钮照常在（对），但文本编辑隐藏时 ocu 看不到「标准窗口」节点（要显示后才有），画面也确实抓不到（只有纯色帧）。建议改成「多数应用 AX 可读，部分应用窗口节点需显示后才出现；画面抓不到，需要画面时设 AGENT_LAUNCH_HIDDEN=0」。


2. **找到「窗口来回切」的来源：Telegram 一读 AX 就跳前台**（app-matrix 实测：11 个应用里只有它，读树/读元素两步前台变成 Telegram，看门狗还回去所以用户看到「闪一下」）。建议建「AX 访问即激活」的已知应用名单，并在矩阵报告里输出打扰度。
4. **README 那句「全程不抢焦点」**：个别 Electron 应用启动瞬间会自己跳到前台（app-matrix 报告里有实据）。建议改成「不主动抢，抢了会立刻还回去」。

## 发布前已自查通过

- **资源卫生（第 58 轮复查）**：`ocu app-agent` 残留 0 个（第 17 轮时是 4 个，其中一个是 26 小时前的）、离屏 Chrome 0 个、`/tmp/agentd-*.lock` 0 个、临时帧文件 0 个、验收锁 0 个 —— 进程收尾和清理这条线是真的修好了
- **产物有界**：`reports/` 正好 200 个（prune 的 KEEP_REPORTS 生效）、`logs/daemon` 204 个、日志报告总计 3.4MB


- **第三方许可合规**：`third_party/open-computer-use/` 里 LICENSE / NOTICE / THIRD_PARTY_NOTICES 都在仓库里，`scripts/bundle-ocu.mjs` 打包时会带上，`THIRD-PARTY.md` 也写明了再分发义务
- **密钥泄漏**：170 个提交全扫过，无 token / 私钥 / AKIA / ghp_
- **LICENSE**：MIT，版权人写的真名，没有占位符

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