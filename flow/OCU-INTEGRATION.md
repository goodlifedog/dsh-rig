# 我们是怎么和 ocu 嵌合的

> 一句话：**不改 ocu 源码，装它、调它，在它上面加自己的层。**

## 一、分工

| 能力 | 谁提供 |
| --- | --- |
| 读界面树、点击、输入、滚动、拖拽、设控件值 | **ocu** |
| 调度（daemon、队列、应用锁、前台守卫） | 我们 |
| 展示（多会话小窗、缩略图、点击穿透） | 我们 |
| 验收（消息列表差集、仓库体检、重启自检） | 我们 |
| 平台抽象（窗口信息、抓图、服务自启） | 我们 |

## 二、两条调用通道

```
                    ┌──────────────────────────┐
  我们的任务 ──────▶│ core/platform.mjs        │
                    │  resolveOcu() 找可执行文件 │
                    └───────────┬──────────────┘
                                │
              ┌─────────────────┴──────────────────┐
              ▼                                    ▼
   core/ocu-mcp.mjs                       直接 spawn CLI
   spawn `ocu mcp` + JSON-RPC              `ocu js --file` / `ocu call`
   常驻会话，索引可复用                     一次性会话
```

### 通道 A：MCP 常驻（推荐）

```js
import { getOcuMcp } from './core/ocu-mcp.mjs';
const mcp = await getOcuMcp();
await mcp.callTool('get_app_state', { app: 'Google Chrome' });
await mcp.callTool('click', { app: 'Google Chrome', element_index: 12, click_method: 'accessibility' });
```

- 握手一次 41ms，之后单动作 20–120ms
- 元素索引 120 秒内可复用（CLI 每次重置，这是我们之前点错位置的根源）

### 通道 B：CLI（兼容/调试）

```js
execFile(resolveOcu(), ['js', '--file', script]);   // 一次性会话里跑多步
execFile(resolveOcu(), ['call', 'list_apps']);
```

好处是简单直观，适合脚本化调试；坏处是每次起进程（200–400ms），状态不共享。

## 三、ocu 是怎么被找到的

`core/platform.mjs` 的查找顺序：

1. `OCU_BIN` 环境变量（测试用）
2. **随包路径** `third_party/open-computer-use/bin/ocu`（打包成 App 时）
3. 用户全局安装 `~/.local/bin/ocu`
4. PATH 里的 `ocu`

随包的 ocu 是带 shebang 的 Node 脚本，所以 `ocu-mcp.mjs` 会用 App 自带的 Node（`ELECTRON_RUN_AS_NODE=1`）来执行它——这样用户机器上不需要装 Node。

## 四、为什么不 fork

见 `THIRD-PARTY.md`：

- ocu 的原生运行时是 Swift/AppKit 编译产物，fork 意味着小窗要从 Electron 重写成 Swift
- Windows 支持依赖它预编译的 `dist/windows`，fork 后要自己维护双平台构建
- 上游活跃迭代，深改会把合并变成长期负担

## 五、当前状态（诚实）

| 项 | 状态 |
| --- | --- |
| MCP 通道 | ✅ 已实现（`core/ocu-mcp.mjs`），有 demo 与基准 |
| 任务层 | ⚠️ **仍在用 CLI**，尚未迁移到 MCP |
| 随包运行时 | ✅ 已验证删掉全局 ocu 后仍可用 |
| 版本同步 | ✅ `scripts/check-ocu.mjs` + `flow/OCU-SYNC.md` |

任务层迁移是下一步收益最大的动作：投递任务现在每条要起好几次进程，迁到 MCP 后既能提速，也能顺手解决索引失效的问题。
