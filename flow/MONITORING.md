# 监控与验收：怎么看这个系统到底好不好

> 目标不是"脚本说成功"，而是每一层都有独立于自我声明的证据。
> 一条命令能跑完的，就不要靠肉眼盯。

## 一、日常：一条命令看全局

```bash
npm run health        # 服务、权限身份、小窗、宿主可见、点击穿透、锁屏、队列、失败、耗时
npm run health -- --deep   # 再加小窗效果 + 会话隔离的行为断言（项数以脚本为准），约 25 秒
```

看这几行就够判断"现在能不能用"：

| 行 | 含义 | 异常时怎么查 |
| --- | --- | --- |
| 后台服务自检 | launchd 身份下系统事件与 ocu 是否可用 | 缺辅助功能权限会给出修复路径；锁屏时 ocu 不可用属正常 |
| 小窗宿主可见 | 宿主窗口真的在屏幕上 | 最小化/切 Space 时会 false，小窗理应隐藏 |
| 画面 | `live` 有画面；`no-window` 空闲未绑定（正常）；`error` 才是问题 | 看 `thumbnail.error` 的人话原因 |
| 最近任务失败数 | 最近 30 条记录 | 失败会带任务名、退出码、时间 |
| 自动重试 | 临时性失败重跑的次数与救回数 | 频繁重试说明 Chrome/端口不稳 |
| 任务耗时 | 按任务聚合的成功率、平均、最慢 | 找出拖后腿的任务 |
| 24h 运行记录 | 真失败与环境跳过分开计 | 「已知环境失败」不算代码问题 |

## 二、改完代码：确认跑的是新代码

```bash
npm run restart:check     # 重启 daemon + 小窗，再验证健康
npm run service:status    # 看端口监听者 pid 与 launchd 受管 pid 是否一致（stray = 改动没生效）
npm run service:restart   # 只杀确认是本项目 daemon 的监听者，再让 launchd 拉起新实例
```

**日志/报告轮转**：长期跑会堆到几千个文件，用一条命令清（daemon 启动时也会自动跑一次）：

```bash
npm run prune              # 演练：只打印会删什么
npm run prune -- --apply   # 真删（日志留 7 天、报告留最近 200 个）
```

清理只动 `logs/` 和 `reports/` 里的文件；卸载服务时 `npm run service:uninstall` 会顺带清掉
控制面 token 和占着 7788/7789 的本项目游离进程。

**踩过的坑**：手工启过一个 daemon 占着 7789，launchd 每次拉起都 EADDRINUSE 崩溃重试，
于是"重启服务"一直无效、代码改了跑的还是几小时前的版本。现在：

- daemon 遇到端口占用会打印占用者 pid 并以退出码 78 结束（不再静默崩溃循环）
- `service:status` 直接报"监听者是谁 / launchd 在跑哪个 pid / 是否漂移"
- `service:restart` 只在命令行确认是本项目 `daemon.mjs` 时才杀，杀完用 `launchctl kickstart -k` 拉起并验证新 pid
- launchd plist 加了 `ThrottleInterval 10`，崩溃时不会把日志刷爆

进程活着不代表跑的是新代码——改成 ESM 那次就是这样漏掉的。

## 三、定期：一键巡检 + 留档

```bash
npm run monitor                  # 约 40 秒：健康 + 小窗回归 + 会话隔离 + 帧率 + 短跑 2 轮任务
MONITOR_FAST=1 npm run monitor    # 跳过回归，约 30 秒
```

输出一张结论表，同时在 `reports/monitor-<时间>.md` 留档。

过几天想知道有没有漂移，直接看趋势：

```bash
npm run trends          # 最近 10 次：帧率、单帧体积、任务成功数、内存变化、切走/切回耗时
TREND_LIMIT=30 npm run trends
```

## 四、专项指标

### 小窗只出现在召唤它的会话

```bash
npm run scope:check
```

断言：本会话可见、别的会话即使要求显示也藏、别的会话活动不影响本会话、切走 ≤1000ms 消失、切回 ≤1500ms 出现。逐项给出实测毫秒。

### 帧率与单帧成本

```bash
npm run fps:check                        # 收起态
FPS_CHECK_EXPANDED=1 npm run fps:check   # 放大态
```

fps:check 测的是**离屏推帧**这条路（CDP 主动推 `/frame`），参考值：收起态 12.7–12.8fps /
600px / 43KB 一帧 / 48ms 一帧；放大态 12.6fps / 1920px / 223KB / 57ms。
低于 10fps 或单帧明显变慢，先看系统负载。

**真实窗口回显是另一条路**（`screencapture -l`），实测约 6fps、单帧 150ms 左右，
窗口大小影响不大（抓的是窗口本身，再缩到目标宽度）。这是系统命令的固有开销，
不是代码问题；要更高帧率只能走离屏推帧。

### 长时间是否稳定

```bash
npm run soak                    # 默认 6 轮
SOAK_ROUNDS=20 npm run soak     # 更久
```

看三点：每轮是否都成功、单轮耗时是否越来越长、进程内存是否持续上涨（默认阈值 80MB 报警）。
默认交替跑 electron-demo 和 headless-demo，前者验证控制、后者会推帧，所以「有帧的采样」也能反映画面链路。

## 五、失败怎么归类（重要）

`core/run-classify.mjs` 是唯一一份规则，健康面板、端到端验收、巡检都复用它：

- **环境跳过**：用户正在使用目标应用、没开指定页面、锁屏、缺辅助功能权限、页面改版。
  这类不算失败，报告里写明原因。
- **真实失败**：断言不成立、代码抛错、外部事实不符。这才需要修。

自动重试（`core/retry-policy.mjs`）只对「外部暂时不可用」生效：Chrome 启动慢、调试端口没起来、
连接被拒、任务被超时杀掉；环境类失败绝不重试，避免打扰用户。

## 六、端到端验收

```bash
npm run accept     # 需要本机服务在跑，输出 reports/acceptance-*.md
```

会跑：overlay 在线、小窗显隐、boss-scan、multi-app、form-fill、platform-demo、browser-demo、electron-demo。
环境不具备时记 SKIP 并写原因。

## 七、锁屏时哪些指标不能信

锁屏后系统不让访问窗口服务，这些会失真，不要当成回归：

- 抓帧只能是壁纸，`fps`/`frameBytes` 无意义
- ocu 直接报 `NSPOSIXErrorDomain Code=2`（健康面板会标"锁屏期间不可用"）
- Chrome 启动从 ~1s 变 18–120s，压测会超时
- 前台应用恒为 `com.apple.loginwindow`，小窗按设计隐藏

解锁后跑一次 `npm run monitor` 即可恢复正常口径。
