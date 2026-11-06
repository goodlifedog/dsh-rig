# 发布到 GitHub

> 仓库目前只是本地 git，**没有任何远端**。推送需要你明确授权，AI 不会自己推。

## 一、推送前自检

```bash
cd desktop-agent
npm run repo:check     # 版本一致、无依赖产物、无大文件、无隐私泄漏
npm test               # 单测
```

三项全绿再往下。

## 二、建远端并推送

推荐用 GitHub CLI，一条命令建仓库并推：

```bash
gh repo create desktop-agent --public --source=. --remote=origin --push
```

手动方式：

```bash
git remote add origin git@github.com:你的用户名/desktop-agent.git
git branch -M main
git push -u origin main
```

## 三、推送前要确认的几件事

| 项 | 怎么确认 |
| --- | --- |
| README 里的 CI 徽章地址 | 把 USER 换成你的 GitHub 用户名 |
| 截图是否要公开 | overlay/docs 下的 PNG 是本地测试窗口截图，不含个人数据 |
| 提交历史 | git log --oneline 过一遍，看有没有夹带不该出现的路径 |
| LICENSE 署名 | 已写「goodlifedog」，需要改自己改 |

## 四、仓库描述与标签建议

描述：

> 后台电脑控制 + 小窗回显：用 Accessibility 语义树驱动真实 macOS 应用，全程不抢焦点、不动鼠标

标签：macos、windows、automation、accessibility、computer-use、electron、overlay

## 五、之后

- 每次改动完跑一遍 npm run repo:check，避免把日志或依赖带上去
- 版本号变化记得同步 CHANGELOG（体检脚本会检查一致性）
- Windows 跑通后，把 flow/WINDOWS-TESTING.md 里的结果补进 README 的跨平台表格
