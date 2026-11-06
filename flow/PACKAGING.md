# 打包成单机 App

> 目标：装一个 App，就拥有完整的后台电脑控制能力，不需要用户另外装 Node、装 ocu。

## 一、产物

```bash
node scripts/bundle-ocu.mjs --with-binary   # 把 ocu 运行时（37MB）放进 third_party
cd overlay && npx electron-builder --mac dir --config electron-builder.yml
```

输出：`dist-app/mac-arm64/Desktop Agent.app`，约 300MB（Electron 250MB + ocu 37MB）。

打 dmg 把 `--mac dir` 换成 `--mac dmg`。

## 二、App 里装了什么

```
Desktop Agent.app/Contents/Resources/
  app.asar            ← 小窗界面（overlay）
  core/               ← daemon、任务、平台层
  third_party/open-computer-use/{bin,dist,scripts}  ← ocu 运行时
  third_party/open-computer-use/LICENSE             ← 合规署名
```

启动流程：Electron 起来 → `supervisor.js` 用 App 自带的 Node 拉起 `core/daemon.mjs` → 再初始化小窗。退出时连带停掉 daemon。

## 三、随包 ocu 怎么被找到

`core/platform.mjs` 的查找顺序：

1. `OCU_BIN` 环境变量
2. **随包路径 `third_party/open-computer-use/bin/ocu`**
3. 用户自己装的 `~/.local/bin/ocu`
4. PATH 里的 `ocu`

随包 ocu 是带 shebang 的 Node 脚本，打包后没有全局 node，所以 `core/ocu-mcp.mjs` 会改用 App 自带的 Node 运行时（`ELECTRON_RUN_AS_NODE=1`）来执行它。

## 四、已验证

把全局 ocu 移走后启动打包 App，实测：

```
随包 ocu 版本 1.1.3
ELECTRON_RUN_AS_NODE=1 "Desktop Agent" .../third_party/open-computer-use/bin/ocu --version  →  1.1.3
小窗服务 7788 就绪，daemon 7789 就绪，14 个任务加载
```

也就是说**删掉全局 ocu 之后，App 仍然完整可用**。

## 五、已知限制

| 项 | 现状 |
| --- | --- |
| 代码签名 | 没有开发者证书，用 `identity: null` 跳过签名；本机：`xattr -cr` 后可直接运行 |
| 公证 | 无，拷到别的 Mac 上需要用「右键 → 打开」或临时关闭 Gatekeeper |
| Windows | 未打包；`dist/windows` 里有 ocu 运行时，但 Electron 打包配置还没写 |
| 图标 | 用默认 Electron 图标，`overlay/build/icon.icns` 放一个即可替换 |

## 六、跨 Mac 分发：现在的真实门槛

未签名 + 未公证的 App，别的 Mac 上第一次打开会被 Gatekeeper 拦。用户能做但很别扭的绕法：

```bash
xattr -cr "/Applications/Desktop Agent.app"     # 清隔离属性，之后能正常打开
```

或者右键 → 打开 → 仍要打开；或去「系统设置 → 隐私与安全性 → 仍要打开」。

**要做到「双击即装、装了就用」**，需要：

| 项 | 成本 |
| --- | --- |
| Apple Developer Program（Developer ID） | 99 美元/年 |
| codesign 签名 + notarytool 公证 + staple | 约半天接线 |
| 每次发布重复公证 | 每次 5–15 分钟 |

另外，**无论是否签名，首次运行都要手动授权**：辅助功能、屏幕录制。这两项由 macOS 强制，无法绕过。能优化的是引导：检测到缺失就打开对应设置面板，授权后自动重检（`core/permissions.mjs` 已实现这两件事）。

## 七、Windows 需要做什么

打包配置已写好（`win: nsis`），但**完全没有实机验证**。要跑通需要：

1. 一台 Windows 10/11，`npm install` 后 `npx electron-builder --win --config electron-builder.yml`
2. 验证随包 ocu 的 Windows 运行时（`third_party/open-computer-use/dist/windows`）能被找到
3. 逐项验证：小窗抓图（PrintWindow + HWND）、UIA 点击、PostMessage 输入、schtasks 自启
4. 处理 UAC 与「必须登录桌面会话」的限制

预计 2–3 天，其中一半时间在调 Win32 细节。没机器做不了。

## 八、正式发布前要补

1. Apple Developer ID 证书 + notarization（否则用户第一次打开会被拦）
2. 图标与启动画面
3. 首次运行引导：申请辅助功能与屏幕录制权限（可直接复用 `ocu doctor`）
4. Windows 打包（NSIS）+ 对应的 UIA 验证