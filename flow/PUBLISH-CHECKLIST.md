# 公开前的检查清单

> 从 66 轮外部评审整理出来。按顺序做，每项都能用命令验证。
> 生成于 2026-11-08。

## A. 必须先决定的两件事

- [ ] **A1. BOSS 直聘那部分要不要出现在公开仓库**
  - 现状：`core/tasks/boss-*.mjs` 4 个、`flow/BOSS-*.md` 3 份（582 行）、README 首页有「案例：BOSS 直聘投递」
  - 风险：自动投递违反平台用户协议；`BOSS-RULES.md` 有「风控」章节；仓库署真实姓名
  - 建议：移到私有仓库/本地分支；README 那条方法论（弹窗说已发送 ≠ 真送达）改用中性例子（表单提交/文件下载）来讲
  - 验证：`ls core/tasks | grep boss` 应为空、`grep -c BOSS README.md` 应为 0 或被中性描述替代

- [ ] **A2. 仓库用哪个名字/身份**
  - npm 包名 `desktop-agent` 已被占用，必须用 scoped（如 `@你的名字/desktop-agent`）
  - 提交作者现在是 `tester@goodlifedogdeMacBook-Pro.local`，公开后会暴露机器名且不关联 GitHub 主页
  - 设置：`git config user.name "<名字>" && git config user.email "<id>+<用户名>@users.noreply.github.com"`
  - 验证：`git config user.email` 有值、`git log -1 --format=%ae` 是 noreply 地址

## B. 发布配置

- [ ] **B1. 应用发布补丁**：`git apply flow/patch-publish.diff`（包名 scoped / bin / files / repository / CI 只跑 macOS / 徽章换真地址六项）
  - 应用后把 `@goodlifedog/desktop-agent` 和 `github.com/tester/desktop-agent` 换成真实值
  - 验证：`python3 -c "import json;d=json.load(open('package.json'));print(d['name'],bool(d['bin']),bool(d['files']),bool(d['repository']))"`

- [ ] **B2. 打包体积**：`npm pack --dry-run` 看文件数（应用补丁前是 227 个 / 4.2MB，应用后应降到几十）

- [ ] **B3. CI 真跑一遍**：矩阵收窄后，推上去看徽章是否绿；`node core/platform-smoke.mjs` 在 macOS 上应全过

## C. 文档与素材

- [ ] **C1. README 顶部要有演示 GIF**（15 秒内）：你在打字，AI 在后台点另一个窗口，小窗实时显示它在干什么
  - 这是决定「点进来 10 秒内能不能看懂」的第一要素

- [ ] **C2. 英文 README**：GitHub 主要受众是英文；至少首页顶部价值主张 + 30 秒快速开始要有英文版

- [ ] **C3. 命令速查表**：52 个 npm 脚本对新人太劝退，在 `docs/USAGE.md` 开头分三列（日常 / 排查 / 内部）

- [ ] **C4. 收窄绝对化承诺**：README 里「全程不抢焦点」已改成「尽量不抢」（`8f94977`），确认没有残留的绝对表述
  - 验证：`grep -n "全程不抢\|绝对不抢" README.md docs/*.md` 应为空

## D. 数据安全（发布前必须确认）

- [ ] **D1. 笔记删除的标记层**：`core/note-cleanup.mjs` 现在是「默认不删 + 要 --force + 只删顶部 N 条」，但删除脚本仍不核对标题
  - 建议补：删除前读 `name of rr`，只删 `[AGENT-TEST]` 前缀；测试写入时统一加该前缀

- [ ] **D2. 验收清理的语义**：`flow/AGENT-COORDINATION.md` 说「accept 结束会自动清理」，但实际默认只报告不删
  - 改成「自动调用清理，默认只报告；真删需 --force」

## E. 发布前最后一遍

```bash
npm test                    # 应全绿
npm run check               # 语法检查
npm run repo:check          # 文档命令/图片/绝对路径体检
npm run doctor              # 环境与两个服务
npm run prune               # 看日志/报告要不要清（dry-run）
git status                  # 工作区应干净
```

- [ ] **E1. 密钥扫描**：`git log -p --all | grep -E "sk-|ghp_|AKIA|PRIVATE KEY"` 应为空（第 52 轮扫过，干净）
- [ ] **E2. 历史整理**：仓库里有 20 个 `goodlifedog@users.noreply.github.com` 的自动检查点提交，公开前建议 squash 成初始提交
- [ ] **E3. 许可证**：`LICENSE`（MIT，真名）与 `third_party/open-computer-use/` 的 LICENSE/NOTICE 都在，`scripts/bundle-ocu.mjs` 会带上

## F. 发布

- [ ] **F1. 建仓库 + 推代码**（推送前先列 commit 清单确认）
- [ ] **F2. 打 tag `v0.7.0` + Release notes**（CHANGELOG 的「未发布」段可直接用）
- [ ] **F3. `npm publish --dry-run` 预演**，确认不会 403
- [ ] **F4. 发布后自测**：新机器 `git clone && npm run setup && npm run doctor` 能跑通
