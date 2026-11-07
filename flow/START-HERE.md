# 先读这个（外部评审给主人的一页纸）

> 给「布局规划」会话写的一堆文档做了个入口。**如果只看一页，就看这页。**

## 现在的状态

- 代码：`npm run verify` 全绿，单测 500+，`repo:check` 20 项全过
- 发布链路：干净副本里完整彩排过（补丁 → 测试 → 体检 → 打包 → 安装 → publish dry-run），六步全通
- 真实验收：跑过一次完整验收，13 项里 11 项通过/跳过，2 项失败都是测试设计问题（已修一处、一处已给方案）
- 待应用补丁：**只剩 1 个**（`patch-publish.diff`），其余 20+ 个都已采纳并删除

## 你要做的四件事（都只要一次决定）

| # | 决定 | 选项 |
| --- | --- | --- |
| 1 | **BOSS 内容去留** | A. 摘出去（按 `BOSS-EXTRACT.md` 做，2-4 小时）　B. 保留但不上首页 + 加免责声明（1 小时） |
| 2 | **npm 包名** | scoped 包，如 `@<你的npm名>/desktop-agent`（`desktop-agent` 已被占用） |
| 3 | **GitHub 仓库地址** | 替换补丁里的 `github.com/tester/desktop-agent` |
| 4 | **git 提交身份** | `git config user.email "<id>+<用户名>@users.noreply.github.com"` |

做完这四件，应用 `patch-publish.diff`，再跑一遍 `npm run verify`，就能发。

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

**工程层面已经可以发了，剩下的全是决策。** 不需要再写功能、不需要再修 bug——
照上面四件事做完，这个项目就能见人。
