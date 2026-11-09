# docs/assets

README 首屏的 demo 动图放这里。

## 现状

`demo.gif` 已录制（2026-11-09）：headless Chrome 在后台打开示例页面，小窗实时回显代理看到的画面。
素材来自 `node core/cli.mjs run headless-demo` 实跑，只截小窗窗口本身（`screencapture -l <windowId>`），
不录整屏、不含其它应用内容；480×304、20 帧、约 0.6 MB，README 首屏已引用。

换素材时把新文件放回同一路径即可，无需改 README。

## 怎么重录（macOS）

1. **清场**：只留小窗（`POST /visible {visible:true,pinned:true}`），避免把 DSH 聊天内容录进去。
2. **别录整屏**：用 `screencapture -l <小窗 windowId> -o <frame-N.png>` 按窗口抓帧，连拍 8–12 秒；
   同时跑一个真实任务（如 `node core/cli.mjs run headless-demo`）让小窗有画面和状态变化。
3. **转 GIF**（Pillow 或 ffmpeg 都行）：

   ```bash
   # ffmpeg 版（有 ffmpeg 时）
   ffmpeg -i demo.mov -vf "fps=12,scale=1000:-1:flags=lanczos" -loop 0 demo.gif
   ```

   目标参数：宽度 480–1000px、8–12fps、**单文件 ≤ 2MB**（仓库体检会拦超过 2MB 的文件）。
4. **去隐私**：不要出现账号名、聊天内容、真实姓名、本机绝对路径、token；只截小窗窗口能避开大部分。
5. 放好文件后提交 `docs/assets/demo.gif`；README 不用改。

## 怎么录（macOS）

1. **清场**：只留要演示的应用窗口和小窗，关掉无关窗口、通知与聊天列表（开专注模式）。
2. **录屏**：系统自带 `Shift + Command + 5` → 录制所选部分。建议录 1280×720 左右区域。
3. **内容**（6–10 秒，一镜到底，突出两件事）：
   - 小窗里能看到它在操作真实应用（动作可辨认）；
   - 你自己的窗口始终是前台（鼠标不动、不切屏）。
   推荐动作：`npm run demo:concurrent`（并发验证）或 `npm run run browser-demo`。
4. **转 GIF**（装了 ffmpeg 的话）：

   ```bash
   ffmpeg -i demo.mov -vf "fps=12,scale=1000:-1:flags=lanczos" -loop 0 demo.gif
   ```

   目标参数：宽度 900–1200px、10–12fps、**单文件 ≤ 2MB**（仓库体检会拦超过 2MB 的文件）。
5. **去隐私**：不要出现账号名、聊天内容、真实姓名、本机绝对路径、token。
6. 放好文件后按上面替换 README 那一段，并提交 `docs/assets/demo.gif`。
