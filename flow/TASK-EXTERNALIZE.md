# 对外化改造总任务单（2026-11-08 22:20 用户确认方向）

> 本文汇总用户与外部评审讨论后确定的方向与待办，交给「布局规划」会话执行。
> 执行完本文所有 P0/P1 后，项目才具备「对外发布」的形态；本文自身也属于过程文件，发布前删除。

## 一句话目标

把现在的「AI 通宵工作现场」改造成一个**干净的、可公开的、别人克隆下来就能用**的项目：
名字叫 DSH Rig，能力是通用的网页/桌面后台操作，示例是通用的，许可证齐全，仓库里没有任何私人内容。

---

## P0-1 隐私清理（公开发布前必须完成）

**仓库里现在有用户的个人简历：**

```
docs/在线简历优化.md   （26 行，含 2027 届本科、实习公司类型、项目名、期望职位「武汉 · 8-15K」）
```

- [ ] 从仓库删除该文件
- [ ] **处理 git 历史**：只删 HEAD 不够，历史仍可查。二选一：
      a) `git filter-repo --path docs/在线简历优化.md --invert-paths`（改动全历史哈希）
      b) 以当前清理后的状态作为**首个提交**新建仓库（最干净，推荐）
- [ ] `repo:check` 增加规则：禁止简历/个人信息类文件（文件名或内容命中「简历/期望职位/毕业」等）

## P0-2 摘掉 BOSS 直聘（用户明确：这不是项目方向）

现状：BOSS 已从「示例」渗进 core——**7 个任务 1745 行**、`core/agentd.mjs:283` 硬编码 zhipin 正则、
`core/acceptance.mjs` 有一项是跑 boss-scan、4 份 BOSS 文档、全仓 67 个文件 361 行提到 BOSS。

目标形态：**core 只留通用能力；BOSS 这种业务是用户下载后自己写的东西，不进产品。**

- [ ] 删除 `core/tasks/` 下 7 个 BOSS 任务：`boss-scan` `boss-scan-dedicated` `boss-candidates`
      `boss-greet` `greet-inner` `greet-verify` `form-fill`（共 1745 行）
- [ ] `core/agentd.mjs` 的 `parseJobs`（zhipin 专用）：删除或改成通用「从 AX 快照提取链接」
- [ ] `core/acceptance.mjs` 去掉 `boss-scan` 这一项，替换成下面的通用网页点击示例
- [ ] 删除 4 份 BOSS 文档：`flow/BOSS-*.md`
- [ ] 清理测试里 BOSS 相关引用（`test/` 下 10 个文件提到，逐个确认是不是业务断言）
- [ ] README / CAPABILITIES / ARCHITECTURE / USAGE 里所有 BOSS 叙事改为通用场景

**用户定调**：项目要“强大到可以直接在网页里面点击”，招聘投递只是别人下载后会做的其中一件事。

## P1-1 加一个通用示例，替代 BOSS 的位置

- [ ] 新增 `examples/web-click/`：
      打开一个页面 → 按文字找到按钮 → 后台点击 → 读回结果 → 断言成功
      全程不抢前台（用现有 CDP / 按文字点击能力），配套 20–30 行 README
- [ ] 验收里用这个示例替代 boss-scan，证明「通用网页点击」可用
- [ ] README 首屏的演示故事换成这个示例 + 一张 GIF

## P1-2 仓库结构清理（让它像真实仓库）

对比 ocu 的做法：`AGENTS.md` 导航 + `docs/` 全是规范 + `scripts/` 放脚本 + 根 package `private: true`；
**没有**评审日志、任务看板、补丁文件、个人文档。我们现在的情况：

```
flow/ 45 个跟踪文件 = 真文档约 18 + AI 过程记录约 20 + BOSS 4 + 失效补丁 1 + .mjs 脚本 4
docs/ 里混进 REVIEW.md / HANDOFF-2026-11-07.md / SECURITY-REVIEW-2026-11-08.md
```

- [ ] `flow/` 里的一次性记录移出仓库（或移入不被跟踪的 `.internal/`）：
      `REVIEW-*.md` `TEAM-BOARD.md` `FINAL-REPORT.md` `PATCHES.md` `START-HERE.md`
      `TASK-RENAME-TO-RIG.md` `PUBLISH-*.md` `patch-publish.diff`
- [ ] `flow/` 里的 4 个脚本移到 `scripts/`（或 `tools/`）：
      `flow/probe.mjs` `flow/probe-inner.mjs` `flow/cdp-probe.mjs` `flow/review-watch.mjs`
- [ ] 真文档并进 `docs/`（BACKGROUND-CONTROL、MONITORING、WRITE、PACKAGING、CROSS-PLATFORM、TASK-ENV…）
      最终 `flow/` 可以整个消失，或只留少数方法论文档
- [ ] `docs/` 里的过程文档（REVIEW/HANDOFF/SECURITY-REVIEW）移出
- [ ] 更新 README/INDEX 里的所有链接；`repo:check` 的文档检查要随之调整

## P1-3 改名 DSH Rig（用户已定）

| 项 | 值 |
| --- | --- |
| 英文 / 中文 | DSH Rig / DSH 装置 |
| 仓库 / npm | `dsh-rig` / `@<你的npm名>/dsh-rig` |
| 命令 / App | `dsh-rig` / `DSH Rig` |
| appId | `com.<你的域名反写>.dsh-rig` |
| launchd | `com.<你的域名反写>.dsh-rig.daemon` / `.overlay` |
| 版本 | 0.7.0 → 0.8.0 |
| 副标题 | DSH 的后台电脑控制装置 —— 后台操作 · 小窗回显 · 自动化验收 |

- [ ] 全仓替换（约 347 处 `desktop-agent` / 65 处 `Desktop Agent` / 17 处 `com.desktop-agent`）
- [ ] **保留不改**：数据目录 `~/.desktop-agent`（748MB，含 token 与 Chrome profile）、本机仓库目录名、git 历史
- [ ] 换 launchd 标签后必须 `service:uninstall` → `service:install`，否则新旧服务抢 7789

## P0-3 内置 ocu（用户要求：克隆下来就能用）

现状：`third_party/open-computer-use/{bin,dist,scripts}` 被 gitignore，`package.json` 也没有 ocu 依赖 →
别人克隆后 `npm start` 直接报「没有控制后端」。

- [ ] `package.json` 增加 `"dependencies": { "open-computer-use": "^1.1.3" }`
- [ ] `core/platform.mjs` 的 `resolveOcu()` 查找顺序改为：
      `OCU_BIN` → `node_modules/open-computer-use/bin/ocu` → `third_party/.../bin/ocu` → `~/.local/bin/ocu` → Windows
- [ ] 打包 `.app` 时从 `node_modules` 拷（简化 `scripts/bundle-ocu.mjs`）
- [ ] **MIT 许可随产物**（ocu: MIT, © 2026 Leo）：`files` 白名单必须含
      `third_party/open-computer-use/{LICENSE,NOTICE.md,THIRD_PARTY_NOTICES.md}`；`.app` 的 extraResources 已带，确认里面能查到
- [ ] README 加一行：「基于 open-computer-use（MIT, © 2026 Leo）构建，未修改其源码」

## P2-1 可搜索性（用户要求：GitHub 能搜到）

- [ ] 仓库 About（建仓后粘贴）：
      `DSH 的后台电脑控制装置：后台操作 macOS 真实应用、小窗实时回显、自动化验收。不抢焦点、不动你的鼠标。`
      `Background desktop control for macOS with live mini-window and verified acceptance tests. Based on open-computer-use (MIT).`
- [ ] Topics：`macos desktop-automation computer-use accessibility ax applescript cdp
      background-control overlay automation-testing acceptance-testing agent cli electron dsh`
- [ ] README 首屏：`# DSH Rig · DSH 装置` + 中英双语定位 + GIF + 徽章 + keywords 行
- [ ] `package.json` 的 `keywords`、`description` 同步（npm 站内搜索用）

## P2-2 学 ocu 补 agent 协作文件（可选但推荐）

我们根目录现在没有 `AGENTS.md` / `CLAUDE.md` / `.agents/` / `skills/`。ocu 有，而且明说自己是
「面向 Agent 协作开发的基础模板」——`AGENTS.md` 只做导航，知识放 `docs/`。

- [ ] 新增项目级 `AGENTS.md`（简短导航：先读 ARCHITECTURE → CAPABILITIES → 改完跑哪些验证）
- [ ] 新增 `docs/COLLAB-GUIDE.md`（提交流程、文档同步约定、验证命令）
- [ ] 内部台账（TEAM-BOARD/REVIEW/PATCHES/TASK-*）**不进发布包**

## P0-4 发布配置与彩排

- [ ] 发布配置直接落进仓库（`name` / `bin` / `files` / `publishConfig` / `repository`），**不再用 patch 文件**
- [ ] `files` 白名单：只放 `core/ overlay/ docs/(面向用户) README ARCHITECTURE CHANGELOG THIRD-PARTY LICENSE`
      排除：`flow/` 内部台账、`test/`、`third_party` 运行时二进制（但要保留 LICENSE/NOTICE）
- [ ] 版本 0.8.0 + CHANGELOG 收口（现在「未发布」段有 150+ 条，需要整理成面向用户的版本说明）
- [ ] 彩排一次：干净副本 → `npm install`（自动装 ocu）→ 测试 → 打包 → 全局安装 → `publish --dry-run`

## 验收标准（做完逐条自查）

```bash
npm test                # 全绿（当前基线 1184 项，删 BOSS 后会减少）
npm run verify          # 语法 + 单测 + 仓库体检
npm run doctor          # 在没有全局 ocu 的环境也要能找到 node_modules 里那份
npm pack --dry-run      # 包含 ocu LICENSE/NOTICE；不含 flow 内部台账、不含 BOSS、不含简历
git grep -i -E "boss|zhipin" -- "*.mjs" "*.md"   # 应为 0
git grep -i "简历\|期望职位"                     # 应为 0
npm run service:uninstall && npm run service:install && npm run health   # 服务标签换新且只有一套
```

## 建议顺序

1. 隐私（删简历 + 处理历史）→ 2. 删 BOSS → 3. 仓库结构清理 → 4. 通用示例 →
5. 改名 → 6. 内置 ocu + 许可 → 7. 叙事与可搜索性 → 8. 发布配置 + 彩排

第 1、2 步会让测试数量下降（删了 BOSS 的测试），这是预期的，不是退化。
