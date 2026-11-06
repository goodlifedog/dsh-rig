# 第三方依赖与归属

> 这个仓库**不是凭空自研的完整技术栈**。核心控制能力依赖一个开源工具，界面依赖 Electron。下面是逐项说明，避免误以为所有东西都是自己写的。

## 一、本项目自己写的部分

仓库里 49 个源文件、全部 `core/`、`overlay/`、`tools/`、`scripts/`、`flow/` 内容均为本项目自己编写：

| 模块 | 作用 |
| --- | --- |
| `core/daemon.mjs` `runner.mjs` `cli.mjs` | 常驻服务、任务队列、命令行 |
| `core/agentd.mjs` | ocu 封装、overlay 客户端、应用锁、前台守卫 |
| `core/platform.mjs` | 平台抽象（控制后端探测、路径、服务管理） |
| `core/browser.mjs` `cdp.mjs` `human.mjs` `frames.mjs` | 离屏浏览器、CDP 客户端、拟人轨迹、帧推送 |
| `core/backends/uia.mjs` | Windows 控制后端适配层 |
| `core/tasks/*.mjs` | 具体任务（含 BOSS 投递与验收） |
| `overlay/*` | 多会话小窗：主进程、HTTP 服务、渲染、平台层、会话门控 |
| `tools/uia-bridge.ps1` | Windows UI Automation 桥 |
| `scripts/*` | 仓库体检、重启自检、导出 |
| `flow/*` | 方法论与踩坑记录 |

仓库内**没有 vendor 任何第三方源码**，也没有拷贝来的版权头。

### 与 ocu 的集成方式：进程调用，不是改它的代码

| 方式 | 是否采用 |
| --- | --- |
| Fork 它的仓库、在它上面改 | ❌ 没有 |
| 修改/补丁它的安装包 | ❌ 没有（已验证安装目录今日无任何文件改动） |
| Vendor 它的源码进我们仓库 | ❌ 没有（只有为合规附带的 LICENSE/README） |
| **把它的 CLI 当外部工具调用** | ✅ 采用 |

```js
// 我们的调用是进程边界，不 import 它的代码
const OCU = resolveOcu();
execFile(OCU, ['js', '--timeout', '60000', '--file', script]);
```

好处：它可以独立升级、我们可以单独发布；坏处：它的 CLI 接口变了我们要跟着改。


## 二、运行时依赖（不在仓库里，需要自行安装）

| 依赖 | 作用 | 许可 | 是否随仓库分发 |
| --- | --- | --- | --- |
| [open-computer-use](https://github.com/iFurySt/open-computer-use)（`ocu`） | **macOS 控制层的核心**：读写 Accessibility 树、语义点击、后台键入 | MIT | 否，需自行安装 |
| Electron | 承载小窗界面 | MIT | 否，npm 安装 |
| Google Chrome | 被驱动的浏览器（CDP 调试） | 专有 | 否，用户自有 |
| macOS / Windows 系统工具 | osascript、screencapture、PowerShell、launchctl、schtasks | 系统自带 | 否 |

**重点说明**：macOS 上的点击、读界面、后台输入，底层能力来自 `ocu`。本项目做的是把它的 CLI 包装成可调度、可验证、可展示的一层——不是自己实现了 Accessibility 控制。
换掉 `ocu` 后，macOS 和 Windows 的控制都不可用——ocu 的安装包里带 `dist/windows/{amd64,arm64}` 原生运行时，官方支持 Windows。我们自写的 UIA 桥只是没有 ocu 时的兜底。

## 三、仅作资料参考、未使用其代码

| 来源 | 用途 | 是否使用代码 |
| --- | --- | --- |
| 即投（浏览器插件） | 观察其行为，确认「已向BOSS发送消息」是结果通知而非送达回执 | 否 |
| [get_jobs](https://github.com/yuanhhui/get_jobs) | 参考其公开文档与注释中对 BOSS 弹窗语义的描述 | 否 |
| BOSS 直聘帮助中心 / 黑猫投诉官方回复 | 每日沟通额度规则 | 否 |

这些来源的结论都写在 `flow/BOSS-RULES.md`，每条附链接。

## 四、许可合规

- 本项目：MIT（见 `LICENSE`）
- `ocu`、Electron：MIT，允许商用与再分发，但**再分发时需保留其版权声明**
- **本项目允许随包附带 ocu**，用 `scripts/bundle-ocu.mjs` 自动带上它的 LICENSE 与第三方声明

## 五、随包附带 ocu 的正确做法

```bash
node scripts/bundle-ocu.mjs                 # 只带 LICENSE、第三方声明、元数据（推荐）
node scripts/bundle-ocu.mjs --with-binary   # 连运行时一起拷，体积大
```

输出在 `dist/vendor/open-computer-use/`，含它的 LICENSE、THIRD_PARTY_NOTICES.md，以及本项目生成的 NOTICE.md。
`scripts/export.sh` 会自动调用，所以导出的发布包里已经带了许可与声明。

无论是否附带二进制，都**不要修改 ocu 的源码后当成自己的**；本项目只是调用它的 CLI。

## 六、一句话结论

**架构、调度、小窗、任务、验证体系是自己写的；底层「能操作 macOS 应用」这个能力来自开源项目 ocu。**
如果你希望这一层也完全自研，需要自己实现 Accessibility 客户端（读 AX 树、AXPress、后台键入），工作量不小，但技术上可行。
