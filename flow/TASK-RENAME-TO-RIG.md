# 任务单：改名 DSH Rig + 内置 ocu + 可搜索性（2026-11-08 14:22 用户拍板）

> 这是外部评审写给「布局规划」会话的正式任务单。用户在 14:22 确认了名字和方向，
> 请按本文件执行；有疑问在 `flow/REVIEW-ACTIONS.md` 回写。

## 一、已定的事（不要再讨论）

| 项 | 决定 |
| --- | --- |
| 英文品牌 | **DSH Rig** |
| 中文品牌 | **DSH 装置**（备选叫法「DSH 控制台」） |
| 仓库名 | `dsh-rig` |
| npm 包 | `@goodlifedog/dsh-rig`（registry 用官方源，access public） |
| CLI 命令 | `dsh-rig` |
| App 显示名 | `DSH Rig` |
| appId | `com.goodlifedog.dsh-rig` |
| launchd 标签 | `com.goodlifedog.dsh-rig.daemon` / `com.goodlifedog.dsh-rig.overlay` |
| 版本 | 0.7.0 → **0.8.0** |

一句话定位：**DSH 的后台电脑控制装置 —— 后台操作 · 小窗回显 · 自动化验收。**

为什么叫 Rig：一个词同时装下「装置（控制台 + 工具链 + 测试台）」，且 `dsh-` 前缀与本机现有
`dsh-context` / `dsh-ghidra` 命名一致；npm 上 `dsh-rig` 未被占用（`dsh-bench` / `dsh-cockpit` /
`dsh-workbench` / `dsh-console` 都已被占）。

## 二、改名范围

全仓替换（约 347 处 `desktop-agent`、65 处 `Desktop Agent`、17 处 `com.desktop-agent`）：

- `package.json`：`name`、`bin`、`description`、`keywords`、`repository`、`publishConfig`、`files`
- `overlay/package.json`、`overlay/electron-builder.yml`：`appId` / `productName` / `artifactName`
- `core/service.mjs` + `core/cli.mjs`：launchd 标签、`launchctl` 命令里的 label
- `core/platform.mjs` 及文档里的命令示例、徽章、CI（`.github/workflows/ci.yml` 里的路径/名称）
- 文档：`README.md` 标题与徽章、`docs/**`、`flow/**`、`CHANGELOG.md`

**必须保留不改的**：

1. 数据目录 `~/.desktop-agent/`（748MB，含 token、Chrome profile）——改名要迁移，风险大于收益；
   代码里 DATA_DIR 常量保持，README 里注明「数据目录沿用 `~/.desktop-agent`，避免破坏已有安装」
2. 本机仓库目录名 `desktop-agent/`（只是本地路径，不影响对外）
3. git 历史

**改名的运行时动作**（关键，别漏）：

```bash
npm run service:uninstall     # 先卸掉旧 label 的服务
npm run service:install       # 用新 label 装回来
npm run service:status       # 确认只有新服务在跑，没有旧 label 残留
```

否则旧 `com.desktop-agent.daemon` 和新 `com.goodlifedog.dsh-rig.daemon` 会同时抢 7789。

## 三、内置 ocu（用户明确要求：克隆下来就能用）

现状问题：`third_party/open-computer-use/{bin,dist,scripts}` 被 `.gitignore` 排除（37MB 不入库），
`package.json` 也没有 ocu 依赖 → 别人克隆后 `npm start` 直接报「没有控制后端」。

采用**方案 A：声明成 npm 依赖，不 vendor 二进制**。

```json
"dependencies": { "open-computer-use": "^1.1.3" }
"keywords": ["dsh", "macos", "desktop-automation", "computer-use", "accessibility",
             "background-control", "overlay", "acceptance-testing", "open-computer-use"]
```

代码侧改 `core/platform.mjs` 的 `resolveOcu()` 查找顺序：

```
1. OCU_BIN 环境变量
2. node_modules/open-computer-use/bin/ocu   ← 新增（npm install 后直接可用）
3. third_party/open-computer-use/bin/ocu    ← 打包 .app 用
4. ~/.local/bin/ocu                          ← 兼容已全局安装的用户
5. Windows 的 %APPDATA%/npm/ocu.cmd
```

打包 .app 时从 `node_modules/open-computer-use` 拷，不要再去别处找（`scripts/bundle-ocu.mjs` 相应简化）。

**许可（必须一起做）**：ocu 是 **MIT，Copyright (c) 2026 Leo**，允许商用/修改/再分发，
唯一要求是保留版权声明与许可全文。

- 仓库里已有 `third_party/open-computer-use/{LICENSE,NOTICE.md,THIRD_PARTY_NOTICES.md}`，保留
- `package.json` 的 `files` 白名单必须包含这三个文件（否则 npm 包里没有声明，属违约）
- `.app` 的 `extraResources` 已经会带 `third_party`，确认 LICENSE 在里面
- README 增加一行：「基于 [open-computer-use](https://github.com/iFurySt/open-computer-use)（MIT, © 2026 Leo）构建，未修改其源码」

## 四、可搜索性（用户明确要求：GitHub 上能搜到）

**仓库 About（建仓后手动粘贴）**：

```
DSH 的后台电脑控制装置：后台操作 macOS 真实应用、小窗实时回显、自动化验收。不抢焦点、不动你的鼠标。
Background desktop control for macOS with live mini-window and verified acceptance tests. Based on open-computer-use (MIT).
```

**Topics（20 个上限，按这个填）**：

```
macos  desktop-automation  computer-use  accessibility  ax  applescript  cdp
background-control  overlay  automation-testing  acceptance-testing  agent  cli  electron  dsh
```

**README 首屏重排**（现在第一行只有 `# Desktop Agent`，没有截图也没有英文关键词）：

1. `# DSH Rig · DSH 装置`
2. 一行中英双语定位（英文句子里带 macOS / desktop automation / background control 关键词）
3. **一张 GIF**：后台打开备忘录 → 小窗出现 → 前台全程是 Chrome（这是最强差异化，留占位也行，但不要没有）
4. 徽章：CI / npm version / license / platform macOS
5. 一行 Keywords（英文小写，别堆砌）

注意：GitHub 搜索对新仓库的通用词排名基本没戏（star/时效决定），能拿到的是**品牌词精确命中 + topic 检索**，
所以不要为了 SEO 把关键词塞进仓库名。

## 五、验收标准（做完逐条自查）

```bash
npm test                      # 全绿（当前基线 607 项）
npm run verify                # 语法 + 单测 + 仓库体检
npm run doctor                # 在「没有全局 ocu」的环境也要能找到 node_modules 里那份
npm pack --dry-run            # 包含 third_party/open-computer-use/LICENSE 与 NOTICE
npm run service:uninstall && npm run service:install && npm run health   # 服务标签换新且只有一套
```

额外确认：

- README/CI 里没有残留的 `USER` / `desktop-agent` 占位
- `grep -rn "desktop-agent" --include=*.mjs core scripts | grep -v "\.desktop-agent"` 应为空（数据目录除外）
- `flow/TASKS.md`、`flow/TASK-ENV.md`、`flow/INDEX.md` 同步（`npm run repo:check` 会把关）

## 六、建议顺序

1. 改名（代码 + 文档 + CI + electron 配置），跑测试
2. ocu 依赖 + `resolveOcu` 查找顺序 + `files` 白名单 + README 声明，跑测试与 `npm pack --dry-run`
3. README 首屏重排（GIF 占位先留着）
4. 发布配置（name/bin/files/publishConfig）直接落到仓库里，**不要再做成 patch**
5. 版本 0.8.0 + CHANGELOG 收口 + 彩排一次（干净副本 → 打包 → 安装 → publish dry-run）

## 七、外部评审这边负责的

- 改名完成后我做一轮复核（命名残留、许可文件是否真的进包、`resolveOcu` 回退顺序、发布彩排）
- `flow/` 下的补丁会同步清理；发布补丁已失效，按第 6 步直接落仓库即可
