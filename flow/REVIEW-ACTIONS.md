# 评审待办（外部检查者维护）

> 只列**还没做**的。已修好的沉到底部，不复述。
> 详细理由见 [`REVIEW-2026-11-07.md`](REVIEW-2026-11-07.md)，发布流程见 [`PUBLISH-CHECKLIST.md`](PUBLISH-CHECKLIST.md)。
> 更新：2026-11-08 17:00（**P1 全部由主会话自行实现并有测试**；`patch-p1.diff`、`patch-classify.diff` 已删除——两处实现都已落地，补丁再 apply 会失败。单测 400+）
>
> 旧记录：2026-11-08 15:00（`flow/patch-p1.diff` = **232 行 / 7 个文件**，新增 `core/runner.mjs`：日志写入从 `void fd.write()` 改为同步写，避免退出时末行丢失。**`docs/REVIEW.md` 那份 18 条旧审查，现在全部要么已验证修复、要么已进补丁。**）
  ① `node core/cli.mjs foo` → 退出码 2，用法输出到 stderr
  ② 死进程旧锁 → 抢锁成功且内容改写成本进程；活进程旧锁 → 拒绝抢
  ③ `cli stop` 在 launchd 托管下 → 打印暂停/卸载/重启指引，**daemon 未被杀**（7789 仍 200）
  ④ `start-all` 在 daemon+overlay 都在跑时 → 打印「小窗已在运行，跳过」，不产生第二个窗口
  ⑤ daemon 未捕获异常处理：仅静态确认（难以在测试里稳定注入）

## 当前有效补丁（可直接 `git apply`）

```
flow/patch-publish.diff              发布配置（包名/bin/files/repository/publishConfig/CI/徽章）
flow/patch-electron-task-test.diff   5 条 electron-task 单测
flow/patch-ensure-app-window-test.diff  6 条 ensureAppWindow 单测
flow/patch-deploy-freshness.diff     代码新鲜度检查（service:status 能报「跑的是旧代码」）
```

其余补丁已作废删除（对应实现已在代码里）。

## P0 · 公开前必须处理（4 条）

### 0.5（**已更正，不是 bug**）`form-fill` 断言失败会被归成环境跳过——但这是有意的

- 上一轮我把它报成 P0 假绿，**这轮核了测试后收回**：`test/run-classify.test.mjs` 的「常见环境原因都能识别」用例里明确写了
  `['  FAIL  改成了指定关键词', '目标页面结构已变']` —— 说明「填不进去」被当成「站点结构变了」是设计意图
- 但这条设计仍有一个真实风险值得讨论：**它无法区分「站点改版」和「我们自己的填表逻辑回归」**。两种情况下断言都失败，都会被判成环境跳过 → 真回归可以躲过验收
- 建议（不阻塞发布）：任务在断言失败时再取一个环境证据——比如检查目标标签页的 URL/标题是否还在预期站点；还在，就别报「环境跳过」，而是按真失败处理。或者干脆让任务显式打印「环境跳过：页面结构变了」，而不是靠断言名反推
义