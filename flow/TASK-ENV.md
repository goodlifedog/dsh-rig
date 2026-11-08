# 环境变量清单

> 由 `npm run env:doc` 扫代码生成（`process.env.*` 的全部用法），不要手改。
> 只列本项目自己的变量；系统变量（PATH/HOME/TMPDIR 等）不列。默认值来自代码里的字面量，取不到就留空。

| 变量 | 代码里的默认值 | 出现位置 |
| --- | --- | --- |
| `ACCEPT_ABORT_IDLE_SEC` | 30 | `core/acceptance.mjs` |
| `ACCEPT_FORCE` | （开关，设 1 开启） | `core/acceptance.mjs` |
| `AGENTD_MAX_QUEUE` | 50 | `core/daemon.mjs` |
| `AGENTD_MAX_RETRIES` | （开关，设 1 开启） | `core/daemon.mjs` |
| `AGENTD_PORT` | 7789 | `core/cli.mjs`<br>`core/daemon.mjs`<br>`core/ports.mjs`<br>`core/service.mjs`<br>`overlay/main.js` |
| `AGENTD_TASKS_DIR` | — | `core/daemon.mjs` |
| `AGENTD_URL` | — | `core/ports.mjs`<br>`overlay/main.js` |
| `AGENT_ALLOW_QUERY_TOKEN` | （开关，设 1 开启） | `core/daemon.mjs`<br>`overlay/server.js` |
| `AGENT_APP` | ChatGPT | `core/tasks/drive-agent.mjs` |
| `AGENT_CHROME_PROFILE` | — | `core/browser.mjs`<br>`core/tasks/boss-scan-dedicated.mjs`<br>`core/tasks/greet-verify.mjs` |
| `AGENT_DRIVE_ALLOW_FRONT_RISK` | （开关，设 1 开启） | `core/tasks/drive-agent-cli.mjs`<br>`core/tasks/drive-agent.mjs` |
| `AGENT_FAKE_LOCKED` | （开关，设 1 开启） | `core/platform.mjs` |
| `AGENT_FRONT_RISK` | — | `core/background.mjs`<br>`core/tasks/app-matrix.mjs`<br>`scripts/app-resolve.mjs` |
| `AGENT_KEEP_MS` | 8000 | `core/tasks/drive-agent-cli.mjs`<br>`core/tasks/drive-agent.mjs` |
| `AGENT_LAUNCH_HIDDEN` | — | `core/tasks/background-stability.mjs` |
| `AGENT_PROMPT` | 只回复两个字：收到 | `core/tasks/drive-agent.mjs` |
| `AGENT_SESSION` | — | `core/agentd.mjs` |
| `ALLOW_CAMPUS` | — | `core/tasks/boss-candidates.mjs` |
| `ALLOW_INTERN` | — | `core/tasks/boss-candidates.mjs` |
| `APP_INVENTORY_RUNTIME` | 0 | `scripts/app-inventory.mjs` |
| `BG_KEEP_MS` | 10000 / 6000 | `core/tasks/background-control.mjs`<br>`core/tasks/browser-background.mjs` |
| `BG_KEEP_NOTE` | （开关，设 1 开启） | `core/tasks/background-control.mjs` |
| `BG_VERIFY_TIMEOUT_MS` | — | `scripts/bg-verify.mjs` |
| `CDP_PORT` | 9333 | `core/cdp.mjs` |
| `CHROME_APP` | Google Chrome | `core/user-chrome.mjs` |
| `CHROME_BIN` | /Applications/Google Chrome.app/Contents/MacOS/Google Chrome | `core/browser.mjs` |
| `CLICK_TEXT` | — | `core/tasks/user-chrome-demo.mjs` |
| `CLI_CMD` | — | `core/tasks/drive-agent-cli.mjs` |
| `CLI_PROMPT` | 只回复两个字：收到 | `core/tasks/drive-agent-cli.mjs` |
| `CLI_TERM_APP` | Ghostty | `core/tasks/drive-agent-cli.mjs` |
| `CLI_TIMEOUT_MS` | — | `core/tasks/drive-agent-cli.mjs` |
| `CONCURRENT_BROWSER` | — | `core/tasks/concurrent-demo.mjs` |
| `CONCURRENT_HOLD_MS` | 5000 | `core/tasks/concurrent-demo.mjs` |
| `CONCURRENT_PROFILE` | — | `core/tasks/concurrent-demo.mjs` |
| `COVERAGE_JSON` | /tmp/coverage-latest.json | `core/tasks/coverage-probe.mjs` |
| `COVERAGE_NODES` | 6000 | `core/tasks/coverage-probe.mjs` |
| `COVERAGE_RAW_DIR` | /tmp/coverage-raw | `core/tasks/coverage-probe.mjs` |
| `DIALOG_GUARD_APPS` | — | `core/dialog-guard.mjs` |
| `DSH_MCP_DEBUG` | — | `core/ocu-mcp.mjs` |
| `DSH_SUPERVISOR_DEBUG` | — | `overlay/supervisor.js` |
| `ELECTRON_BIN` | — | `core/electron-task.mjs` |
| `EXCLUDE_COMPANIES` | 外包,人力,派遣,猎头 | `core/tasks/boss-candidates.mjs` |
| `FILL_JS_TIMEOUT_MS` | 90000 | `core/tasks/form-fill-local.mjs`<br>`core/tasks/form-fill.mjs` |
| `FILL_KEYWORD` | Java开发工程师 | `core/tasks/form-fill.mjs` |
| `FORM_HOST_APP` | /tmp/OCUFormHost.app | `core/tasks/form-fill-local.mjs` |
| `FORM_HOST_ELECTRON` | — | `core/tasks/form-fill-local.mjs` |
| `FORM_HTML_PATH` | — | `core/tasks/form-fill-local.mjs` |
| `FPS_CHECK_EXPANDED` | （开关，设 1 开启） | `scripts/fps-check.mjs` |
| `FPS_CHECK_SECONDS` | — | `scripts/fps-check.mjs` |
| `FPS_CHECK_TARGET` | — | `scripts/fps-check.mjs` |
| `FRONT_GUARD` | — | `core/daemon.mjs` |
| `GREET_CARDS` | — | `core/tasks/greet-inner.mjs` |
| `GREET_DRY` | — | `core/tasks/greet-inner.mjs` |
| `GREET_LIMIT` | 2 | `core/tasks/boss-greet.mjs`<br>`core/tasks/greet-inner.mjs` |
| `GREET_SKIP` | — | `core/tasks/greet-inner.mjs` |
| `HEADLESS_PROFILE` | — | `core/tasks/headless-demo.mjs` |
| `KEEP_DAYS` | 7 | `scripts/prune.mjs` |
| `KEEP_REPORTS` | 200 | `scripts/prune.mjs` |
| `KEYWORDS` | Java,Agent,AI,后端,全栈,大模型,工作流 | `core/tasks/boss-candidates.mjs` |
| `LIVE_ABORT_IDLE_SEC` | 20 | `scripts/live-verify.mjs` |
| `LIVE_FORCE` | （开关，设 1 开启） | `scripts/live-verify.mjs` |
| `LIVE_KEEP_AWAKE` | （开关，设 1 开启） | `scripts/live-verify.mjs` |
| `LIVE_MIN_IDLE_SEC` | 900 | `scripts/live-verify.mjs` |
| `MATRIX_APPS_JSON` | — | `core/tasks/app-matrix.mjs` |
| `MATRIX_DISMISS` | — | `core/tasks/app-matrix.mjs` |
| `MATRIX_PRESET` | — | `core/tasks/app-matrix.mjs` |
| `MATRIX_QUIT` | — | `core/tasks/app-matrix.mjs` |
| `MAX_JOB_LOGS` | 50 | `core/tasks/boss-scan.mjs` |
| `MIN_JOBS` | 10 | `core/tasks/boss-scan.mjs` |
| `MONITOR_FAST` | （开关，设 1 开启） | `scripts/monitor.mjs` |
| `MONITOR_FPS_SECONDS` | 12 | `scripts/monitor.mjs` |
| `NOTES_CLEANUP_FORCE` | （开关，设 1 开启） | `scripts/cleanup-test-data.mjs` |
| `OCU_BIN` | — | `core/daemon.mjs`<br>`core/platform.mjs`<br>`core/tasks/headless-demo.mjs`<br>`core/tasks/platform-demo.mjs` |
| `OPEN_COMPUTER_USE_VISUAL_CURSOR` | — | `core/tasks/headless-demo.mjs` |
| `OVERLAY_ATTACH_DSH` | — | `overlay/main.js` |
| `OVERLAY_ATTACH_FAST_MS` | — | `overlay/main.js` |
| `OVERLAY_ATTACH_MID_MS` | — | `overlay/main.js` |
| `OVERLAY_ATTACH_SLOW_MS` | — | `overlay/main.js` |
| `OVERLAY_BLANK_JPEG_BYTES` | — | `overlay/main.js` |
| `OVERLAY_CAPTURE_FAIL_TOLERANCE` | — | `overlay/main.js` |
| `OVERLAY_CAPTURE_WHILE_HIDDEN` | — | `overlay/main.js` |
| `OVERLAY_DSH_PROCESS` | DeepSeek Harness | `overlay/main.js` |
| `OVERLAY_FPS` | — | `overlay/main.js` |
| `OVERLAY_HEIGHT` | — | `overlay/main.js` |
| `OVERLAY_HOST` | 127.0.0.1 | `overlay/main.js` |
| `OVERLAY_HOST_BUNDLES` | com.deepseek.dsh | `overlay/main.js` |
| `OVERLAY_HOST_PROCESS` | — | `overlay/main.js` |
| `OVERLAY_HOST_TITLE_SUFFIX` | DeepSeek Harness | `overlay/main.js` |
| `OVERLAY_IDLE_HIDE_MS` | — | `overlay/main.js` |
| `OVERLAY_MARGIN` | — | `overlay/main.js` |
| `OVERLAY_MAX_SESSIONS` | — | `overlay/main.js` |
| `OVERLAY_PORT` | — | `core/ports.mjs`<br>`overlay/main.js` |
| `OVERLAY_SESSION_RECENT_MS` | 60 | `overlay/main.js` |
| `OVERLAY_SESSION_TTL_MS` | — | `overlay/main.js` |
| `OVERLAY_SHOW_DOCK` | （开关，设 1 开启） | `overlay/main.js` |
| `OVERLAY_URL` | — | `core/ports.mjs` |
| `OVERLAY_WIDTH` | — | `overlay/main.js` |
| `PARALLEL_KEEP_MS` | 8000 | `core/tasks/parallel-real-demo.mjs` |
| `PRUNE_ON_START` | — | `core/daemon.mjs` |
| `SALARY_MAX` | 12 | `core/tasks/boss-candidates.mjs` |
| `SALARY_MIN` | 5 | `core/tasks/boss-candidates.mjs` |
| `SCAN_ALLOW_TAB_SWITCH` | （开关，设 1 开启） | `core/tasks/boss-scan.mjs` |
| `SCAN_JS_TIMEOUT_MS` | 90000 | `core/tasks/boss-scan.mjs` |
| `SCAN_KEYWORD` | AI Agent | `core/tasks/boss-scan-dedicated.mjs` |
| `SCAN_LIMIT` | 30 | `core/tasks/boss-scan-dedicated.mjs` |
| `SOAK_ROUNDS` | — | `scripts/soak.mjs` |
| `SOAK_TASKS` | electron-demo,headless-demo | `scripts/soak.mjs` |
| `STABLE_ROUNDS` | — | `core/tasks/background-stability.mjs` |
| `TARGETS` | Finder,Calculator | `core/tasks/multi-app.mjs` |
| `TARGET_APP` | Google Chrome / notepad | `core/tasks/boss-greet.mjs`<br>`core/tasks/boss-scan.mjs`<br>`core/tasks/form-fill.mjs`<br>`core/tasks/greet-inner.mjs`<br>`core/tasks/mcp-demo.mjs`<br>`core/tasks/platform-demo.mjs`<br>`scripts/bench-ocu.mjs` |
| `TERM_APP` | Ghostty | `core/tasks/terminal-control.mjs` |
| `TREND_LIMIT` | — | `scripts/trends.mjs` |
| `USER_ACTIVE_ACTIONS` | — | `core/tasks/user-active-demo.mjs` |
