# 外部监控日志（评审侧维护，执行侧按需读取）

> 更新：2026-11-08 23:13

## 一、最新核验（逐条实跑）

| 项 | 结果 |
| --- | --- |
| `npm test` | 1223 项 / 0 失败 ✅ |
| `repo:check` / `verify` | 全部通过 ✅ |
| 发布链路 | `npm pack` 137 文件/518KB，含 ocu 许可；全局安装后 CLI 可用、ocu 随依赖装好 ✅ |
| `adapter-demo` 守卫链 | 锁屏跳过 / 用户活跃让路 / front-risk 不可被 --allow-launch 绕过 / 只关自己拉起的应用 / 点击无变化判失败 ✅ |

## 二、必改：`adapter-demo --type-text` 写入后不还原（数据安全）

现状：找输入区 → `set_value` 写入 → 读回校验 → 结束。**全文件没有读原值/恢复逻辑。**

后果：拿它测 TextEdit 这类有用户内容的应用，测试文本会留在用户文档里；测试只用临时 fixture，所以跑测试发现不了。

修法（建议第 2 条）：
1. 写前读原值，写后恢复，异常路径也恢复（与 form-fill 的 restore-after-error 同款）
2. **只写「空且未命名」的目标**（复用 text-edit-guard 判定），有内容就跳过并写明原因
3. 或要求显式 `--allow-write` 才执行写入

## 三、待验证（需要用户离开的窗口：键鼠空闲 ≥180s 且未锁屏）

1. `node core/tasks/adapter-demo.mjs --app Antigravity --file examples/adapters/sample.html`（真 Electron，先只读）
2. 再试 `--click-text`；最后才试 `--type-text`（修完还原后再试）
3. 每条都要留下：命令、真实输出、前台是否变化

## 四、仍未修的分类器 bug

`core/app-runtime.mjs`：`if (electron || info.hasAsar) return { type: 'electron' }`
→ ChatGPT 有 app.asar 但框架是 Codex+Sparkle，被判成 Electron。asar 只能算「疑似」，必须有 Electron Framework 或 Electron Helper 才算。
