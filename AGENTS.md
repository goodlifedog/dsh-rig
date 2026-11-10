# AGENTS.md

> 给在这个仓库里工作的 AI agent 和协作者的项目级约定。仓库级规则优先于通用习惯；
> 与本文件冲突时，以「安全边界」和「不许假绿」两条为准。

## 这个项目是什么

**DSH Rig**：macOS 上的后台控制层——用 Accessibility 语义树驱动真实应用、用 CDP 驱动浏览器，
全程不抢前台；Electron 小窗实时回显它在干什么；常驻 daemon 串行跑任务，所有结论都能复核。

- 技术栈：Node.js（ESM）+ Electron（仅 overlay）+ 原生 macOS API（经 ocu 封装）
- 文档语言：中文为主；对外标识、包名、图表标签用英文
- 一个项目一个文件夹：本仓库就是项目全集，过程记录归档在 gitignore 的 `_archive/`

## 30 秒上手

环境：macOS 14+、Node.js 20+。

```bash
npm run setup        # 装根目录与 overlay 的依赖
npm run doctor       # 环境自检：ocu / 辅助功能权限 / 小窗 / daemon
npm test             # 纯逻辑单测（不启动 GUI、不动屏幕）
npm run check        # 全仓语法检查
npm run repo:check   # 仓库体检：文档、隐私、命令、图片、任务清单一致性
npm run verify       # check + test + repo:check，提交前跑这个
npm run verify:safe  # 不碰屏幕的集成验证（可在用户正在用电脑时跑）
```

## 仓库地图

```text
core/         控制层：ocu 封装、daemon、runner、浏览器/CDP、平台差异、纯函数库
  tasks/      可单独运行的任务（每个都是自证脚本）
overlay/      Electron 小窗：多会话、缩略图、点击穿透、会话门控
scripts/      仓库检查、安全自查、发布彩排、监控与巡检脚本
docs/         规范文档（USAGE / ADAPTERS / SECURITY / MAC-APPS / APP-SUPPORT-ARCHITECTURE）
flow/         方法论与流程规范（INDEX.md 是入口）
examples/     可独立运行的最小示例（web-click、adapters 样例）
test/         node:test 单测；新行为必须带测试
third_party/  随包分发的 ocu 许可与声明（不 vendor 源码）
_archive/     一次性过程记录（gitignored，不进仓库、不进 npm 包）
```

关键文档：

- 用法与排障：[docs/USAGE.md](docs/USAGE.md)
- 应用适配与证据等级：[docs/ADAPTERS.md](docs/ADAPTERS.md)
- 安全边界：[docs/SECURITY.md](docs/SECURITY.md)
- 架构与通道矩阵：[docs/APP-SUPPORT-ARCHITECTURE.md](docs/APP-SUPPORT-ARCHITECTURE.md)
- 流程规范入口：[flow/INDEX.md](flow/INDEX.md)

## 代码约定

- 一律 ESM（`.mjs`）；纯逻辑抽成可注入依赖的纯函数，GUI/系统调用放边上，便于单测。
- 平台差异只允许出现在 `core/platform.mjs` 和 `overlay/platform.js`；业务代码不要直接调
  `osascript` / `screencapture`。
- 不写死本机绝对路径；用户目录用 `os.homedir()` 拼。新增 npm 依赖前先说明理由，能用标准库就不加。
- 失败要分类：环境问题（锁屏 / 用户在用 / 应用没开 / 缺权限）→ 环境跳过；能力问题 → 真失败。
  规则只有一份：`core/run-classify.mjs`，不要在别处另写一套。
- 注释与提交信息用中文；代码标识符与对外文案用英文。

## 安全边界（不可协商）

- **不抢前台**：不激活目标应用、不移动系统指针；front-risk 名单命中即跳过，`--allow-launch` 也绕不过。
- **不碰用户数据**：写操作默认拒绝；测试只改自己创建的数据，跑完清理；绝不覆盖用户已有内容。
- **不代点系统弹窗**：权限/授权/安装/删除类对话框一律不点。
- **AppleEvent 先预检**：没有自动化授权就不发事件，避免弹授权框。
- **ocu 门禁**：直接调 ocu 前必须有 `isAppRunning` / `ensureAppRunning` 一类检查；
  新代码必须通过 `npm run safety:audit`。
- 会动屏幕的验证只在用户离开时跑；用户一碰键鼠，1–2 秒内停。

## 测试与验收

- 新行为必须有测试，覆盖失败路径与「环境跳过」分支；负向用例优先。
- **环境跳过不等于通过**，没验证到的东西不许写成「已通过」；报告里如实写 SKIP 原因。
- 提交前最低门槛：`npm run check` + `npm run repo:check`；改动逻辑时跑 `npm run verify`。
- 发布前：`node scripts/release-rehearsal.mjs`（干净副本六步：archive/install/test/pack/global/publish dry-run）。

## 适配新应用

流程见 [docs/ADAPTERS.md](docs/ADAPTERS.md)。要点：

1. 先查 front-risk 名单与是否在运行；没运行不加 `--allow-launch`。
2. 用 `core/tasks/adapter-demo.mjs` 先读树，再按文字点击/键入，最后读回证据。
3. 只有真实跑通并留下可复制命令与输出，才能把证据等级写成 S；预判只能写 P，被推翻写 X。
4. 点击/键入都要有「变化前 → 变化后」的证据，并且确认前台未变。

## 隐私与发布

- 作者与提交身份统一用 `goodlifedog <goodlifedog@users.noreply.github.com>`。
- 仓库与产物里禁止出现：真实姓名、本机用户名/主机名、绝对路径、个人材料、token、私有 IP。
  `npm run repo:check` 会动态扫描这些；不要用绕过手段提交。
- 数据目录固定在 `~/.desktop-agent`（升级不迁移、不丢数据）。
- **不自动 push、不自动建仓库、不自动发布**：远程动作需要用户明确授权；本地提交随时可做。
- 打包只允许带 `third_party/open-computer-use` 的 LICENSE / NOTICE / THIRD_PARTY_NOTICES。

## 提交与协作

- 提交信息用中文、动词开头，说明「做了什么 + 为什么」；一个提交只做一件事。
- 用户可见的行为变化要同步 `CHANGELOG.md`；新增/修改文档要能过 `npm run repo:check`。
- 多 agent 并行时按「单写者」拆文件；子 agent 不 commit、不改文档、不跑全量测试，
  由 Lead 统一核验后提交。
- 改代码前先读对应 `flow/` 规范；改完在提交信息里写清验证命令与结果。

## License

MIT。底层控制能力来自 [open-computer-use](https://github.com/iFurySt/open-computer-use)（MIT），未修改其源码。
