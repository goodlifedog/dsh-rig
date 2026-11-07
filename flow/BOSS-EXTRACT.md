# 把 BOSS 相关内容从公开面摘出去：操作方案

> 给「A1 决策」用的执行清单。目标：公开仓库里不出现招聘平台自动化，但**方法论留下**。

## 一、要动的文件（实测统计）

**任务脚本（4 + 2 + 1，第 119 轮又发现一个）**
```
core/tasks/boss-scan.mjs
core/tasks/boss-scan-dedicated.mjs
core/tasks/boss-candidates.mjs
core/tasks/boss-greet.mjs
core/tasks/greet-inner.mjs      ← boss-greet 的内层脚本，别漏
```

**文档（3 + 若干引用）**
```
flow/BOSS-GREET.md     213 行
flow/BOSS-RULES.md     330 行  ← 含风控/限额章节，最该拿走
flow/BOSS-QUOTA.md      39 行
```

**代码里的引用（3 处）**
```
core/acceptance.mjs      调 boss-scan（验收里的真实站点任务）
core/runner.mjs          任务清单
core/tasks/greet-inner.mjs
```

**文档里的引用（精确计数，第 118 轮实测）**
```
flow/SCAN.md              19 处   ← 最多，整篇是招聘平台扫描
docs/USAGE.md              5 处
flow/INDEX.md              5 处
README.md                  3 处   ← 「案例：BOSS 直聘投递」整段
flow/WRITE.md              3 处
flow/CODEX-TECH-STACK.md   2 处
flow/RECIPE.md             1 处
docs/在线简历优化.md        1 处   ← 和项目本身无关，可整体移出
```

## 二、建议的操作顺序

```bash
# 1. 先在新分支上摘（保留历史，随时能拿回来）
git checkout -b public/release
git rm core/tasks/boss-*.mjs core/tasks/greet-inner.mjs core/tasks/greet-verify.mjs
git rm flow/BOSS-GREET.md flow/BOSS-RULES.md flow/BOSS-QUOTA.md

# 2. 验收里有两处要换：
#    - boss-scan（acceptance.mjs:193）：删掉 —— 它的返回值 scanOk 根本没被使用，等于白跑
#    - form-fill：换成 form-fill-local（本地 file:// 表单页，中性，同样验证填表链路）

# 3. 文档改引用
#    README：把「案例：BOSS 直聘投递」改成中性案例（见下）
#    USAGE / INDEX / RECIPE / SCAN / WRITE / CODEX-TECH-STACK：删掉名字，保留方法论
```

## 三、README 那个案例怎么改（方法论是金子，平台名不是）

现在写的是：

> 平台弹窗「已发送」不代表真的送达。唯一可信的判据是消息列表前后差集。

改成中性版（意思一模一样，不点名平台）：

> **界面提示「提交成功」不代表服务端真的收到。** 唯一可信的判据是外部事实：列表/接口/文件的前后差集。
> 这个项目早期正是拿界面提示当成功信号，连续 8 次误报；修好后的判定链是「目标 id 精确比对 → 按钮状态判断 → 外部列表差集」。

`flow/RECIPE.md` 里的方法论（外部事实验收、详情比对、差集判定）**全部保留**，只去掉招聘平台的语境。

## 三之二、还有三处零星引用（不改也能跑，但会露出名字）

```
core/run-classify.mjs   14 行：环境跳过分类里有「没有 BOSS 职位页标签」「无法切回 BOSS 职位页」
core/retry-policy.mjs   20 行：重试策略里同两条正则
core/browser.mjs        19 行：注释「首次使用需要在离屏窗口里登录一次（例如 BOSS 扫码）」
```

这些只是文案/正则，删任务后不会报错，但会把平台名留在代码里。要彻底干净就一起改。

## 四、别忘了 npm 包

```
第 78 轮实测：npm pack 出来的包里 core/tasks/ 也带着 8 个 boss-*
```
如果只是 `git rm` 而不改打包白名单，`files` 里的 `core/` 已经不包含它们了——**删文件即可，白名单不用动**。
但要复查一次：`npm pack --dry-run` 后 `tar -tzf` 里不应出现 `boss-`。

## 五、验收怎么补

`boss-scan` 在验收里承担的是「**真实站点 + 需要登录态**」这一档覆盖。删掉后少了这一档，建议：

- 保留 `browser-demo`（离屏 Chrome 读页面）
- 新增一个中性任务：读一个公开网页（如 example.com）并断言标题，覆盖「真实网络 + 页面解析」
- 填表那项直接用现成的 `form-fill-local.mjs`（本地 HTML 表单 + Electron accessory 窗口），链路一样是 AX 设值
- 这样验收仍是 10 项，不需要重新洗牌

## 六、做完怎么验

```bash
ls core/tasks | grep -c boss          # 应为 0
grep -ri "boss" README.md docs flow | grep -v REVIEW   # 应为 0（REVIEW 文件是历史记录，可保留）
npm test                              # 全绿
npm run repo:check                    # 全绿
npm pack --dry-run && npm pack && tar -tzf *.tgz | grep -c boss   # 应为 0
```

## 六之二、完整清单（第 120 轮实测：14 个代码文件 + 8 个文档）

**任务（7 个，可整文件删）**
```
core/tasks/boss-scan.mjs (15)  boss-scan-dedicated.mjs (6)  boss-candidates.mjs (5)
core/tasks/boss-greet.mjs (6)  greet-inner.mjs (11)  greet-verify.mjs (4)
core/tasks/form-fill.mjs (6)   ← 伪装成通用填表，删掉后验收换 form-fill-local
```

**基础设施（5 个，要改代码不是删文件）**
```
core/agentd.mjs (2)             parseJobs() 写死 zhipin.com/job_detail 正则，且被 test/parse.test.mjs 测试
core/run-classify.mjs (1)       环境跳过的正则提到 BOSS 标签
core/retry-policy.mjs (1)       同上
core/acceptance.mjs (1)         boss-scan 调用（返回值本来没人用）
core/runner.mjs (2)             注释里的示例任务名
core/browser.mjs (1)            注释「例如 BOSS 扫码」
scripts/cleanup-test-data.mjs  过滤测试数据的 zhipin|boss 正则
```

`parseJobs` 的正则可以改成通用链接解析（`link [标题](url)`），测试同步改，这样 API 还有用。

## 七、工作量


**修正为 4-6 小时**（第 119/120 轮实测后上调）：删 7 个任务 10 分钟、验收换两处 30 分钟、`parseJobs` 泛化 + 改测试 40 分钟、文档 8 个文件改写 2-3 小时、三处零星正则/注释 20 分钟。
风险很低——这些任务和核心控制层没有耦合，删掉不会影响任何其他功能。