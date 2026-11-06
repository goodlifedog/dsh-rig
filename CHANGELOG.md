# Changelog

## 0.5.0 (2026-11-06)

- 平台层：`overlay/platform.js`、`core/platform.mjs`，把 macOS 专属调用收敛为统一接口
- Windows 控制后端：`tools/uia-bridge.ps1` + `core/backends/uia.mjs`（UI Automation，未实机验证）
- Windows 抓图：`POST /window` 支持标题，按 MainWindowTitle 反查 HWND
- 服务管理：`core/service.mjs`，macOS 用 launchd、Windows 用 schtasks，支持 install/uninstall
- 环境自检：`npm run doctor`（控制后端、可执行文件、数据目录、两个服务）
- 验收：真失败与环境跳过分离，输出 6/6 通过 + 2 跳过
- 测试：`core/lib/salary.mjs`、`core/lib/score.mjs` 抽出为纯函数，11 个用例 + 三平台 CI

## 0.4.0 (2026-11-06)

- 小窗重写：多会话隔离、会话标题门控、点击穿透、1px 黑边、按画面比例放大
- 缩略图：分辨率随窗口宽度 ×2、质量 88、约 7fps
- 投递任务：改为「发一条、用消息列表验一条」，状态分 delivered/skipped/failed 桶
- 根因修正：弹窗「已发送」不是送达回执，之前 8 条误报

## 0.3.0 (2026-11-05)

- 小窗首次可用：贴 DSH 右上角、空闲自隐、虚拟光标、外部推帧
- daemon 常驻 + 串行任务队列 + 端到端验收

## 0.1.0 (2026-11-04)

- ocu 封装、离屏 Chrome、CDP 客户端、拟人鼠标轨迹
