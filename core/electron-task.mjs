'use strict';

/**
 * Electron 任务层封装：把「带 CDP 调试端口的 Electron 实例」变成任务能直接用的能力。
 *
 * 底层协议在 core/cdp.mjs（零依赖，RFC6455 自己实现）；本文件只管：
 *   1. 启动带 --remote-debugging-port 的 Electron 进程（默认随机端口 + 独立 user-data-dir）；
 *   2. 从 user-data-dir 的 DevToolsActivePort 文件里读出真实端口；
 *   3. 等目标页面就绪，连上 CDP；
 *   4. 给任务暴露 title / evaluate / inspect / click / insertText / setValue / screenshot；
 *   5. 进程与临时目录的生命周期（close 时统一回收）。
 *
 * 设计约束（跟 core/agentd.mjs 保持一致）：
 *   - 失败给明确中文错误，带上可操作的信息（路径、stderr 尾巴、当前 targets）；
 *   - 不引入第三方依赖；
 *   - 本机有 ELECTRON_RUN_AS_NODE=1，spawn 前必须删掉，否则 Electron 会以 node 模式启动、没有窗口。
 *
 * 典型用法：
 *   import { launch, writeOffscreenHost } from './electron-task.mjs';
 *   const host = await launch({ entry: 'host.js' });        // 带调试端口启动
 *   const page = await host.connect({ target: 'Demo' });    // 连上页面
 *   console.log(await page.title());                        // document.title
 *   await page.click('#ok');                                // Input 真实点击
 *   await page.insertText('hello');                         // 真实键盘输入
 *   await page.close();                                     // 断开 CDP
 *   await host.close();                                     // 杀进程 + 清理临时目录
 *
 * 对已经在跑的第三方 Electron 应用（例如带端口重启的 ChatGPT），用 attach：
 *   const page = await attach({ port: 9444, target: 'ChatGPT' });
 */

import { execFile, spawn } from 'node:child_process';
import { readFrontmostApp } from './platform.mjs';
import { attachSpawnError } from './safety.mjs';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CDP, getVersion, listTargets } from './cdp.mjs';

const CORE_DIR = path.dirname(fileURLToPath(import.meta.url));
// overlay 自带一份 Electron 二进制，先复用它；也可以用 ELECTRON_BIN 覆盖。
const BUNDLED_ELECTRON = path.join(
  CORE_DIR, '..', 'overlay', 'node_modules', 'electron', 'dist',
  'Electron.app', 'Contents', 'MacOS', 'Electron'
);
const LOG_TAIL_BYTES = 8000;
const DEFAULT_TIMEOUT_MS = 30000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 找 Electron 可执行文件。优先级：显式参数 > 环境变量 ELECTRON_BIN > overlay 自带。
 * 找不到时抛错并说明怎么办。
 */
export function resolveElectronBinary(explicit) {
  const candidates = [
    explicit,
    process.env.ELECTRON_BIN,
    BUNDLED_ELECTRON,
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  throw new Error(
    '找不到 Electron 可执行文件。已尝试：\n  ' + candidates.join('\n  ') +
    '\n可以显式传 binary，或设置环境变量 ELECTRON_BIN，' +
    '或在 desktop-agent/overlay 下执行 npm install 装 Electron。'
  );
}

/**
 * 读 user-data-dir 里的 DevToolsActivePort（Chromium 在 --remote-debugging-port=0 时写它）。
 * 文件格式：第一行端口，第二行浏览器 WebSocket 路径。
 * 文件不存在 / 还没写完时返回 null，不抛错（调用方轮询）。
 */
export function readDevToolsActivePort(userDataDir) {
  const file = path.join(userDataDir, 'DevToolsActivePort');
  try {
    const text = fs.readFileSync(file, 'utf8');
    const lines = text.split('\n');
    const port = Number((lines[0] || '').trim());
    if (!Number.isInteger(port) || port <= 0) return null;
    return {
      port: port,
      browserPath: (lines[1] || '').trim(),
      file: file,
    };
  } catch {
    return null;
  }
}

/**
 * 轮询等 DevToolsActivePort 出现并写出端口。
 * Electron 起窗口需要几秒，这里默认等 30s；超时会把 stderr 一起带出来。
 */
export async function waitForDevToolsPort(userDataDir, options) {
  const opts = options || {};
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  const intervalMs = opts.intervalMs || 200;
  const checkExit = opts.checkExit || (() => null);

  const deadline = Date.now() + timeoutMs;
  let lastExit = null;
  while (Date.now() < deadline) {
    const info = readDevToolsActivePort(userDataDir);
    if (info) return info;

    lastExit = checkExit();
    if (lastExit) {
      throw new Error(
        'Electron 进程在写出调试端口前就退出了（退出码 ' + lastExit.code +
        (lastExit.signal ? '，信号 ' + lastExit.signal : '') + '）。\n' +
        '常见原因：ELECTRON_RUN_AS_NODE 没删掉、入口 JS 有语法错误、或者 Electron 把参数交给了别的实例。\n' +
        (opts.describe ? opts.describe() : '')
      );
    }
    await sleep(intervalMs);
  }

  throw new Error(
    '等待 DevToolsActivePort 超时（' + timeoutMs + 'ms）：' + path.join(userDataDir, 'DevToolsActivePort') + '\n' +
    '常见原因：Electron 没起来、用了固定端口（不会写该文件）、或 user-data-dir 被别的实例占用。\n' +
    (opts.describe ? opts.describe() : '')
  );
}

/** 等固定端口的 HTTP 接口可用（--remote-debugging-port=固定值 时用）。 */
export async function waitForDevToolsHttp(port, options) {
  const opts = options || {};
  const host = opts.host || '127.0.0.1';
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  const intervalMs = opts.intervalMs || 200;
  const deadline = Date.now() + timeoutMs;
  let lastError = null;

  while (Date.now() < deadline) {
    try {
      return await getVersion({ host: host, port: port });
    } catch (error) {
      lastError = error;
    }
    const exit = opts.checkExit ? opts.checkExit() : null;
    if (exit) {
      throw new Error(
        'Electron 进程在调试端口就绪前退出（退出码 ' + exit.code + '）。\n' +
        (opts.describe ? opts.describe() : '')
      );
    }
    await sleep(intervalMs);
  }

  throw new Error(
    '等待 CDP HTTP 接口超时（' + timeoutMs + 'ms，http://' + host + ':' + port + '/json/version）：' +
    String(lastError && lastError.message) + '\n' +
    (opts.describe ? opts.describe() : '')
  );
}

function targetMatches(target, matcher) {
  if (!matcher) return target.type === 'page';
  const test = (value) => {
    if (value == null) return false;
    if (matcher instanceof RegExp) return matcher.test(value);
    return String(value).includes(String(matcher));
  };
  return test(target.id) || test(target.title) || test(target.url);
}

function describeTargets(targets) {
  if (!targets.length) return '当前没有任何 target';
  return '当前 targets：\n  ' + targets
    .map((t) => JSON.stringify({ type: t.type, title: t.title, url: t.url }))
    .join('\n  ');
}

/**
 * 等某个页面 target 出现并连上 CDP。
 * 页面可能还在导航（target 刚建出来就换 document），所以 attach 失败会重试。
 */
export async function waitForTarget(port, options) {
  const opts = options || {};
  const host = opts.host || '127.0.0.1';
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  const intervalMs = opts.intervalMs || 250;

  const deadline = Date.now() + timeoutMs;
  let lastTargets = [];
  let lastError = null;

  while (Date.now() < deadline) {
    try {
      lastTargets = await listTargets({ host: host, port: port });
    } catch (error) {
      lastError = error;
      await sleep(intervalMs);
      continue;
    }

    const hit = lastTargets.find((t) => targetMatches(t, opts.target));
    if (hit) {
      try {
        return await CDP.attach({ host: host, port: port, target: hit.id, timeout: 5000 });
      } catch (error) {
        lastError = error;
      }
    }
    await sleep(intervalMs);
  }

  throw new Error(
    '等待 CDP 页面 target 超时（' + timeoutMs + 'ms）：' + String(lastError && lastError.message) +
    '\n' + describeTargets(lastTargets)
  );
}

/**
 * 生成「离屏宿主窗口」的 Electron 主进程脚本。
 * accessory（不进 Dock / 不参与 Cmd+Tab）+ 透明 + 屏幕外坐标 + showInactive：
 * 页面正常渲染、能收 CDP 输入，但用户看不到，也不会抢前台。
 */
export function offscreenHostSource(options) {
  const opts = options || {};
  const width = opts.width || 480;
  const height = opts.height || 360;
  const htmlPath = opts.htmlPath;
  if (!htmlPath) throw new Error('offscreenHostSource 需要 htmlPath');

  return [
    "'use strict';",
    '',
    '// 由 electron-task.mjs 生成：离屏透明宿主窗口，不抢前台。',
    "const { app, BrowserWindow } = require('electron');",
    '',
    "if (typeof app.setActivationPolicy === 'function') app.setActivationPolicy('accessory');",
    "if (app.dock && typeof app.dock.hide === 'function') app.dock.hide();",
    '',
    'app.whenReady().then(() => {',
    '  const win = new BrowserWindow({',
    '    width: ' + Math.round(width) + ',',
    '    height: ' + Math.round(height) + ',',
    '    show: false,',
    '    frame: false,',
    '    opacity: 0,',
    '    x: -5000,',
    '    y: -5000,',
    '    skipTaskbar: true,',
    '    hasShadow: false,',
    "    backgroundColor: '#00000000',",
    '  });',
    '  win.loadFile(' + JSON.stringify(htmlPath) + ');',
    '  win.once("ready-to-show", () => win.showInactive());',
    '});',
    '',
    "app.on('window-all-closed', () => app.quit());",
    '',
  ].join('\n');
}

/**
 * 把离屏宿主脚本写到磁盘，返回 host.js 路径。
 * dir 省略时自动建一个临时目录（调用方负责清理）。
 */
export async function writeOffscreenHost(options) {
  const opts = options || {};
  if (!opts.htmlPath) throw new Error('writeOffscreenHost 需要 htmlPath');
  if (!fs.existsSync(opts.htmlPath)) throw new Error('HTML 不存在：' + opts.htmlPath);

  const dir = opts.dir || await fsp.mkdtemp(path.join(os.tmpdir(), 'electron-task-'));
  const hostPath = path.join(dir, opts.name || 'host.js');
  await fsp.writeFile(hostPath, offscreenHostSource(opts), 'utf8');
  return { dir: dir, hostPath: hostPath };
}

/** 读当前前台应用名（用来证明没抢焦点）。失败返回空串。 */
export function frontmostApp() {
  return readFrontmostApp();
}

function createLogBuffer() {
  const buffer = { stdout: '', stderr: '' };
  return {
    push(stream, chunk) {
      const text = String(chunk);
      buffer[stream] = (buffer[stream] + text).slice(-LOG_TAIL_BYTES);
    },
    describe() {
      const parts = [];
      if (buffer.stderr.trim()) parts.push('stderr 尾巴：\n' + buffer.stderr.trim().split('\n').slice(-15).join('\n'));
      if (buffer.stdout.trim()) parts.push('stdout 尾巴：\n' + buffer.stdout.trim().split('\n').slice(-10).join('\n'));
      return parts.join('\n');
    },
    raw() {
      return { stdout: buffer.stdout, stderr: buffer.stderr };
    },
  };
}

/**
 * 启动一个带调试端口的 Electron 实例。
 *
 * @param {object} options
 * @param {string} options.entry        Electron 主进程入口（.js 或 app 目录）
 * @param {string} [options.binary]     Electron 可执行文件（默认 overlay 自带的）
 * @param {number} [options.port=0]     0=随机端口（读 DevToolsActivePort）；也可以给固定端口
 * @param {string} [options.userDataDir] 复用已有目录；省略则建临时目录并在 close 时删掉
 * @param {string[]} [options.args]     额外参数（追加在调试参数之后）
 * @param {object} [options.env]        额外环境变量
 * @param {string} [options.cwd]        工作目录
 * @param {number} [options.timeoutMs]  等端口就绪的超时，默认 30s
 * @returns {Promise<object>} host：{ port, browserPath, pid, userDataDir, connect, close, log, exited }
 */
export async function launch(options) {
  const opts = options || {};
  if (!opts.entry) throw new Error('launch 需要 entry（Electron 主进程入口 JS 路径）');
  if (!fs.existsSync(opts.entry)) throw new Error('入口不存在：' + opts.entry);

  const binary = resolveElectronBinary(opts.binary);
  const ownsUserDataDir = !opts.userDataDir;
  const userDataDir = opts.userDataDir || await fsp.mkdtemp(path.join(os.tmpdir(), 'electron-task-'));
  const requestedPort = opts.port === undefined ? 0 : Number(opts.port);
  if (!Number.isInteger(requestedPort) || requestedPort < 0) {
    throw new Error('port 必须是非负整数（0 表示随机端口），收到：' + opts.port);
  }

  // 上一次运行残留的端口文件会让我们连到错误的端口，启动前先清掉。
  await fsp.rm(path.join(userDataDir, 'DevToolsActivePort'), { force: true }).catch(() => {});

  const args = [
    opts.entry,
    '--user-data-dir=' + userDataDir,
    '--remote-debugging-port=' + requestedPort,
  ].concat(opts.args || []);

  const env = Object.assign({}, process.env, opts.env || {});
  // 本机全局有 ELECTRON_RUN_AS_NODE=1：不删掉的话 Electron 会变成 node 跑，起不了窗口也没有调试端口。
  delete env.ELECTRON_RUN_AS_NODE;

  const child = spawn(binary, args, {
    cwd: opts.cwd,
    env: env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const log = createLogBuffer();
  if (child.stdout) child.stdout.on('data', (chunk) => log.push('stdout', chunk));
  if (child.stderr) child.stderr.on('data', (chunk) => log.push('stderr', chunk));

  let exitInfo = null;
  let resolveExit = () => {};
  const exited = new Promise((resolve) => {
    resolveExit = resolve;
    child.once('exit', (code, signal) => {
      exitInfo = { code: code, signal: signal };
      resolve(exitInfo);
    });
  });
  // spawn 失败不会有 'exit'：不接住会一直等到超时，且错误原因丢失。
  // 记进日志缓冲并把「退出」立即结算，让调用方拿到可读失败原因。
  attachSpawnError(child, (error) => {
    exitInfo = { code: null, signal: '', spawnError: String((error && error.message) || error) };
    log.push('spawn-error', exitInfo.spawnError);
    resolveExit(exitInfo);
  });
  const checkExit = () => exitInfo;

  let port = requestedPort;
  let browserPath = '';
  let info = null;

  try {
    if (requestedPort === 0) {
      info = await waitForDevToolsPort(userDataDir, {
        timeoutMs: opts.timeoutMs || DEFAULT_TIMEOUT_MS,
        checkExit: checkExit,
        describe: log.describe,
      });
      port = info.port;
      browserPath = info.browserPath;
    } else {
      const version = await waitForDevToolsHttp(requestedPort, {
        timeoutMs: opts.timeoutMs || DEFAULT_TIMEOUT_MS,
        checkExit: checkExit,
        describe: log.describe,
      });
      browserPath = version.webSocketDebuggerUrl || '';
    }

    // 端口有了还不够，HTTP 侧真的能应答才算就绪。
    await getVersion({ port: port });
  } catch (error) {
    try { child.kill('SIGKILL'); } catch {}
    if (ownsUserDataDir) await fsp.rm(userDataDir, { recursive: true, force: true }).catch(() => {});
    const message = error && error.message ? error.message : String(error);
    throw new Error(
      '启动 Electron 失败：' + message + '\n' +
      'binary: ' + binary + '\n入口: ' + opts.entry + '\nuser-data-dir: ' + userDataDir + '\n' +
      log.describe()
    );
  }

  const host = {
    binary: binary,
    entry: opts.entry,
    pid: child.pid,
    port: port,
    browserPath: browserPath,
    userDataDir: userDataDir,
    ownedUserDataDir: ownsUserDataDir,
    child: child,
    exited: exited,
    log: () => log.raw(),

    /** 连上某个页面 target（默认第一个 page）。 */
    connect(connectOptions) {
      const connectOpts = connectOptions || {};
      return waitForTarget(port, {
        target: connectOpts.target,
        timeoutMs: connectOpts.timeoutMs || DEFAULT_TIMEOUT_MS,
        host: connectOpts.host,
      }).then((cdp) => wrapSession(cdp, { port: port, host: connectOpts.host || '127.0.0.1' }));
    },

    /** 杀进程、等退出、清理临时目录。keepUserData=true 时保留 user-data-dir（排查用）。 */
    async close(closeOptions) {
      const closeOpts = closeOptions || {};
      if (child.exitCode === null && !exitInfo) {
        try { child.kill('SIGTERM'); } catch {}
        const timedOut = await Promise.race([
          exited.then(() => false),
          sleep(closeOpts.timeoutMs || 5000).then(() => true),
        ]);
        if (timedOut) {
          try { child.kill('SIGKILL'); } catch {}
          await Promise.race([exited, sleep(2000)]);
        }
      }
      if (ownsUserDataDir && !closeOpts.keepUserData) {
        await fsp.rm(userDataDir, { recursive: true, force: true }).catch(() => {});
      }
      return { pid: child.pid, userDataDir: userDataDir };
    },
  };

  return host;
}

/**
 * 连一个已经在跑的、带调试端口的 Electron 应用（不是本模块启动的）。
 * 例：attach({ port: 9444, target: 'ChatGPT' })。
 */
export async function attach(options) {
  const opts = options || {};
  const port = Number(opts.port);
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error('attach 需要 port（运行中应用的调试端口），收到：' + opts.port);
  }
  const cdp = await waitForTarget(port, {
    target: opts.target,
    timeoutMs: opts.timeoutMs || DEFAULT_TIMEOUT_MS,
    host: opts.host,
  });
  return wrapSession(cdp, { port: port, host: opts.host || '127.0.0.1' });
}

/**
 * 把 core/cdp.mjs 的 CDP 会话包成任务层对象：方法更少、报错更直白。
 */
function wrapSession(cdp, meta) {
  const context = meta || {};

  return {
    cdp: cdp,
    port: context.port,
    target: cdp.target,

    title() {
      return cdp.getTitle();
    },

    url() {
      return cdp.getUrl();
    },

    evaluate(expression, evaluateOptions) {
      return cdp.evaluate(expression, evaluateOptions);
    },

    inspect(maxText) {
      return cdp.inspectDom(maxText);
    },

    inspectSelector(selector) {
      return cdp.inspectSelector(selector);
    },

    waitFor(expression, waitOptions) {
      return cdp.waitFor(expression, waitOptions);
    },

    /** Input.dispatchMouseEvent 真实点击（isTrusted=true），点不到/元素不可见时给明确错误。 */
    async click(selector, clickOptions) {
      const element = await cdp.inspectSelector(selector);
      if (!element) {
        const url = await cdp.getUrl().catch(() => '(未知)');
        throw new Error('页面上找不到元素：' + selector + '（当前页面 ' + url + '）');
      }
      if (!element.visible) {
        throw new Error('元素存在但不可见，拒绝点击：' + selector + '（' + JSON.stringify(element.rect) + '）');
      }
      return cdp.clickSelector(selector, clickOptions);
    },

    insertText(text) {
      return cdp.insertText(text);
    },

    setValue(selector, value) {
      return cdp.setValue(selector, value);
    },

    screenshot(outPath) {
      return cdp.screenshot(outPath);
    },

    send(method, params, sendOptions) {
      return cdp.send(method, params, sendOptions);
    },

    close() {
      cdp.close();
    },
  };
}
