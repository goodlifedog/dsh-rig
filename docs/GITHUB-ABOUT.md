# GitHub About 文案（可直接粘贴）

> 用途：仓库页右上角 **About** 的 Description / Topics，以及仓库名与 Website 字段。
> 下面是建议值；改完记得同步 README 首屏的徽章链接（仓库名写死在 CI 徽章里）。

## 仓库名

- owner：`goodlifedog`
- repo：`dsh-rig`
- 完整地址：`goodlifedog/dsh-rig`

## Description（中文）

> 后台控制真实 macOS 应用，全程不抢焦点：Accessibility 语义驱动 + 多会话小窗回显 + 常驻调度 + 可验证结论。clone 就能用。

## Description（English）

> Background control for real macOS apps without stealing focus. Accessibility-driven actions, a multi-session overlay that shows what's happening, a resident task daemon, and verifiable results. Clone and run.

## Topics（15 个，小写短横线）

```text
macos
accessibility
automation
computer-use
background-automation
electron
overlay
screenshot
cdp
devtools-protocol
ai-agent
cli
nodejs
task-runner
verification
```

## Website

二选一：

- 留空（推荐：仓库 README 已经承载全部说明）
- 或填 `https://github.com/goodlifedog`（作者主页）

## 一键写入（可选，需要 GitHub CLI）

```bash
gh repo edit goodlifedog/dsh-rig \
  --description "后台控制真实 macOS 应用，全程不抢焦点：Accessibility 语义驱动 + 多会话小窗回显 + 常驻调度 + 可验证结论。clone 就能用。" \
  --add-topic macos,accessibility,automation,computer-use,background-automation,electron,overlay,screenshot,cdp,devtools-protocol,ai-agent,cli,nodejs,task-runner,verification
```

（英文版 Description 可在 GitHub 网页端切换填写；About 只有一个描述字段，建议用中文主描述 + 英文关键词覆盖。）
