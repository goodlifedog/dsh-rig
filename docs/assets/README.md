# docs/assets

README 首屏的 demo 动图放这里。

## 现状

`demo.gif` 还没录，README 首屏目前用文字占位。录好后把文件放到：

    docs/assets/demo.gif

只要文件就位，把 README 首屏里那段 `> **Demo（GIF 占位）** …` 的引用块换成下面这一行即可：

```markdown
![DSH Rig：后台操作真实应用，前台始终是你的窗口](docs/assets/demo.gif)
```

（只有这一行需要粘贴；本文件不受仓库体检的图片存在性检查约束，可以先放着。）

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
