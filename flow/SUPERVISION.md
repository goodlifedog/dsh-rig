# 外部监控日志（评审侧维护，执行侧按需读取）

> 更新：2026-11-08 23:06

## 一、最新核验结论（我实跑过）

| 项 | 结果 |
| --- | --- |
| 发布链路 | `npm pack` 137 文件/518KB，含 ocu 许可；全局安装后 `dsh-rig tasks/status` 可用；ocu 随依赖装好 ✅ |
| 门 | `npm test` 1197/0、`repo:check` 全通过 ✅ |
| 结构 | flow 45→19 份、docs 9→6 份，脚本归位 scripts/ ✅ |
| web-click | 示例可跑且已进验收 ✅ |

## 二、适配：三个错误假设已被实测推翻（请据此修正 docs/ADAPTERS.md）

1. **Preview 不适合排第一**：冷启动 12 秒仍无窗口；带上文档后再读会抢前台（已进 front-risk 名单）。
2. **OpenCode 不能用 CDP 接**：二进制直接拒绝参数 `bad option: --remote-debugging-port`（不是所有 Electron 都吃 Chromium 参数）。
3. **ChatGPT 不是 Electron**：`Contents/Frameworks` 只有 `Codex Framework` + `Sparkle`，没有 `Electron Framework`。

## 三、请修的分类器 bug（有明确判据）

`core/app-runtime.mjs` 现在：`if (electron || info.hasAsar) return { type: 'electron' }`
→ 只要有 `app.asar` 就判成 Electron，ChatGPT 因此被误分类。

建议：`app.asar` 只作为「疑似」，必须同时存在 `Electron Framework.framework` 或 `Electron Helper*.app` 才算 electron；
否则回落到 native/unknown。并补一条单测：有 asar、无 Electron Framework → 不得判 electron。

## 四、electron 端到端适配的正确流程（按这个做）

1. 先验证目标二进制**接受** `--remote-debugging-port`（拒绝就记「应用侧限制」，不要硬试）
2. 确认端口主人（`attachPage` 已 fail-closed，必须有 pid 或可执行路径比对）
3. 连 CDP → 读 title/url/text → 按文字点击 → 读回
4. 全程校验前台未变；抢前台就立刻还原并记入 front-risk
5. 结论写进 ADAPTERS：能接 / 不能接 / 需应用侧配合

候选顺序建议：Antigravity、抖音（都是真 Electron）→ 再考虑 ChatGPT（需处理 Codex 框架）。

## 五、时机约束

- 会启动应用的探测只在「用户离开（键鼠空闲 ≥ 180s）+ 屏未锁」时跑；你正用电脑时不要跑。
- 我这边探应用时已确认前台未变，但那是运气与设计共同作用，不应常态化。
