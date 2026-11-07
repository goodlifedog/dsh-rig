# 外部评审提供的补丁（按需应用）

> 这些不是必须打的。每个都独立可应用、互不冲突，打过之后 `npm test` 全绿。
> 最后更新：2026-11-08 03:10。当前共 2 个待打，均已 `git apply --check` 通过；第 4 个已应用。

## 顺序建议

```bash
git apply flow/patch-publish.diff            # 发布配置（发布前必打）
git apply flow/patch-prune-consolidate.diff  # 死代码合并（可选，建议打）
git apply flow/patch-deploy-freshness.diff   # 代码新鲜度检查（可选，建议打）
npm test && npm run repo:check
```

三个一起打之后实测：全量测试全过（当时 424 项，数字会随开发变化）、`repo:check` 全绿。

## 1. `patch-publish.diff`（78 行 / 3 个文件）

**发布前必打。**一次性解决六件事：

- 包名换成 scoped（`@goodlifedog/desktop-agent`，原名字在 npm 上被占用）
- 补 `bin`（`desktop-agent` 命令）、`files` 白名单（打包 249 文件 4.3MB → **138 文件 1.1MB**）
- 白名单额外排除评审/补丁类文档（`flow/REVIEW-*.md`、`flow/patch-*.diff`、`flow/BOSS-EXTRACT.md`、`flow/INDEX.md`、`docs/HANDOFF-*.md`）——这些是开发产物，尤其 `BOSS-EXTRACT.md` 是「怎么把招聘平台内容摘出去」的方案，随包公开很尴尬
- 同时**把根目录 `ARCHITECTURE.md` 加进白名单**：它是用户要读的架构说明，之前漏掉导致包内 `docs/USAGE.md` 的链接 404
- 排除后实测包内 9 处相对链接全部有效
- 补 `repository` 字段
- 补 `publishConfig`：`registry` 指官方源 + `access: public`（本机 npm 默认指向淘宝镜像，不加这条会发到镜像站，官方源上装不到）
- CI 矩阵收窄到 macOS（项目只支持 macOS，三平台会让徽章常年红）
- README 徽章占位 `USER` → 真实用户名

应用后还要手动改两处：npm 用户名、GitHub 仓库地址。

验证：
```bash
npm publish --dry-run   # 必须显示 Publishing to https://registry.npmjs.org ... public access
npm pack --dry-run      # 应显示 138 files / 1.1 MB
```

## 2. `patch-prune-consolidate.diff`（120 行 / 3 个文件）

清掉一份死代码：`core/prune.mjs` 的四个导出（`logTimestamp` / `selectStaleLogs` / `selectExcessReports` / `isPrunablePath`）全仓零引用，
真实逻辑在 `scripts/prune.mjs` 里自带一份。补丁把 `planPrune` 归位到 `core/prune.mjs`，
`scripts/prune.mjs` 只留 CLI，测试改 import 路径。

验证：
```bash
node scripts/prune.mjs      # 三段统计 + 可释放 X MB 都正常
node --test test/prune.test.mjs
```

## 3. `patch-deploy-freshness.diff`（191 行 / 3 个文件）

给 `npm run service:status` 加一列「代码新鲜度」：把每个常驻进程**启动时会加载的模块**的 mtime
和进程启动时间比，落后就提示 `npm run service:restart`（只提示，不自动重启）。

解决的问题：改了 `agentd.mjs` / `overlay/server.js` 这类启动时加载的文件却没重启时，
原来的「部署状态：ok」照样显示 ok，排查时会误以为改动没生效。

验证：
```bash
touch core/agentd.mjs && npm run service:status
# 应出现：daemon 代码新鲜度：落后 —— core/agentd.mjs 比进程新 N 分钟，建议 npm run service:restart
git checkout -- core/agentd.mjs   # 撤销 touch
```

## 4. ✅ `patch-chromium-applescript.diff`（37 行 / 2 个文件）—— 已应用，补丁文件已删除

**实测发现的问题**：`npm run app:resolve -- "Google Chrome"` 在 CDP 与 AX 都不可用时，
协商结果是「画面 + 坐标」，但 Chrome 的 AppleScript 字典是**可用**的（23 条命令、已授权）。
原因是 `RUNTIME_CHAINS.chromium` 里没有 applescript（electron / native / qt 都有），
于是可用脚本通道被静默跳过，直接落到本仓库并没有实现自动坐标点击的 visual。

补丁给 chromium 链加上 applescript（排在 visual 之前），并补一条断言：
CDP/AX 都不通时应退到 applescript，而不是直接画面坐标。

**已应用（2026-11-08）**：`core/app-runtime.mjs` 的 chromium 链已改为
`cdp → ax → applescript → visual`，`test/driver-resolution.test.mjs` 有对应断言。
实测 `npm run app:resolve -- "Google Chrome"` 协商结果已变成
「AppleScript 脚本字典 → 画面 + 坐标」。补丁文件已删除，可从 git 历史查到。

验证：
```bash
npm run app:resolve -- "Google Chrome"   # 协商结果应变成 AppleScript（若字典可用）
node --test test/driver-resolution.test.mjs
```

## 5. ✅ `patch-token-permissions.diff`（116 行 / 2 个文件）—— 已应用（主会话实现，覆盖更全），补丁文件已删除

**实测发现**：`~/.desktop-agent` 实际是 755（文档写 700），目录里的 `chrome-profile` / `headless-profile`
也是 755、大量文件 644 —— 浏览器 profile 里可能有登录态 cookie，本机其他用户可读。
根因是 `mkdirSync({mode:0o700})` 对已存在的目录不生效，且 `ensureTokenSync` 在「已有合法 token」时直接 return，不再校正权限。

补丁：`ensureTokenSync` 增加幂等的 `hardenPermissions()`（目录 700、文件 600），复用路径也执行；
首次创建后同样校正目录；配 2 条测试（旧文件 644→600、目录 755→700；首次创建即 700/600）。

验证：
```bash
node --test test/token-perm.test.mjs
ls -ld ~/.desktop-agent          # 跑过一次 daemon 后应为 drwx------
```

**已应用（2026-11-08）**：实现落在 `core/local-token.cjs` 的 `hardenDataDir`（除目录/文件外，
还把 bin/smoke/chrome-profile/headless-profile-p1/p2 六个子目录一起收紧），
`core/browser.mjs` 建 profile 后也 chmod 700；测试在 `test/local-token.test.mjs`（而非补丁里的
`test/token-perm.test.mjs`）。实机重启服务后复核全部 `drwx------`、token `-rw-------`。
补丁文件已删除，可从 git 历史查到。

## 5. `patch-host-check.diff`（110 行 / 4 个文件）

**实测发现**：两个服务都不校验 `Host` 头。伪造 `Host: evil.example` 时 daemon 返回 200、overlay 返回 200/202，
意味着网页可以通过 DNS rebinding（evil.com 解析到 127.0.0.1）读 daemon 的只读接口——
而 `/status` 里有任务历史、当前任务、pid 等信息。

补丁：`core/safety.mjs` 加纯函数 `isLoopbackHost()`（认 127.0.0.1 / localhost / [::1]，允许带端口）；
daemon 与 overlay 的 `assertLocalClient` 进来先查 Host，非本机一律 403；配 3 条测试。

注意：overlay 是 CJS、safety 是 ESM，所以 overlay 里保留了同规则的最小实现（5 行），不引构建步骤。

验证：
```bash
node --test test/safety-host.test.mjs
# 起一个备用端口的 daemon 后：
curl -s -o /dev/null -w '%{http_code}\n' -H 'Host: evil.example' http://127.0.0.1:7789/   # 应 403
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:7789/                          # 应 200
```

## 6. `patch-dialog-i18n.diff`（79 行 / 2 个文件）

**实测发现的风险**：`dialog-guard` 靠中文/英文关键词识别权限弹窗。德语「Bedienungshilfen」、
法语「Accessibilité」、日语「アクセシビリティ」都匹配不到，会被判成普通弹窗；
而白名单按钮里含 `OK`，这几种语言的权限弹窗按钮也叫「OK」/「許可」——有概率代点授权，
违反 SECURITY.md 的红线「权限类弹窗绝不代点」。作者本机是中英文系统，测不到。

补丁做两件事：① `PERMISSION_HINTS` 补齐德/法/日常见词条；
② 加**结构兜底**——`classifyDialog(text, buttons)` 只要按钮里出现授予类动作（允许/許可/Erlauben/Autoriser/Allow…），
不管文字认不认得出，一律按权限框处理不点。配 3 条多语言测试。

验证：
```bash
node --test test/dialog-i18n.test.mjs
```

## 7. `patch-retry-unify.diff`（32 行 / 1 个文件）

**发现的不一致**：`d49be81` 已从 `run-classify.mjs` 删掉「改成了指定关键词|已恢复原值」这条规则，
但 `core/retry-policy.mjs` 的 `NO_RETRY` 里还留着同一份规则——两处规则开始分叉。
这正是当初把规则抽成一份时要避免的（文件头注释写着「避免两套正则各说各话」）。

补丁：`retry-policy.mjs` 改为 `import { ENV_RULES } from './run-classify.mjs'`，
`NO_RETRY` 由 `ENV_RULES` 映射生成 + 额外保留 `/环境跳过/`，以后只需维护一份。

验证：
```bash
node --test test/retry-policy.test.mjs   # 6 项全过
npm test                                  # 全量全绿
```

## 已作废（不要再应用）

`patch-token-permissions.diff`：权限校正已由主会话自行实现（`hardenDataDir`，更完整——连 chrome-profile 等敏感子目录一起收紧），
该补丁已删除。

`patch-p1.diff`、`patch-classify.diff`、`patch-electron-task-test.diff`、`patch-ensure-app-window-test.diff`
对应实现都已在代码里，文件已删除；从 git 历史可查到。