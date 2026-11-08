# 先读这个（外部评审给主人的一页纸）

> 通宵收尾的结论在 [FINAL-REPORT.md](FINAL-REPORT.md)。

> 给「布局规划」会话写的一堆文档做了个入口。**如果只看一页，就看这页。**

## 现在的状态（2026-11-08 14:20 更新）

- 代码：`npm run check` / `npm run repo:check` / `npm run safety:audit` 全绿；单测 **636 项（635 过 / 1 跳过）**
- 真实验收：2026-11-08 实跑端到端验收 **10 通过 / 3 环境跳过 / 0 失败**；之后新增「并发验证」，验收现在 14 项
- 解锁验收：`npm run verify:live` 一条命令跑完（要求键鼠空闲 ≥15 分钟才开跑，运行中你一碰键鼠就立刻停并收起小窗）
- 不切屏：前台风险名单默认生效（`npm run front:risk` 可看/清），读取会被 AX 顶到前台的应用默认跳过；`guard()` 被抢会先还原再报错
- 安全检查：`npm run safety:audit` 拦四类致命写法（启动不收尾、强杀、open 不带 -g、界面任务缺护栏）
- 并发验证：`npm run demo:concurrent`（原生计算器 + headless 浏览器同时干活，前台采样 87 次全未变、屏幕上无新窗口）
- 已修的数据安全洞：文本编辑只在「未命名 + 测试格式正文」时才关、备忘录新建失败不写、终端已输入半截命令时不敲、保存确认是 AXSheet 也认、验收中止会收起所有小窗
- 发布待办：仍只差 `patch-publish.diff` + 四个决定（见下）

## 你要做的四件事（都只要一次决定）

| # | 决定 | 选项 |
| --- | --- | --- |
| 1 | **BOSS 内容去留** | A. 摘出去（按 `BOSS-EXTRACT.md` 做，2-4 小时）　B. 保留但不上首页 + 加免责声明（1 小时） |
| 2 | **npm 包名** | scoped 包，如 `@<你的npm名>/desktop-agent`（`desktop-agent` 已被占用） |
| 3 | **GitHub 仓库地址** | 替换补丁里的 `github.com/tester/desktop-agent` |
| 4 | **git 提交身份** | `git config user.email "<id>+<用户名>@users.noreply.github.com"` |

做完这四件，应用 `flow/patch-publish.diff`，再跑一遍 `npm run verify`，就能发。

## 发布前的最后一屏

```bash
git apply flow/patch-publish.diff
# 改两处占位：npm 用户名、GitHub 仓库地址
npm run verify
npm pack --dry-run      # 应为 145 文件 / 1.1 MB
npm publish --dry-run   # 必须显示 registry.npmjs.org + public access
```

## 文档地图

| 想干什么 | 看哪份 |
| --- | --- |
| 判断「现在到底能不能发」 | [`PUBLISH-VERDICT.md`](PUBLISH-VERDICT.md)（实测证据表 + 已知不完美） |
| 一步步执行发布 | [`PUBLISH-CHECKLIST.md`](PUBLISH-CHECKLIST.md)（含彩排结果） |
| 发版文案 | [`RELEASE-NOTES-DRAFT.md`](RELEASE-NOTES-DRAFT.md)（挑好的 10 来条） |
| 把 BOSS 内容摘出去 | [`BOSS-EXTRACT.md`](BOSS-EXTRACT.md)（要删哪些、验收怎么补） |
| 还剩什么问题没修 | [`REVIEW-ACTIONS.md`](REVIEW-ACTIONS.md)（只列没做的） |
| 外部评审哪些话我说错了 | [`REVIEW-RETRO.md`](REVIEW-RETRO.md)（自我校准用） |
| 补丁怎么打 | [`PATCHES.md`](PATCHES.md) |

## 一句话

**工程层面已经可以发了，剩下的全是决策。** 功能面和边界都已经补完（适配 23/32 个应用、无人值守验收、并发验证、安全自查）；
照上面四件事做完，这个项目就能见人。