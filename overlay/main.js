'use strict';

/**
 * 桌面代理置顶小窗（overlay）主进程 —— 多会话版。
 *
 * 职责：
 * 1. 每个 sessionId 一个独立的无边框、置顶、半透明、可拖拽/缩放的 BrowserWindow，
 *    用 showInactive() 显示，不 activate 应用、不抢用户焦点；
 * 2. 起一个本地 HTTP 接口（默认 127.0.0.1:7788），接口全部支持 session 字段，
 *    缺省为 default（旧客户端不带 session 时行为不变）；
 * 3. 每个会话独立：位置、显隐、缩略图、日志、状态、空闲计时互不干扰；
 * 4. 以约 2fps 调用 screencapture 抓取该会话绑定的被控窗口，推给对应渲染进程。
 *
 * 会话窗口按需创建：第一次收到某个 session 的 /status、/log 等请求时创建；
 * POST /close 只关掉该会话的窗口，不影响其它会话。
 */

const { app, BrowserWindow, desktopCapturer, ipcMain, nativeImage, screen, shell } = require('electron');
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const platform = require('./platform.js');
const supervisor = require('./supervisor.js');
const {
  normalizeDshTitle,
  matchesTitle,
  shouldShowOnReady,
  shouldShowNow,
  isHostSnapshotFresh,
  isFrontTrusted,
  shouldCountStatusActivity,
  shouldIgnoreExpand,
} = require('./session-gate.js');
const { createOverlayServer, DEFAULT_SESSION, SESSION_PATTERN } = require('./server.js');
const { ensureTokenSync, tokenHeadersFor } = require('../core/local-token.cjs');
const { pickReplacementWindow } = require('./recover.js');
const { selectHostWindow } = require('./host-select.js');
const { normalizeWindowId, resolveWindowId } = require('./window-id.js');
const { computeFrameTarget } = require('./frame-target.js');
const layout = require('./layout.js');
const { appleScriptQuote } = require('./quote.js');
const { nextCaptureDelay } = require('./capture-policy.js');
const { shouldEvictSession, pickEvictionVictim, isSessionReallyVisible } = require('./session-policy.js');
const { createCrashLog, shouldReloadAfterCrash } = require('./crash-log.js');

const APP_NAME = 'desktop-agent-overlay';

// 贴在 DeepSeek Harness 窗口内（右上角），多会话按格子平铺，不自由漂浮
const ATTACH_TO_DSH = process.env.OVERLAY_ATTACH_DSH !== '0';
// 宿主应用（小窗贴谁、按谁的会话标题门控）——默认 DSH，可用环境变量换成任何应用
const HOST_PROCESS = process.env.OVERLAY_HOST_PROCESS || process.env.OVERLAY_DSH_PROCESS || 'DeepSeek Harness';
const HOST_BUNDLES = (process.env.OVERLAY_HOST_BUNDLES || 'com.deepseek.dsh')
  .split(',').map((x) => x.trim()).filter(Boolean);
const HOST_TITLE_SUFFIX = process.env.OVERLAY_HOST_TITLE_SUFFIX || 'DeepSeek Harness';
// overlay 自身 bundle（开发态 Electron 的 bundle id）
const SELF_BUNDLE = 'com.github.Electron';
// 宿主快照最大可信年龄：超过这个时间没拿到新快照，显示门控一律 fail-closed
const HOST_SNAPSHOT_MAX_AGE_MS = 5000;
// 兼容旧变量名
const DSH_PROCESS = HOST_PROCESS;
const DSH_MARGIN = 16;
const TILE_GAP = 10;

// 这些窗口永远不能被当成"被控目标"：DeepSeek Harness 自己，以及 overlay 自己的窗口
const SELF_WINDOW_PATTERN = new RegExp([
  HOST_PROCESS.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
  ...HOST_BUNDLES.map((b) => b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
  '^Desktop Agent$',
].join('|'), 'i');
const MAX_LOGS = 200;
const MAX_SESSIONS = Math.max(1, Math.round(Number(process.env.OVERLAY_MAX_SESSIONS) || 12));
// 会话数到上限时，最近这段时间内有活动的会话不参与回收（DSH 不在前台时它们也 visible=false，
// 光看「不可见」会把正在被任务使用的会话关掉）。可用环境变量调，0 = 只按可见/固定判断。
const SESSION_RECENT_MS = Math.max(0, Math.round(Number(process.env.OVERLAY_SESSION_RECENT_MS ?? 60_000)));
const DEFAULT_PORT = 7788;
const DEFAULT_WIDTH = 300;
const DEFAULT_HEIGHT = 190;
const SCREENSHOT_CMD = '/usr/sbin/screencapture';
// 缩略图按「窗口宽 × 2（Retina）」出图，上限 1600；质量 88
const THUMB_SCALE = 2;
const THUMB_MAX_PIXEL_WIDTH = 2560;
const THUMB_MIN_PIXEL_WIDTH = 300;
const THUMB_JPEG_QUALITY = 92;
const CAPTURE_TIMEOUT_MS = 4000;
// 连续抓帧失败多少次才对外报错：真实窗口刚绑定时偶尔会连续失败 2–3 次
const CAPTURE_FAIL_TOLERANCE = Math.max(1, Math.round(toNumber(process.env.OVERLAY_CAPTURE_FAIL_TOLERANCE, 4)));
// 自检开关：隐藏会话也抓帧（默认关；只用于验证失效恢复，不影响正常省 CPU 行为）
const CAPTURE_WHILE_HIDDEN = String(process.env.OVERLAY_CAPTURE_WHILE_HIDDEN || '') === '1';
// 小于这个体积的 JPEG 基本就是一整块纯色（正常窗口帧 40KB 左右）
const BLANK_JPEG_BYTES = Math.max(1000, Math.round(toNumber(process.env.OVERLAY_BLANK_JPEG_BYTES, 8000)));
const FADE_MS = 180;
// 宿主轮询节奏：有小窗可见时快轮（切会话要马上消失），全都藏着时慢轮省电。
// 快轮 400ms：用户切走会话到小窗消失最多约 0.5s；之前固定 1.2s 会明显觉得"迟一下"。
const ATTACH_FAST_MS = clamp(Math.round(toNumber(process.env.OVERLAY_ATTACH_FAST_MS, 400)), 120, 2000);
// 被会话门控藏起来、但宿主还在前台：多半马上会切回来，用中间档轮询（切回时 0.7s 内重新出现）
const ATTACH_MID_MS = clamp(Math.round(toNumber(process.env.OVERLAY_ATTACH_MID_MS, 700)), 200, 3000);
const ATTACH_SLOW_MS = clamp(Math.round(toNumber(process.env.OVERLAY_ATTACH_SLOW_MS, 1500)), 300, 5000);

function toNumber(raw, fallback) {
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

const config = {
  host: process.env.OVERLAY_HOST || '127.0.0.1',
  port: Math.round(toNumber(process.env.OVERLAY_PORT, DEFAULT_PORT)),
  // 抓帧频率上限（实际受 screencapture 单帧 100–125ms 限制，通常 8–13fps）
  fps: clamp(toNumber(process.env.OVERLAY_FPS, 15), 1, 30),
  width: Math.round(toNumber(process.env.OVERLAY_WIDTH, DEFAULT_WIDTH)),
  height: Math.round(toNumber(process.env.OVERLAY_HEIGHT, DEFAULT_HEIGHT)),
  margin: Math.round(toNumber(process.env.OVERLAY_MARGIN, 16)),
  showDock: process.env.OVERLAY_SHOW_DOCK === '1',
  windowId: resolveWindowId(process.argv, process.env),
  // 最后一次活动后多少毫秒自动隐藏；0 表示关闭自动隐藏
  idleHideMs: Math.max(0, Math.round(toNumber(process.env.OVERLAY_IDLE_HIDE_MS, 5000))),
  // 会话窗口回收：多久没活动就自动关掉（0 = 不回收）。默认 30 分钟，避免开久了堆窗口占内存。
  sessionTtlMs: Math.max(0, Math.round(toNumber(process.env.OVERLAY_SESSION_TTL_MS, 30 * 60 * 1000))),
};

let overlayServer = null;
let serverError = null;
let tempDir = null;
let cleanedUp = false;
let logSeq = 0;
const pendingTempFiles = new Set();

// ---------- 会话表 ----------

/** @type {Map<string, any>} */
const sessions = new Map();
let sessionSeq = 0;

// 最近一次崩溃/渲染进程退出：写进 /health，排障时能看出「窗口没了」是崩了还是没绑上
const crashLog = createCrashLog();
function noteCrash(kind, detail) {
  const info = crashLog.note(kind, detail);
  console.error('[overlay] ' + info.kind + '：' + info.detail);
  return info;
}

// 记录属于 DeepSeek Harness 自身的窗口 id：这些窗口永远不允许被当作"被控目标"。
const selfWindowIds = new Set();

function newSessionState(id) {
  const windowId = id === DEFAULT_SESSION ? config.windowId : null;
  return {
    status: '待命',
    activity: 'idle',
    logs: [],
    windowId: windowId,
    visible: false,
    pinned: false,
    lastActivityAt: null,
    thumbnail: {
      state: windowId ? 'waiting' : 'no-window',
      dataUrl: null,
      width: 0,
      height: 0,
      updatedAt: null,
      error: null,
    },
  };
}

function ensureSession(id, source) {
  const existing = sessions.get(id);
  if (existing) return existing;
  if (!SESSION_PATTERN.test(String(id))) {
    const error = new Error('session 只能是 1–64 位字母/数字/点/下划线/连字符');
    error.statusCode = 400;
    throw error;
  }
  if (sessions.size >= MAX_SESSIONS) {
    // 先回收最久没活动、不可见、未固定的闲置会话（保护 default 与用户正在看的会话）。
    // 否则调用方忘了 /close 时，后续任务会因为"会话数已达上限"整块失败（实测踩过：矩阵跑完不关会话）。
    // DSH 不在前台时所有会话都 visible=false，所以「不可见」不能当成「没在用」：
    // 最近一分钟内有活动的由 pickEvictionVictim 跳过，防止把正在被任务使用的会话回收掉。
    // 「正在显示」以窗口实际可见为准：窗口刚建好时 ready-to-show 会先 showInactive 并把
    // state.visible 置 true，若只看状态里这个标记，一批刚建的会话会把上限顶死、后续任务全 409。
    const evictionList = [...sessions].map(([sid, sess]) => ({
      id: sid,
      visible: isSessionReallyVisible(
        sess.state && sess.state.visible,
        sess.win && !sess.win.isDestroyed() && sess.win.isVisible(),
      ),
      lastActivityAt: sess.state && sess.state.lastActivityAt,
      createdAt: sess.createdAt,
      pinned: Boolean(sess.flags && sess.flags.pinned),
    }));
    const now = Date.now();
    // 两轮挑：先只动「最近没活动」的，避免把正在被任务用的会话关掉；
    // 全都刚活动过（比如调用方一口气建满）时退回原策略挑最久没活动的，
    // 否则一次泄漏就会把后续任务全部顶成 409——这是实机踩过的故障模式。
    const victimId = pickEvictionVictim(evictionList, { now, protectMs: SESSION_RECENT_MS, defaultSession: DEFAULT_SESSION })
      || pickEvictionVictim(evictionList, { now, protectMs: 0, defaultSession: DEFAULT_SESSION });
    if (victimId) {
      closeSession(victimId);
      console.log('[overlay] 会话数到上限，回收闲置会话 ' + victimId);
    } else {
      const others = evictionList.filter((s) => s.id !== DEFAULT_SESSION);
      const shown = others.filter((s) => s.visible);
      const pinned = others.filter((s) => s.pinned);
      const recent = others.filter((s) => !s.visible && !s.pinned
        && Date.now() - Number(s.lastActivityAt || s.createdAt || 0) < SESSION_RECENT_MS);
      const error = new Error('会话数已达上限 ' + MAX_SESSIONS + '（' + others.length + ' 个非默认会话：'
        + shown.length + ' 个正在显示、' + pinned.length + ' 个已固定、' + recent.length
        + ' 个最近 ' + Math.round(SESSION_RECENT_MS / 1000) + ' 秒内活动过；一个都不能回收）');
      error.statusCode = 409;
      throw error;
    }
  }

  const s = {
    id: id,
    index: sessionSeq++,
    createdAt: Date.now(),
    win: null,
    state: newSessionState(id),
    flags: {
      ready: false,
      expanded: false,
      smallBounds: null,
      followDsh: true,
      settingBounds: false,
      suppressBySession: false,
      hovering: false,
      capturing: false,
      clickThrough: true,
      cursorHotspot: false,
      rendererInteractive: false,
      hasAction: false,
    },
    timers: { thumb: null, idle: null, fade: null },
    // 会话标题提示：只在 DSH 当前前台会话标题命中它时才显示（null=旧行为，总是可显示）
    titleHint: null,
    explicitTitleHint: false, // 调用方显式传了 titleHint
    autoTitleBound: false,    // 已经按第一次活动时的 DSH 标题自动绑定过
    matched: true,
    thumbSeq: 0,
    frameTimes: [],
    frameBytes: 0,
    frameCount: 0,
    captureMs: 0,
    lastThumbSignal: '',
    lastCaptureError: null,
    captureFailStreak: 0,   // 连续抓帧失败次数：偶发一次不报错，连续失败才飘红
    lastFrameHash: null,    // 上一帧内容哈希：连续不变就降频抓帧
    unchangedFrames: 0,     // 连续多少帧画面没变
    externalFrameAt: 0,
  };

  sessions.set(id, s);
  createWindowForSession(s);
  pushLog(s, '会话 ' + id + ' 已创建小窗' + (source ? '（' + source + '）' : ''), 'system');
  return s;
}

function closeSession(id) {
  const s = sessions.get(id);
  if (!s) return false;

  stopSessionTimers(s);
  sessions.delete(id);

  const win = s.win;
  s.win = null;
  if (win && !win.isDestroyed()) {
    try {
      win.destroy();
    } catch (error) {
      // 关窗失败不阻塞其它会话
    }
  }
  return true;
}

function sessionCount() {
  return sessions.size;
}

// ---------- 向渲染进程广播（按会话） ----------

function send(s, channel, payload) {
  const win = s.win;
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return;
  win.webContents.send(channel, payload);
}

function stopSessionTimers(s) {
  stopThumbnailLoop(s);
  clearIdleTimer(s);
  if (s.timers.fade) {
    clearInterval(s.timers.fade);
    s.timers.fade = null;
  }
}

// ---------- 贴 DSH 窗口 + 前台判定 ----------

// DSH 会同时挂着一个 33px 高的标题栏窗口和一个真正的内容窗口，
// 只取 window 1 会把小窗压进标题栏里，所以这里枚举全部窗口、取面积最大的那个。
function readDshBounds() {
  if (!platform.isMac) return platform.readWindowBounds(DSH_PROCESS);
  return new Promise((resolve) => {
    const script =
      'const se = Application("System Events");' +
      'const p = se.processes.byName(' + JSON.stringify(DSH_PROCESS) + ');' +
      'const ws = p.windows();' +
      'let best = null;' +
      'for (let i = 0; i < ws.length; i++) {' +
      '  try {' +
      '    const pos = ws[i].position(); const size = ws[i].size();' +
      '    const area = size[0] * size[1];' +
      '    let title = "";' +
      '    try { title = ws[i].name() || ""; } catch (e2) {}' +
      '    if (!best || area > best.area) best = { x: pos[0], y: pos[1], w: size[0], h: size[1], area: area, title: title };' +
      '  } catch (e) {}' +
      '}' +
      'JSON.stringify(best);';
    execFile('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script], { timeout: 2500 }, (err, stdout) => {
      if (!err) {
        try {
          const best = JSON.parse(String(stdout));
          if (best && best.w > 0 && best.h > 0) {
            resolve({ x: best.x, y: best.y, w: best.w, h: best.h, title: best.title || '' });
            return;
          }
        } catch (parseError) {
          // 落到下面的 AppleScript 兜底
        }
      }
      // 兜底：老办法，window 1
      const fallback = 'tell application "System Events" to tell process ' + appleScriptQuote(DSH_PROCESS) +
        ' to get {' + '{position of window 1}' + ', ' + '{size of window 1}' + '}';
      execFile('/usr/bin/osascript', ['-e', fallback], { timeout: 2000 }, (fallbackErr, fallbackOut) => {
        if (fallbackErr) return resolve(null);
        const nums = String(fallbackOut).match(/-?\d+/g);
        if (!nums || nums.length < 4) return resolve(null);
        const [x, y, w, h] = nums.map(Number);
        if (!w || !h) return resolve(null);
        resolve({ x, y, w, h });
      });
    });
  });
}

// 用 CGWindowList（Quartz）直接看「屏幕上真实存在的宿主窗口」：
// 不依赖 System Events/AX，宿主最小化/隐藏/不在当前 Space 时窗口会从 OnScreenOnly 列表里消失，
// 从而避免「System Events 读不到但缓存了旧 bounds，小窗继续显示」的问题。
// 返回 { ok, window }：ok=false 表示这条通道本身失败（不要据此判断宿主不可见）。
function readHostWindowCg() {
  if (!platform.isMac) {
    return Promise.resolve({ ok: false, window: null });
  }
  return new Promise((resolve) => {
    const script =
      'ObjC.import("CoreGraphics");' +
      'const opts=$.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements;' +
      'const arr=ObjC.castRefToObject($.CGWindowListCopyWindowInfo(opts, 0));' +
      'const out=[];' +
      'for (let i=0;i<arr.count;i++){' +
      '  try {' +
      '    const d=arr.objectAtIndex(i);' +
      '    const owner=String(ObjC.unwrap(d.objectForKey("kCGWindowOwnerName")) || "");' +
      '    const layer=Number(ObjC.unwrap(d.objectForKey("kCGWindowLayer")));' +
      '    if (layer !== 0) continue;' +
      '    const b=ObjC.deepUnwrap(d.objectForKey("kCGWindowBounds"));' +
      '    const name=ObjC.unwrap(d.objectForKey("kCGWindowName")) || "";' +
      '    out.push({owner:owner,x:Number(b.X),y:Number(b.Y),w:Number(b.Width),h:Number(b.Height),name:String(name)});' +
      '  } catch(e){}' +
      '}' +
      'JSON.stringify(out);';
    execFile('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script], { timeout: 2000 }, (err, stdout) => {
      if (err) return resolve({ ok: false, window: null });
      try {
        const list = JSON.parse(String(stdout));
        if (!Array.isArray(list)) return resolve({ ok: false, window: null });
        const pick = selectHostWindow(list.map((i) => ({ owner: i.owner, title: i.name, x: i.x, y: i.y, w: i.w, h: i.h })), HOST_PROCESS);
        resolve({ ok: true, window: pick ? { x: pick.x, y: pick.y, w: pick.w, h: pick.h, title: pick.title, hostKind: pick.kind } : null });
      } catch (error) {
        resolve({ ok: false, window: null });
      }
    });
  });
}

// 一次 JXA 调用同时取「前台应用 bundle + 宿主窗口列表」：
// 原来 frontmost 和 CGWindowList 各起一个 osascript，一轮要 200ms 以上，轮询快了就烧 CPU。
function readHostSnapshot() {
  if (!platform.isMac) return Promise.resolve(null);
  return new Promise((resolve) => {
    const script =
      'ObjC.import("AppKit");' +
      'ObjC.import("CoreGraphics");' +
      'let front="";' +
      'try { front=String(ObjC.unwrap($.NSWorkspace.sharedWorkspace.frontmostApplication.bundleIdentifier)||""); } catch(e) {}' +
      'const opts=$.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements;' +
      'const arr=ObjC.castRefToObject($.CGWindowListCopyWindowInfo(opts, 0));' +
      'const out=[];' +
      'for (let i=0;i<arr.count;i++){' +
      '  try {' +
      '    const d=arr.objectAtIndex(i);' +
      '    const owner=String(ObjC.unwrap(d.objectForKey("kCGWindowOwnerName")) || "");' +
      '    const layer=Number(ObjC.unwrap(d.objectForKey("kCGWindowLayer")));' +
      '    if (layer !== 0) continue;' +
      '    const b=ObjC.deepUnwrap(d.objectForKey("kCGWindowBounds"));' +
      '    const name=ObjC.unwrap(d.objectForKey("kCGWindowName")) || "";' +
      '    out.push({owner:owner,x:Number(b.X),y:Number(b.Y),w:Number(b.Width),h:Number(b.Height),name:String(name)});' +
      '  } catch(e){}' +
      '}' +
      'JSON.stringify({front:front,windows:out});';
    execFile('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script], { timeout: 2000 }, (err, stdout) => {
      if (err) return resolve(null);
      try {
        const data = JSON.parse(String(stdout));
        if (!data || !Array.isArray(data.windows)) return resolve(null);
        const pick = selectHostWindow(data.windows.map((i) => ({ owner: i.owner, title: i.name, x: i.x, y: i.y, w: i.w, h: i.h })), HOST_PROCESS);
        resolve({
          front: data.front || null,
          cg: { ok: true, window: pick ? { x: pick.x, y: pick.y, w: pick.w, h: pick.h, title: pick.title, hostKind: pick.kind } : null },
        });
      } catch (error) {
        resolve(null);
      }
    });
  });
}

async function readFrontmostBundle() {
  if (!platform.isMac) {
    const front = await platform.readFrontmostApp();
    return front && front.bundle ? front.bundle : null;
  }
  return new Promise((resolve) => {
    execFile('/usr/bin/osascript', ['-e',
      'tell application "System Events" to get bundle identifier of first process whose frontmost is true'],
      { timeout: 1500 }, (err, stdout) => resolve(err ? null : String(stdout).trim()));
  });
}

// 宿主窗口位置/标题由 attach 循环每秒刷新；拖动时直接用缓存。
let dshBounds = null;
let dshTitle = '';
// 宿主（DSH 窗口）是否真实可见：CGWindowList 里没有窗口时立刻隐藏全部小窗。
// task-27 R2：初值改为 fail-closed，第一次 attachTick 拿到真实快照前一律不显示。
let hostVisible = false;
let hostBoundsStale = true;
let hostCheckedAt = 0;
// 屏幕录制权限静默预检（CGPreflightScreenCaptureAccess，不会弹授权框）：缓存 15 秒。
// 未授权时抓帧直接跳过并回 permission-missing，不让 screencapture 触发系统授权框。
const SCREEN_PERMISSION_TTL_MS = 15000;
let screenPermission = { status: 'unknown', granted: null, message: '', checkedAt: 0 };
let screenPermissionProbe = null;
// CGWindowList 标题健康（M2）：全空/大量为空通常意味着没有屏幕录制权限，而不是窗口真的不存在。
let windowTitleHealth = {
  status: 'unknown', total: 0, empty: 0, emptyRatio: 0,
  allEmpty: false, suspectPermission: false, message: '', checkedAt: 0,
};
let hostKind = 'native';   // native=DSH 原生窗口；browser=浏览器里的 DSH Web 界面

// 多会话平铺：优先排满右上角一行，再往下一行；都限制在 DSH 窗口内部
function tilePosition(s, b) {
  const [cw, ch] = s.win.getSize();
  // 用「当前还活着的会话里的顺序」当格子号：全局自增序号开过很多会话后会让新窗口堆到底部
  const ordered = Array.from(sessions.values()).sort((a, c) => a.createdAt - c.createdAt);
  const slot = Math.max(0, ordered.indexOf(s));
  return layout.tilePosition(b, { w: cw, h: ch }, slot, { margin: DSH_MARGIN, gap: TILE_GAP });
}

function clampIntoDsh(s) {
  const b = dshBounds;
  const win = s.win;
  if (!b || !win || win.isDestroyed() || s.flags.expanded || s.flags.settingBounds) return;

  const [x, y] = win.getPosition();
  const [cw, ch] = win.getSize();
  const fixed = layout.clampIntoBounds({ x: x, y: y }, { w: cw, h: ch }, b, 1);
  if (fixed.changed) {
    s.flags.settingBounds = true;
    win.setPosition(fixed.x, fixed.y);
    setTimeout(() => { s.flags.settingBounds = false; }, 120);
  }
}

// normalizeDshTitle / matchesTitle 见 session-gate.js（纯函数，带单测）

// 第一次推 /status 或 /log 且没显式给 titleHint 时，用当前 DSH 标题自动绑定该会话。
// 读不到标题就先不绑，下次活动再试（避免把窗口误藏）。
function maybeAutoBindTitle(s) {
  if (s.explicitTitleHint || s.autoTitleBound) return;
  if (!dshTitle) return;
  const short = normalizeDshTitle(dshTitle, HOST_TITLE_SUFFIX);
  if (!short) return;
  s.titleHint = short.slice(0, 120);
  s.autoTitleBound = true;
  s.matched = true;
}

// titleHint 变化时立即重算一次匹配，并把不匹配的窗口立刻收起来（不用等下一个轮询周期）
function setTitleHint(s, raw) {
  if (raw === undefined || raw === null) return s.titleHint;
  if (typeof raw !== 'string') return s.titleHint;
  const text = raw.replace(/\s+/g, ' ').trim().slice(0, 120);
  if (text) {
    s.titleHint = text;
    s.explicitTitleHint = true;
    s.autoTitleBound = true; // 显式优先，不再自动覆盖
  } else {
    // 显式传空字符串 = 清掉 hint，恢复旧行为；下次活动允许重新自动绑定
    s.titleHint = null;
    s.explicitTitleHint = false;
    s.autoTitleBound = false;
  }
  if (!s.titleHint) {
    s.matched = true;
    return null;
  }
  s.matched = titleMatches(s);
  if (!s.matched) {
    // 归属一变就立刻收起，不等轮询；窗口即便已不可见也要把状态标成 false，
    // 否则健康信息会出现「说可见、其实已藏」的不一致
    s.flags.suppressBySession = true;
    if (s.win && !s.win.isDestroyed() && s.win.isVisible()) s.win.hide();
    s.state.visible = false;
  }
  return s.titleHint;
}

function titleMatches(s) {
  return matchesTitle(s.titleHint, dshTitle, HOST_TITLE_SUFFIX);
}

async function attachToDsh(s, front, bounds) {
  const win = s.win;
  s.matched = titleMatches(s);

  if (!ATTACH_TO_DSH || !win || win.isDestroyed()) return;

  // 只在「召唤它的 DSH 会话」里显示：宿主快照不新鲜、DSH 不在前台、或当前前台会话标题对不上，就隐藏。
  // task-27 R1/R2：宿主可见 + 快照新鲜 + 前台可信 + 标题匹配，缺一即隐藏（fail-closed）。
  const hostFresh = isHostSnapshotFresh({
    hostVisible,
    hostStale: hostBoundsStale,
    hostCheckedAt,
    now: Date.now(),
    maxHostAgeMs: HOST_SNAPSHOT_MAX_AGE_MS,
  });
  const frontOk = isFrontTrusted(front, HOST_BUNDLES, SELF_BUNDLE);
  // 标题未知（dshTitle 还没读到）同样按 fail-closed 处理，和 ready-to-show/showOverlay 保持一致
  const titleKnown = Boolean(dshTitle);
  const shouldHide = !hostFresh || !frontOk || !titleKnown || !s.matched;
  if (shouldHide) {
    if (win.isVisible()) {
      s.flags.suppressBySession = true;
      win.hide();
    }
    s.state.visible = false;
    return;
  }
  if (s.flags.suppressBySession) {
    s.flags.suppressBySession = false;
    // 固定显示（/visible true）的窗口不依赖空闲窗口期，条件恢复就必须重新出现
    const withinIdle = s.state.lastActivityAt && Date.now() - s.state.lastActivityAt < (config.idleHideMs || 5000);
    if (s.state.pinned || withinIdle) {
      // task-27 R3：ready-to-show 被门控隐藏时可能执行过 setOpacity(0)，
      // 这里补完整显示序列，避免 re-show 后窗口「显示但透明」。
      win.setOpacity(0);
      win.showInactive();
      s.flags.rendererInteractive = false;
      applyClickThrough(s);
      fadeWindow(s, 1);
      s.state.visible = true;
    }
  }
  if (s.flags.expanded) return;
  if (!s.flags.followDsh || !bounds) return;

  const pos = tilePosition(s, bounds);
  const [px, py] = win.getPosition();
  if (Math.abs(px - pos.x) > 2 || Math.abs(py - pos.y) > 2) {
    s.flags.settingBounds = true;
    win.setPosition(pos.x, pos.y);
    setTimeout(() => { s.flags.settingBounds = false; }, 120);
  }
}

// 兜底：悬停标记可能卡死（窗口正好出现在鼠标下面时浏览器会补发 mouseenter），
// 导致 scheduleIdleHide 一直返回。只要超过 max(15s, idleHideMs*3) 完全没有活动，
// 就无视 hover / 自动隐藏开关之外的状态，强制把窗口收起来，保证「没操作就一定消失」。
const HARD_HIDE_MS = Math.max(15000, config.idleHideMs * 3);
let hideGuardTimer = null;

// 会话窗口回收：过期会话自动关窗，下次有活动会按需重建
let sessionSweepTimer = null;

function startSessionSweep() {
  if (sessionSweepTimer || !config.sessionTtlMs) return;
  sessionSweepTimer = setInterval(() => {
    const now = Date.now();
    for (const s of Array.from(sessions.values())) {
      const snapshot = {
        pinned: s.state.pinned,
        expanded: s.flags.expanded,
        visible: s.state.visible,
        hovering: s.flags.hovering,
        lastActivityAt: s.state.lastActivityAt,
        createdAt: s.createdAt,
      };
      if (!shouldEvictSession(snapshot, now, config.sessionTtlMs)) continue;
      pushLog(s, '超过 ' + Math.round(config.sessionTtlMs / 60000) + ' 分钟没有活动，自动关闭该会话窗口', 'system');
      closeSession(s.id);
    }
  // 扫得比 TTL 勤一些：TTL 小时也能及时回收（生产默认 30 分钟 → 每 60 秒扫一次）
  }, clamp(Math.round(config.sessionTtlMs / 4), 2000, 60000));
  if (typeof sessionSweepTimer.unref === 'function') sessionSweepTimer.unref();
}

function startHideGuard() {
  if (hideGuardTimer) return;
  hideGuardTimer = setInterval(() => {
    const now = Date.now();
    for (const s of sessions.values()) {
      if (!s.state.visible || s.state.pinned || s.flags.expanded) continue;
      const last = s.state.lastActivityAt || 0;
      if (!last || now - last < HARD_HIDE_MS) continue;
      s.flags.hovering = false;
      hideOverlay(s, 'idle');
    }
  }, 1000);
}

function stopHideGuard() {
  if (hideGuardTimer) {
    clearInterval(hideGuardTimer);
    hideGuardTimer = null;
  }
}

let attachTimer = null;
let lastAttachAt = 0;
let lastAttachIntervalMs = ATTACH_SLOW_MS;
let frontmostBundle = null;   // 最近一次轮询到的前台应用（健康信息里展示，便于解释为什么藏起来）

let attachBusy = false;

async function attachTick() {
  // 上一轮还没返回就跳过这一轮：快轮询时不会堆起一串 osascript 进程
  if (attachBusy) return;
  attachBusy = true;
  try {
    const snap = ATTACH_TO_DSH ? await readHostSnapshot() : null;
    const front = snap ? snap.front : await readFrontmostBundle();
    frontmostBundle = front || null;
    let bounds = null;
    if (ATTACH_TO_DSH) {
      const cg = snap ? snap.cg : await readHostWindowCg();
      if (cg.ok) {
        hostCheckedAt = Date.now();
        if (cg.window) {
          // 屏幕上真的能读到宿主窗口：位置/标题都刷新，stale=false
          bounds = cg.window;
          dshBounds = bounds;
          if (bounds.title) dshTitle = bounds.title;
          hostKind = bounds.hostKind || 'native';
          hostVisible = true;
          hostBoundsStale = false;
        } else {
          // 屏幕上没有宿主窗口（最小化/隐藏/其它 Space）：必须隐藏，不能再用缓存 bounds 硬撑
          hostVisible = false;
          hostBoundsStale = true;
        }
      } else {
        // CGWindowList 通道失败：不清空缓存、不据此断言宿主不可见；标 stale，交给兜底
        hostBoundsStale = true;
        if (Date.now() - hostCheckedAt > 5000) {
          hostCheckedAt = Date.now();
          const fallback = await readDshBounds();
          if (fallback) {
            dshBounds = fallback;
            if (fallback.title) dshTitle = fallback.title;
            hostKind = 'native';
            hostVisible = true;
            hostBoundsStale = false;
          }
        }
        bounds = dshBounds;
      }
    }
    // 兜底：不贴宿主（独立使用）时贴到屏幕右上角，保证不依赖宿主也可用。
    if (!ATTACH_TO_DSH && !bounds) {
      const area = screen.getPrimaryDisplay().workArea;
      bounds = { x: area.x, y: area.y, w: area.width, h: area.height };
    }
    if (!sessions.size) return;
    for (const s of sessions.values()) {
      attachToDsh(s, front, bounds).catch(() => {});
      // 兜底：被门控隐藏但窗口实际还 visible（淡出回调丢了/渲染异常）→ 硬藏，别让它卡在屏幕上
      const w = s.win;
      if (w && !w.isDestroyed() && !s.state.visible && s.flags.suppressBySession && w.isVisible()) {
        try { w.hide(); } catch {}
      }
    }
  } finally {
    attachBusy = false;
    lastAttachAt = Date.now();
  }
}

// task-27：门控因为「宿主快照还没到手/已过期」而拦下显示时，立刻补一次轮询，
// 让 attach 循环尽快拿到真实值决定是否显示，不用等慢轮询（全隐藏时 1.5s）。
let attachRefreshQueued = false;
function requestAttachRefresh() {
  if (!ATTACH_TO_DSH || attachRefreshQueued) return;
  attachRefreshQueued = true;
  setTimeout(() => {
    attachRefreshQueued = false;
    attachTick().catch(() => {});
  }, 0);
}

// 快慢自适应：有小窗露着头就快轮（切会话要立刻消失），全藏着就慢轮省电
function attachDelayMs() {
  let mid = false;
  for (const s of sessions.values()) {
    if (s.state.visible || s.flags.expanded) return ATTACH_FAST_MS;
    if (s.win && !s.win.isDestroyed() && s.win.isVisible()) return ATTACH_FAST_MS;
    // 被会话门控藏起来（切到了别的会话）但宿主仍在前台：准备随时重新出现
    if (s.flags.suppressBySession && hostVisible) mid = true;
  }
  return mid ? ATTACH_MID_MS : ATTACH_SLOW_MS;
}

let attachActive = false;

function startAttachLoop() {
  if (!ATTACH_TO_DSH || attachActive) return;
  attachActive = true;
  const tick = () => {
    if (!attachActive) return;
    attachTick().catch(() => {}).finally(() => {
      if (!attachActive) return;
      const delay = attachDelayMs();
      lastAttachIntervalMs = delay;
      attachTimer = setTimeout(tick, delay);
    });
  };
  attachTimer = setTimeout(tick, 0);
}

function stopAttachLoop() {
  attachActive = false;
  if (attachTimer) {
    clearTimeout(attachTimer);
    attachTimer = null;
  }
}

// 悬停检测：主进程轮询鼠标位置。
// 窗口主体是 -webkit-app-region: drag 拖动区，Chromium 不会给渲染进程派发 mouseenter，
// 单靠渲染层的 overlay:hover 事件悬停标记永远不生效（会导致「悬停暂停」变成「永不暂停」）。
// 主进程直接比对鼠标坐标与窗口 bounds：进入窗口暂停自动隐藏，离开继续计时。
let cursorTimer = null;

function startCursorWatch() {
  if (cursorTimer) return;
  cursorTimer = setInterval(() => {
    let point = null;
    for (const s of sessions.values()) {
      const win = s.win;
      if (!win || win.isDestroyed() || !s.flags.ready) continue;
      if (!s.state.visible) {
        if (s.flags.hovering) s.flags.hovering = false;
        if (s.flags.cursorHotspot) {
          s.flags.cursorHotspot = false;
          applyClickThrough(s);
        }
        continue;
      }
      if (!point) {
        try {
          point = screen.getCursorScreenPoint();
        } catch (error) {
          return;
        }
      }
      let b;
      try {
        b = win.getBounds();
      } catch (error) {
        continue;
      }
      const inside = point.x >= b.x && point.x < b.x + b.width && point.y >= b.y && point.y < b.y + b.height;
      if (inside !== s.flags.hovering) {
        s.flags.hovering = inside;
        if (inside) clearIdleTimer(s);
        else scheduleIdleHide(s);
      }
      const hotspot = inside && cursorInHotspot(s, win, point);
      if (hotspot !== s.flags.cursorHotspot) {
        s.flags.cursorHotspot = hotspot;
        applyClickThrough(s);
      }
    }
  }, 150);
}

function stopCursorWatch() {
  if (cursorTimer) {
    clearInterval(cursorTimer);
    cursorTimer = null;
  }
}

// ---------- HUD 显隐（用时出现，闲置自动淡出） ----------

function clearIdleTimer(s) {
  if (s.timers.idle) {
    clearTimeout(s.timers.idle);
    s.timers.idle = null;
  }
}

function fadeWindow(s, targetOpacity, done) {
  const win = s.win;
  if (!win || win.isDestroyed()) return;
  if (s.timers.fade) {
    clearInterval(s.timers.fade);
    s.timers.fade = null;
  }

  const from = typeof win.getOpacity === 'function' ? win.getOpacity() : 1;
  if (Math.abs(from - targetOpacity) < 0.01) {
    win.setOpacity(targetOpacity);
    if (done) done();
    return;
  }

  const steps = Math.max(1, Math.round(FADE_MS / 16));
  let step = 0;
  s.timers.fade = setInterval(() => {
    if (!s.win || s.win.isDestroyed()) {
      clearInterval(s.timers.fade);
      s.timers.fade = null;
      return;
    }
    step += 1;
    const value = from + (targetOpacity - from) * (step / steps);
    s.win.setOpacity(step >= steps ? targetOpacity : value);
    if (step >= steps) {
      clearInterval(s.timers.fade);
      s.timers.fade = null;
      if (done) done();
    }
  }, 16);
}

// 点击穿透：默认整窗穿透（后方 DSH 正常操作），只有按钮/胶囊/8px 拖拽条热区临时接管鼠标。
// 两个信号取「或」：主进程按鼠标坐标算的热区（兜底、无延迟事件时也能生效）+ 渲染进程 pointermove 上报。
function applyClickThrough(s) {
  const win = s.win;
  if (!win || win.isDestroyed()) return;
  const through = !(s.flags.rendererInteractive || s.flags.cursorHotspot);
  s.flags.clickThrough = through;
  try {
    win.setIgnoreMouseEvents(through, { forward: true });
  } catch (error) {
    // 窗口销毁瞬间可能失败，不影响其它逻辑
  }
}

// 与渲染进程的热区保持一致：边缘/顶部 8px + 右上角两个按钮 + 左上角日志入口 + 错误操作按钮
function cursorInHotspot(s, win, point) {
  let b;
  try {
    b = win.getBounds();
  } catch (error) {
    return false;
  }
  const x = point.x - b.x;
  const y = point.y - b.y;
  const w = b.width;
  const h = b.height;
  if (x < 0 || y < 0 || x >= w || y >= h) return false;
  if (x <= 8 || y <= 8 || x >= w - 8 || y >= h - 8) return true;      // 拖拽条
  if (x >= w - 68 && x <= w - 4 && y >= 4 && y <= 36) return true;     // ⤢ / ✕
  // ■ 停止按钮（right:65 → 占 x ∈ [w-87, w-65]），只在任务运行时存在
  if (s && s.state.activity === 'running' && x >= w - 90 && x < w - 64 && y >= 4 && y <= 36) return true;
  if (x >= 4 && x <= 60 && y >= 4 && y <= 32) return true;             // 左上角日志入口
  // 底部错误操作按钮（打开设置/重试）：只有按钮真的显示时才接管鼠标
  if (s && s.flags && s.flags.hasAction && y >= h - 42 && y <= h - 8 && x >= 8 && x <= w - 8) return true;
  return false;
}

function scheduleIdleHide(s) {
  clearIdleTimer(s);
  if (!config.idleHideMs || s.state.pinned || s.flags.hovering || s.flags.expanded) return;
  s.timers.idle = setTimeout(() => {
    s.timers.idle = null;
    hideOverlay(s, 'idle');
  }, config.idleHideMs);
}

function showOverlay(s, reason) {
  const win = s.win;
  if (!win || win.isDestroyed()) return;

  // 活动驱动显示走和 ready-to-show 同一套 fail-closed 门控（task-27 R1/R2）：
  // 宿主可见且快照新鲜、前台可信、标题已知且匹配，任何一项未知都不显示。
  maybeAutoBindTitle(s);
  const titleMatched = !s.titleHint || titleMatches(s);
  if (!titleMatched) s.matched = false;
  // 独立使用模式（OVERLAY_ATTACH_DSH=0）没有宿主可门控，维持旧的「有活动就显示」行为
  const allow = !ATTACH_TO_DSH || shouldShowNow({
    hostVisible,
    hostStale: hostBoundsStale,
    hostCheckedAt,
    now: Date.now(),
    maxHostAgeMs: HOST_SNAPSHOT_MAX_AGE_MS,
    front: frontmostBundle || '',
    hostBundles: HOST_BUNDLES,
    self: SELF_BUNDLE,
    titleKnown: Boolean(dshTitle),
    titleMatched: titleMatched,
  });
  if (!allow) {
    s.state.visible = false;
    // 标记 suppress：attach 循环在宿主快照恢复后，会按「有活动/pinned」决定是否补显示
    s.flags.suppressBySession = true;
    // 宿主快照还没就绪/已过期：补一次轮询，等 attach 循环拿到真实值后再决定是否显示
    if (ATTACH_TO_DSH) requestAttachRefresh();
    return;
  }

  s.state.visible = true;
  s.flags.suppressBySession = false;
  // 还没 ready-to-show 的窗口交给 ready-to-show 首次显示
  if (!s.flags.ready) return;

  if (!win.isVisible()) {
    win.setOpacity(0);
    // showInactive：只显示，不激活、不抢焦点
    win.showInactive();
  }
  // 刚显示时先按满帧率抓一帧，别让降频状态拖慢"打开就有画面"的观感
  s.unchangedFrames = 0;
  // 新出现的窗口先按穿透处理，等鼠标真的移到按钮/拖拽条上再接管
  s.flags.rendererInteractive = false;
  applyClickThrough(s);
  fadeWindow(s, 1);
  void captureThumbnail(s);
}

function hideOverlay(s, reason) {
  const win = s.win;
  if (!win || win.isDestroyed()) return;
  if (!s.state.visible && !win.isVisible()) return;

  clearIdleTimer(s);
  s.state.visible = false;
  s.flags.cursorHotspot = false;
  s.flags.rendererInteractive = false;
  s.flags.clickThrough = true;

  // 空闲时直接消失：不淡出、立即隐藏（只隐藏，不退出进程，也不 activate）
  if (reason === 'idle') {
    if (s.timers.fade) { clearInterval(s.timers.fade); s.timers.fade = null; }
    win.setOpacity(0);
    win.hide();
    return;
  }

  fadeWindow(s, 0, () => {
    if (s.win && !s.win.isDestroyed()) {
      s.win.hide();
    }
  });
}

function markActivity(s, reason) {
  s.state.lastActivityAt = Date.now();
  if (!s.state.visible) showOverlay(s, reason);
  scheduleIdleHide(s);
}

function setVisibleManual(s, visible) {
  if (visible) {
    // 手动打开视为固定显示，直到再次手动关闭；期间自动隐藏暂停
    s.state.pinned = true;
    clearIdleTimer(s);
    showOverlay(s, 'manual');
  } else {
    s.state.pinned = false;
    clearIdleTimer(s);
    hideOverlay(s, 'manual');
  }
  return { visible: s.state.visible, pinned: s.state.pinned };
}

// ---------- 状态 / 日志 ----------

function pushLog(s, text, kind) {
  const entry = {
    id: ++logSeq,
    ts: Date.now(),
    text: String(text == null ? '' : text).replace(/\s+/g, ' ').trim().slice(0, 1000),
    kind: kind === 'system' ? 'system' : 'action',
  };
  if (!entry.text) return null;

  s.state.logs.push(entry);
  if (s.state.logs.length > MAX_LOGS) s.state.logs.splice(0, s.state.logs.length - MAX_LOGS);
  send(s, 'overlay:log', entry);

  // 只靠 /log 推动的 agent 也应该从「待命」变成「运行中」，但不要覆盖显式的 error。
  // 系统提示（接口就绪、目标窗口切换等）不算 agent 动作，不改变状态点。
  if (entry.kind === 'action' && s.state.activity === 'idle') {
    s.state.activity = 'running';
    send(s, 'overlay:activity', 'running');
  }
  if (entry.kind === 'action') markActivity(s, 'log');
  return entry;
}

const ACTIVITY_STATES = ['idle', 'running', 'error'];

function setStatus(s, text, requestedActivity) {
  const raw = text == null ? '' : String(text);
  // server 把 /status 的 clear:true 转成空字符串写入；普通状态写入不允许空（server 已校验）。
  const isClear = raw === '';
  const next = raw.replace(/\s+/g, ' ').trim().slice(0, 300) || '待命';
  const activity = ACTIVITY_STATES.indexOf(requestedActivity) !== -1
    ? requestedActivity
    : (next === '待命' ? 'idle' : 'running');

  s.state.status = next;
  s.state.activity = activity;
  send(s, 'overlay:status', { text: next, activity: activity });
  // task-27 R4：clear 是复位/收尾，不算活动、不刷新 idle、也不触发显示。
  if (shouldCountStatusActivity({ clear: isClear })) markActivity(s, 'status');
  return { text: next, activity: activity };
}

function signalThumbState(s, force) {
  const payload = {
    state: thumbStateForRenderer(s.state.thumbnail.state),
    windowId: s.state.windowId,
    error: s.state.thumbnail.error,
    updatedAt: s.state.thumbnail.updatedAt,
  };
  const signature = payload.state + '|' + (payload.windowId || '') + '|' + (payload.error || '');
  if (!force && signature === s.lastThumbSignal) return;
  s.lastThumbSignal = signature;
  send(s, 'overlay:thumb-state', payload);
}

// ---------- 截图 ----------

function execFileAsync(file, args, options) {
  return new Promise((resolve, reject) => {
    execFile(file, args, options, (error, stdout, stderr) => {
      if (error) {
        error.stderr = stderr;
        error.stdout = stdout;
        reject(error);
        return;
      }
      resolve({ stdout: stdout, stderr: stderr });
    });
  });
}

// 错误操作：打开系统「屏幕录制」设置，或立刻重试抓帧
function openScreenRecordingSettings() {
  // 用户去设置里授权后回来，下一次抓图能立刻重新预检（不用等 TTL）
  screenPermission.checkedAt = 0;
  const url = 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture';
  shell.openExternal(url).catch(() => {});
}

function retryThumbnailCapture(s) {
  if (!s || !s.win || s.win.isDestroyed()) return;
  s.externalFrameAt = 0; // 允许本地抓帧，别被外部帧的 3 秒接管窗口挡住
  s.lastCaptureError = null;
  screenPermission.checkedAt = 0; // 重试时强制重新预检一次权限
  pushLog(s, '手动重试抓取画面', 'system');
  void captureThumbnail(s);
}

function explainCaptureError(error, titleHealth) {
  if (!error) return '未知错误';
  if (error.killed || error.signal === 'SIGTERM') return 'screencapture 超时';
  if (error.code === 'ENOENT') return '找不到 ' + SCREENSHOT_CMD;

  const stderr = String(error.stderr || '').trim();
  if (/not authorized|permission|denied|screen recording/i.test(stderr)) {
    return '缺少屏幕录制权限';
  }
  // M2：没有屏幕录制权限时 CGWindowList 的标题会全空，此时不要把失败误报成「窗口失效」。
  if (titleHealth && titleHealth.suspectPermission && titleHealth.message) {
    return '抓图失败：' + titleHealth.message;
  }
  if (/could not create image|invalid window|window .*not found|no such window/i.test(stderr)) {
    return '目标窗口已失效';
  }
  if (stderr) {
    const firstLine = stderr.split('\n').filter(Boolean)[0];
    if (firstLine) return firstLine.slice(0, 160);
  }
  return String(error.message || ('screencapture 退出码 ' + error.code));
}

// 抓图前的静默预检：缓存结果，拿不到结论（unknown）时放行，避免卡死抓帧。
async function ensureScreenPermission() {
  const now = Date.now();
  if (screenPermission.checkedAt && now - screenPermission.checkedAt < SCREEN_PERMISSION_TTL_MS) {
    return screenPermission;
  }
  if (!screenPermissionProbe) {
    screenPermissionProbe = platform.checkScreenRecordingPermission()
      .then((probe) => {
        const decision = platform.decideCapturePermission({ granted: probe && probe.granted });
        screenPermission = Object.assign(
          { status: 'unknown', granted: null, message: '' },
          probe || {},
          decision,
          { checkedAt: Date.now() },
        );
        return screenPermission;
      })
      .catch(() => {
        screenPermission = { status: 'unknown', granted: null, message: '', checkedAt: Date.now() };
        return screenPermission;
      })
      .finally(() => { screenPermissionProbe = null; });
  }
  return screenPermissionProbe;
}

// 未授权：不执行 screencapture，直接把会话标成 permission-missing（上层 health 可见）。
function markScreenPermissionMissing(s, permission) {
  const message = (permission && permission.message) || '缺少屏幕录制权限';
  const changed = s.state.thumbnail.state !== 'permission-missing' || s.state.thumbnail.error !== message;
  s.state.thumbnail = Object.assign({}, s.state.thumbnail, {
    state: 'permission-missing',
    error: message,
    updatedAt: Date.now(),
  });
  s.captureFailStreak = 0;
  if (changed) {
    pushLog(s, '缩略图抓取已暂停：' + message + '（静默预检，不弹系统授权框）', 'system');
    signalThumbState(s, true);
  }
}

// 渲染层目前只把 state==='error' 当错误态处理（renderer.js 不在本次写作用域）；
// 对上层 health 保留真实的 permission-missing，对渲染层映射成 error，
// 从而显示「画面不可用：缺少屏幕录制权限」+「打开设置」。
function thumbStateForRenderer(state) {
  return state === 'permission-missing' ? 'error' : state;
}

// 最近 5 帧的平均帧率（帧时间戳间隔）
function frameFps(s) {
  const times = s.frameTimes;
  if (!times || times.length < 2) return 0;
  const span = (times[times.length - 1] - times[0]) / 1000;
  if (!(span > 0)) return 0;
  return Math.round(((times.length - 1) / span) * 10) / 10;
}

function recordFrame(s, bytes) {
  s.frameTimes.push(Date.now());
  if (s.frameTimes.length > 5) s.frameTimes.splice(0, s.frameTimes.length - 5);
  s.frameBytes = Math.max(0, Math.round(bytes || 0));
  s.frameCount = (s.frameCount || 0) + 1;
}

// 目标像素宽度：浮窗现在的宽度 × 2（Retina），上限 1600；放大到 4:3 时会跟着变大
function thumbnailTargetWidth(s) {
  const win = s.win;
  let width = config.width;
  if (win && !win.isDestroyed()) {
    try {
      width = win.getContentSize()[0] || width;
    } catch (error) {
      width = config.width;
    }
  }
  return clamp(Math.round(width * THUMB_SCALE), THUMB_MIN_PIXEL_WIDTH, THUMB_MAX_PIXEL_WIDTH);
}

// dataURL 里的真实图片字节数（base64 长度 ≠ 字节数，别把 base64 长度当 frameBytes）
const imageMeta = require('./image-meta.js');

// 图片头解析、字节数、光标校验都在 overlay/image-meta.js（纯函数，带单测）
// 只读图片头拿宽高（JPEG SOF / PNG IHDR），不整图解码：连续推帧时已知尺寸就不解析，
// 避免每帧 nativeImage 解码拖慢主进程。
const base64DataBytes = imageMeta.base64DataBytes;
const imageSizeFromDataUrl = imageMeta.imageSizeFromDataUrl;
const sanitizeCursor = imageMeta.sanitizeCursor;

// 外部推送的画面（例如 headless CDP 截图）：接管该会话的缩略图，暂停 screencapture。
// 连续推帧时每次都会刷新时间戳/状态，不会被当成「一次性画面」；
// 本地 screencapture 在最后一次外部帧后 3 秒才恢复，期间不会和外部位图抢画面。
function pushExternalFrame(s, dataUrl, note, cursor, width, height) {
  s.externalFrameAt = Date.now();
  // 外部帧接管期间本地抓帧是暂停的；恢复时不要沿用旧的"连续不变"计数，否则一上来就降频
  s.unchangedFrames = 0;
  const prev = s.state.thumbnail || {};

  // 尺寸优先级：调用方显式给 > 上一帧 > 解析图片头 > 未知
  let frameWidth = Number(width) || 0;
  let frameHeight = Number(height) || 0;
  if ((!frameWidth || !frameHeight) && Number(prev.width) > 0 && Number(prev.height) > 0) {
    frameWidth = Number(prev.width);
    frameHeight = Number(prev.height);
  }
  if (!frameWidth || !frameHeight) {
    const parsed = imageSizeFromDataUrl(dataUrl);
    if (parsed) {
      frameWidth = parsed.width;
      frameHeight = parsed.height;
    } else {
      frameWidth = Number(prev.width) || 0;
      frameHeight = Number(prev.height) || 0;
    }
  }

  const safeCursor = sanitizeCursor(cursor);
  const bytes = base64DataBytes(dataUrl);

  s.state.thumbnail = {
    state: 'live',
    dataUrl: dataUrl,
    width: frameWidth,
    height: frameHeight,
    cursor: safeCursor,
    updatedAt: s.externalFrameAt,
    error: null,
    note: note || 'agent',
  };
  recordFrame(s, bytes);
  send(s, 'overlay:thumb', {
    state: 'live',
    dataUrl: dataUrl,
    width: frameWidth,
    height: frameHeight,
    updatedAt: s.externalFrameAt,
    cursor: safeCursor,
  });
  markActivity(s, 'frame');
}

/** 从 JPEG 字节里读宽高（不解码整图），失败返回 null */
const jpegSize = imageMeta.jpegSize;

async function captureThumbnail(s) {
  const win = s.win;
  if (!win || win.isDestroyed() || !s.flags.ready) return;
  // 窗口隐藏时暂停抓帧，显示后补一帧即可。
  // OVERLAY_CAPTURE_WHILE_HIDDEN=1 仅用于自检：隐藏会话也抓帧，这样验证"窗口失效→恢复/解绑"
  // 不用把测试小窗弹到用户屏幕上。
  if (!s.state.visible && !CAPTURE_WHILE_HIDDEN) return;
  // 外部画面接管中（3 秒内有推送）就不再做窗口截图
  if (Date.now() - s.externalFrameAt < 3000) return;
  if (!s.state.windowId || s.flags.capturing || !tempDir) return;

  // M1：抓图前先做静默预检（CGPreflightScreenCaptureAccess 不会弹授权框）。
  // 未授权就直接回 permission-missing，绝不执行 screencapture（避免首次抓帧弹系统框）。
  if (platform.isMac) {
    const permission = await ensureScreenPermission();
    if (!permission.proceed) {
      markScreenPermissionMissing(s, permission);
      return;
    }
  }

  s.flags.capturing = true;
  const captureStartedAt = Date.now();
  // 记下这次抓的是哪个窗口：抓帧期间可能被解绑/换目标，回来时要把结果丢掉
  const captureWindowId = s.state.windowId;
  const slug = String(s.id).replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 40) || 'default';
  const file = path.join(tempDir, 'frame-' + slug + '-' + Date.now() + '-' + (s.thumbSeq++) + '.jpg');
  pendingTempFiles.add(file);

  try {
    let jpeg;
    let frameSize;
    if (platform.isMac) {
      // 直接让 screencapture 输出 JPEG，省掉 nativeImage 的解码 + 重编码（约占单帧六成耗时）
      await execFileAsync(
        SCREENSHOT_CMD,
        ['-x', '-o', '-l', String(s.state.windowId), '-t', 'jpg', file],
        { timeout: CAPTURE_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 }
      );
      const raw = await fs.promises.readFile(file);
      frameSize = jpegSize(raw);
      // 全尺寸帧太大（可达数百 KB），小窗用不到，缩到目标宽度后再编码
      const targetWidth = thumbnailTargetWidth(s);
      if (frameSize.width > targetWidth) {
        const image = nativeImage.createFromBuffer(raw);
        if (!image.isEmpty()) {
          const frame = image.resize({ width: targetWidth, quality: 'good' });
          frameSize = frame.getSize();
          jpeg = frame.toJPEG(THUMB_JPEG_QUALITY);
        } else {
          jpeg = raw;
        }
      } else {
        jpeg = raw;
      }
    } else {
      const bytes = await platform.captureWindow(s.state.windowId, { title: s.state.windowTitle });
      const image = nativeImage.createFromBuffer(bytes);
      if (!image || image.isEmpty()) throw new Error('截图没有产出有效图片');
      const targetWidth = thumbnailTargetWidth(s);
      const original = image.getSize();
      const frame = original.width > targetWidth ? image.resize({ width: targetWidth, quality: 'best' }) : image;
      frameSize = frame.getSize();
      jpeg = frame.toJPEG(THUMB_JPEG_QUALITY);
    }
    if (!jpeg || !jpeg.length) throw new Error('截图没有产出有效图片');
    if (!frameSize || !frameSize.width) frameSize = { width: 0, height: 0 };

    s.state.thumbnail = {
      state: 'live',
      dataUrl: 'data:image/jpeg;base64,' + jpeg.toString('base64'),
      width: frameSize.width,
      height: frameSize.height,
      updatedAt: Date.now(),
      error: null,
    };
    if (s.state.windowId !== captureWindowId) {
      // 窗口在抓帧途中被换掉/解绑：这帧作废，别覆盖新窗口的画面
      return;
    }
    // 纯色帧识别：窗口在别的桌面且没被渲染时，系统会返回一整块纯色（JPEG 压完只有几 KB）。
    // 这种情况既不是抓帧失败、也不是正常画面，单独标出来，别让用户看到一块白。
    if (jpeg.length < BLANK_JPEG_BYTES) {
      // 体积小只说明"压缩率高"，纯黑/纯白的正常窗口也会这样（空文档、黑底终端）。
      // 所以先解码抽样确认真的是整块纯色，避免把正常窗口误标成 offscreen。
      let uniform = false;
      try {
        const probe = nativeImage.createFromBuffer(jpeg);
        if (probe && !probe.isEmpty()) {
          uniform = imageMeta.looksUniform(probe.toBitmap(), { threshold: 10 }).uniform;
        }
      } catch (error) {
        uniform = false;
      }
      if (uniform) {
        s.state.thumbnail.state = 'offscreen';
        s.state.thumbnail.error = '窗口在其它桌面，画面暂时不可见（仍可在后台操作）';
        s.lastCaptureError = null;
        s.captureFailStreak = 0;
        s.captureMs = Date.now() - captureStartedAt;
        signalThumbState(s);
        return;
      }
      // 不是纯色 → 是正常的小体积画面，继续按正常帧处理
    }
    s.lastCaptureError = null;
    s.captureFailStreak = 0;
    s.captureMs = Date.now() - captureStartedAt;
    // 画面没变化就降频：内容完全相同的帧按 2 倍周期退避，有变化立刻回到满帧率
    const hash = require('node:crypto').createHash('md5').update(jpeg).digest('hex');
    if (hash === s.lastFrameHash) s.unchangedFrames = (s.unchangedFrames || 0) + 1;
    else { s.unchangedFrames = 0; }
    s.lastFrameHash = hash;
    recordFrame(s, jpeg.length);

    send(s, 'overlay:thumb', {
      dataUrl: s.state.thumbnail.dataUrl,
      width: frameSize.width,
      height: frameSize.height,
      updatedAt: s.state.thumbnail.updatedAt,
      windowId: s.state.windowId,
    });
    signalThumbState(s);
  } catch (error) {
    // 窗口在抓帧途中被解绑/换目标：这是旧目标失败，不该报在当前会话上
    // （否则会出现"已经解绑了，却还挂着目标窗口已失效"的残留）
    if (s.state.windowId !== captureWindowId) return;
    const message = explainCaptureError(error, windowTitleHealth);
    // 偶发失败（窗口刚切换、系统瞬时不给出图像）很常见：screencapture 会报
    // "could not create image from window"，但下一次通常就好了。
    // 连续失败到阈值才切错误态，中间保留上一帧，避免"红字闪一下"。
    s.captureFailStreak = (s.captureFailStreak || 0) + 1;
    if (s.captureFailStreak >= CAPTURE_FAIL_TOLERANCE) {
      s.state.thumbnail.state = 'error';
      s.state.thumbnail.error = message;
      if (message !== s.lastCaptureError) {
        s.lastCaptureError = message;
        const raw = String((error && error.stderr) || (error && error.message) || '').trim().split('\n')[0].slice(0, 140);
        console.error('[overlay] 抓帧失败 streak=' + s.captureFailStreak + ' 窗口=' + s.state.windowId + ' 原因=' + message + (raw && raw !== message ? '｜原始：' + raw : ''));
        pushLog(s, '缩略图捕获失败（连续 ' + s.captureFailStreak + ' 次）：' + message, 'system');
      }
      signalThumbState(s);
      recoverTarget(s).catch(() => {});
    }
  } finally {
    pendingTempFiles.delete(file);
    fs.promises.unlink(file).catch(() => {});
    s.flags.capturing = false;
  }
}

function stopThumbnailLoop(s) {
  if (s.timers.thumb) {
    clearTimeout(s.timers.thumb);
    s.timers.thumb = null;
  }
}

function startThumbnailLoop(s) {
  stopThumbnailLoop(s);

  if (!s.state.windowId) {
    // 没有本地目标窗口，但正在收外部帧（headless/CDP）：保留 live 状态，别被 no-window 覆盖
    const externalActive = s.externalFrameAt && Date.now() - s.externalFrameAt < 3000;
    if (!externalActive) {
      s.state.thumbnail.state = 'no-window';
      signalThumbState(s, true);
    } else {
      signalThumbState(s, true);
    }
    return;
  }

  if (s.state.thumbnail.state !== 'live') {
    s.state.thumbnail.state = 'waiting';
    s.state.thumbnail.error = null;
  }
  signalThumbState(s, true);

  // 自调度：上一帧结束后再按「目标周期 - 本帧耗时」安排下一帧。
  // 用固定 setInterval 时，抓帧一旦超过周期就会被跳过一轮，实际帧率掉到一半；
  // 自调度可以把「抓一帧 + 编码」串起来，实际帧率稳定在 1000/单帧耗时。
  const period = Math.max(33, Math.round(1000 / config.fps));
  const tick = () => {
    if (!s.timers.thumb) return;
    const startedAt = Date.now();
    void captureThumbnail(s).finally(() => {
      if (!s.timers.thumb) return;
      const streak = s.captureFailStreak || 0;
      // 刚绑定窗口时系统可能连续几次"给不出图像"（窗口长期被遮挡后要补画），
      // 这段时间用 120ms 快速重试，比等一个完整周期更快出画面；到阈值后恢复正常节奏。
      if (streak > 0 && streak < CAPTURE_FAIL_TOLERANCE) {
        s.timers.thumb = setTimeout(tick, 120);
        return;
      }
      // 画面静止时按 2 倍退避降频（最多 1 秒一帧），有人看的是"变了没有"而不是"多少帧"
      // 下限 500ms（2fps）：静止时省 CPU，但用户盯着看时画面变化最多半秒就能看到
      const idleDelay = nextCaptureDelay({ unchangedFrames: s.unchangedFrames || 0, basePeriod: period, maxPeriod: 500 });
      const delay = Math.max(0, idleDelay - (Date.now() - startedAt));
      s.timers.thumb = setTimeout(tick, delay);
    });
  };
  s.timers.thumb = setTimeout(tick, 0);
}

// ---------- 窗口 ----------

function setWindowId(s, raw, source, title) {
  const id = normalizeWindowId(raw);
  if (!id) {
    // 传 null / 非法值 = 解绑：必须把旧的错误态一起清掉，否则会一直显示上次的「目标窗口已失效」。
    // 即使之前已经解绑过（windowId 已是 null）也要清：任务结束时可能只剩一条陈旧的抓帧错误。
    const hadWindow = s.state.windowId !== null;
    const hadError = Boolean(s.state.thumbnail.error);
    s.state.windowId = null;
    s.state.windowTitle = '';
    s.state.thumbnail.state = 'no-window';
    s.state.thumbnail.error = null;
    s.lastCaptureError = null;
    s.lastThumbSignal = '';
    stopThumbnailLoop(s);
    signalThumbState(s, true);
    if (hadWindow && (raw === null || raw === undefined || raw === '')) {
      pushLog(s, '已解绑缩略图目标窗口', 'system');
    } else if (hadError) {
      pushLog(s, '已清除上一条抓帧错误', 'system');
    }
    return null;
  }

  if (selfWindowIds.has(id)) {
    pushLog(s, '拒绝绑定 DeepSeek Harness 自身窗口（' + id + '），请指定被控应用窗口', 'system');
    return null;
  }

  if (id === s.state.windowId && s.state.thumbnail.state === 'live') {
    signalThumbState(s, true);
    return id;
  }

  s.state.windowId = id;
  // Windows 抓图要 HWND：用窗口标题反查，标题由 /window 请求一起传
  s.state.windowTitle = typeof title === 'string' ? title : '';
  s.state.thumbnail.state = 'waiting';
  s.state.thumbnail.error = null;
  s.lastThumbSignal = '';
  s.lastCaptureError = null;

  s.unchangedFrames = 0;
  s.lastFrameHash = null;
  pushLog(s, '缩略图目标窗口 → ' + id + (source ? '（' + source + '）' : ''), 'system');
  markActivity(s, 'window');
  startThumbnailLoop(s);
  rememberTargetHint(s, id);
  return id;
}

/** 记下这次绑定窗口的 owner/title：窗口关掉重开后靠它找回同一个应用 */
async function rememberTargetHint(s, id) {
  try {
    const list = await listWindows();
    const hit = (list || []).find((w) => w.windowId === id);
    if (hit) s.lastTargetHint = { windowId: id, owner: hit.owner, title: hit.title };
  } catch {}
}

/**
 * 抓帧连续失败时的恢复：先尝试按 owner/title 找回同一个应用的新窗口，
 * 找不到就解绑（而不是一直卡在 error）。
 */
async function recoverTarget(s) {
  if (s.recovering) return;
  s.recovering = true;
  try {
    const list = await listWindows().catch(() => null);
    if (!list) return;
    const exclude = new Set();
    if (s.state.windowId) exclude.add(s.state.windowId);
    const cand = pickReplacementWindow(list, s.lastTargetHint, { excludeIds: exclude, selfIds: selfWindowIds });
    if (cand && cand.windowId !== s.state.windowId) {
      pushLog(s, '目标窗口失效，自动重新绑定到 ' + cand.windowId + '（' + (cand.owner || '') + '）', 'system');
      setWindowId(s, cand.windowId, 'auto-recover', cand.title || '');
      return;
    }
    pushLog(s, '目标窗口已失效，已解绑（窗口重开后请重新绑定）', 'system');
    setWindowId(s, null, 'auto-recover');
    // setWindowId 的显式解绑会把错误清空，但这里是「因为失效才解绑」：
    // 清成干净的空状态会让用户以为只是没绑窗口，不知道为什么没画面。
    // 留一条能看懂的话（state 仍是 no-window，错误文案只解释原因）。
    s.state.thumbnail.state = 'no-window';
    s.state.thumbnail.error = '目标窗口已失效，已自动解绑；如果应用还开着，请重新选择窗口';
    signalThumbState(s, true);
  } finally {
    s.recovering = false;
  }
}

async function refreshSelfWindows() {
  try {
    await listWindows();
  } catch (error) {
    // 取不到窗口列表时不阻塞绑定流程
  }
}

// macOS：用 CGWindowList 列「所有」窗口。Electron 的 desktopCapturer 只给当前桌面，
// 而别的桌面的窗口其实是可以抓图的（screencapture -l 实测可行），所以要自己列。
function listWindowsMac() {
  return new Promise((resolve) => {
    const script =
      'ObjC.import("CoreGraphics");' +
      'const arr=ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionAll,0));' +
      'const out=[];' +
      'for (let i=0;i<arr.count;i++){' +
      '  try {' +
      '    const d=arr.objectAtIndex(i);' +
      '    const layer=Number(ObjC.unwrap(d.objectForKey("kCGWindowLayer")));' +
      '    if (layer !== 0) continue;' +
      '    const b=ObjC.deepUnwrap(d.objectForKey("kCGWindowBounds"));' +
      '    const w=Number(b.Width), h=Number(b.Height);' +
      '    if (!(w > 200) || !(h > 120)) continue;' +
      '    out.push({' +
      '      windowId:Number(ObjC.unwrap(d.objectForKey("kCGWindowNumber"))),' +
      '      pid:Number(ObjC.unwrap(d.objectForKey("kCGWindowOwnerPID"))||0),' +
      '      owner:String(ObjC.unwrap(d.objectForKey("kCGWindowOwnerName"))||""),' +
      '      title:String(ObjC.unwrap(d.objectForKey("kCGWindowName"))||""),' +
      '      onscreen:Number(ObjC.unwrap(d.objectForKey("kCGWindowIsOnscreen"))||0)=== 1,' +
      '      x:w, h:h' +
      '    });' +
      '  } catch(e){}' +
      '}' +
      'JSON.stringify(out);';
    execFile('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script], { timeout: 4000 }, (error, stdout) => {
      if (error) return resolve(null);
      try {
        const list = JSON.parse(String(stdout));
        if (!Array.isArray(list)) return resolve(null);
        // M2：CGWindowList 的窗口标题是判断屏幕录制权限的旁证；全空/大量为空时单独报权限，
        // 与「窗口真的不存在/匹配失败」区分开。
        const titleStats = platform.classifyWindowTitles({ titles: list.map((item) => item && item.title) });
        windowTitleHealth = Object.assign({ checkedAt: Date.now() }, titleStats);
        resolve(list);
      } catch { resolve(null); }
    });
  });
}

async function listWindows() {
  if (platform.isMac) {
    const macList = await listWindowsMac();
    if (macList) {
      const windows = [];
      for (const item of macList) {
        const owner = String(item.owner || '');
        const title = String(item.title || '');
        // 自己和宿主不算「被控目标」；其余所有应用窗口都列出来（含其它桌面）
        const ownOverlay = /Desktop Agent|^Electron$/i.test(owner);
        const isSelf = ownOverlay || owner === HOST_PROCESS || SELF_WINDOW_PATTERN.test(title);
        if (isSelf) { selfWindowIds.add(item.windowId); continue; }
        windows.push({
          windowId: item.windowId,
          sourceId: 'window:' + item.windowId + ':0',
          title: title || owner,
          owner: owner,
          // pid 是跨语言匹配的可靠依据：窗口 owner 名是本地化的（Finder → 访达），按名字匹配会漏
          pid: Number(item.pid) || 0,
          onscreen: Boolean(item.onscreen),
          self: false,
        });
      }
      return windows;
    }
  }

  const sources = await desktopCapturer.getSources({
    types: ['window'],
    thumbnailSize: { width: 1, height: 1 },
    fetchWindowIcons: false,
  });

  const windows = [];
  for (const source of sources) {
    const match = /^window:(\d+):\d+$/.exec(source.id);
    if (!match) continue;
    const windowId = Number(match[1]);
    const title = source.name || '';
    if (SELF_WINDOW_PATTERN.test(title)) selfWindowIds.add(windowId);
    windows.push({ windowId, sourceId: source.id, title, self: selfWindowIds.has(windowId) });
  }
  return windows;
}

function initialWindowPosition(s) {
  const workArea = screen.getPrimaryDisplay().workArea;
  const col = s.index % 3;
  const row = Math.floor(s.index / 3);
  return {
    x: Math.round(workArea.x + workArea.width - config.width - config.margin - col * (config.width + TILE_GAP)),
    y: Math.round(workArea.y + config.margin + row * (config.height + TILE_GAP)),
  };
}

function createWindowForSession(s) {
  const pos = initialWindowPosition(s);

  const win = new BrowserWindow({
    width: config.width,
    height: config.height,
    x: pos.x,
    y: pos.y,
    minWidth: 250,
    minHeight: 160,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: true,
    resizable: true,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: false,
    skipTaskbar: true,
    roundedCorners: true,
    title: 'Desktop Agent · ' + s.id,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      backgroundThrottling: false,
    },
  });

  s.win = win;
  s.flags.ready = false;

  // 渲染进程崩溃（GPU 驱动、内存不足、页面脚本异常都可能导致）：不要整个小窗跟着死，
  // 记录一次并通过 /health 暴露，然后把这个会话的窗口重新加载起来。
  win.webContents.on('render-process-gone', (_event, details) => {
    noteCrash('render-process-gone', (details && (details.reason + '/' + details.exitCode)) || '');
    if (!sessions.has(s.id) || !s.win || s.win.isDestroyed()) return;
    // 重载要限次：坏页面会一启动就崩，无脑重载会变成无限崩溃循环
    s.crashTimes = (Array.isArray(s.crashTimes) ? s.crashTimes : []).concat(Date.now());
    const now = Date.now();
    const decision = shouldReloadAfterCrash(s.crashTimes, now);
    s.crashTimes = s.crashTimes.filter((t) => now - t <= 60000);
    if (!decision.reload) {
      noteCrash('render-crash-loop', s.id + '：' + decision.reason);
      if (s.state && s.state.thumbnail) {
        s.state.thumbnail = Object.assign({}, s.state.thumbnail, { state: 'error', error: '渲染进程反复崩溃，已停止自动重载' });
      }
      return;
    }
    setTimeout(() => {
      try { if (!s.win.isDestroyed()) s.win.reload(); } catch {}
    }, 800);
  });
  win.webContents.on('unresponsive', () => noteCrash('renderer-unresponsive', s.id));

  // 层级：只用 floating（浮在普通窗口上，低于菜单/屏保），不用 screen-saver 全局置顶。
  // 配合「DSH 不是前台就 hide」，效果是只浮在 DSH 上面，不会盖住别的 App。
  // 注意：不要在窗口还没 show 的时候调 setVisibleOnAllWorkspaces(false)，
  // 那会把后创建的窗口绑到一个不存在的“应用最后活跃 Space”，窗口看似 isVisible=true
  // 但 CGWindowList 里 onscreen=0，屏幕上根本看不到。默认行为就是不跟随 Space。
  win.setAlwaysOnTop(true, 'floating');

  win.loadFile(path.join(__dirname, 'index.html'));
  win.webContents.on('did-fail-load', (_e, code, desc) => console.log('[overlay] did-fail-load ' + s.id + ' ' + code + ' ' + desc));
  win.once('ready-to-show', () => {
    if (!s.win || s.win.isDestroyed() || s.win !== win) return;
    s.flags.ready = true;
    // 不能无条件 showInactive：新建会话窗口的那一刻，用户可能正在别的应用/别的 Space，
    // 一冒出来就看得见。只有「宿主可见 + 快照新鲜 + 前台匹配 + 标题匹配 + 这个会话真的有活动」才显示。
    // task-27 R2：未知前台/未知标题一律 fail-closed（原来 front 为空、dshTitle 为空会放行）。
    maybeAutoBindTitle(s);
    const hasActivity = Boolean(s.state.lastActivityAt || s.state.pinned);
    // 独立使用模式（OVERLAY_ATTACH_DSH=0）没有宿主可门控，只保留「有活动才显示」
    const allow = !ATTACH_TO_DSH
      ? hasActivity
      : shouldShowOnReady({
        hostVisible,
        hostStale: hostBoundsStale,
        hostCheckedAt,
        now: Date.now(),
        maxHostAgeMs: HOST_SNAPSHOT_MAX_AGE_MS,
        front: frontmostBundle || '',
        hostBundles: HOST_BUNDLES,
        self: SELF_BUNDLE,
        titleKnown: Boolean(dshTitle),
        titleMatched: !s.titleHint || titleMatches(s),
        hasActivity: hasActivity,
      });
    if (!allow) {
      win.setOpacity(0);
      win.hide();
      s.state.visible = false;
      s.flags.suppressBySession = true;  // 条件恢复时由 attach 循环依据 pinned/空闲窗口决定是否重新出现
      requestAttachRefresh();
      return;
    }
    win.setOpacity(0);
    win.showInactive(); // 不 activate、不抢焦点
    applyClickThrough(s); // 默认整窗穿透
    s.state.visible = true;
    s.flags.suppressBySession = false;
    s.state.lastActivityAt = Date.now();
    fadeWindow(s, 1);
    scheduleIdleHide(s);
    startThumbnailLoop(s);
  });

  // 用户拖动：停止自动跟随，并把窗口限制在 DSH 窗口范围内
  win.on('move', () => {
    if (s.flags.settingBounds || s.flags.expanded || s.win !== win || win.isDestroyed()) return;
    s.flags.followDsh = false;
    if (dshBounds) {
      clampIntoDsh(s);
    } else {
      readDshBounds().then((b) => {
        if (b) {
          dshBounds = b;
          clampIntoDsh(s);
        }
      }).catch(() => {});
    }
  });

  win.on('closed', () => {
    if (s.win === win) s.win = null;
    stopSessionTimers(s);
    if (sessions.get(s.id) === s) sessions.delete(s.id);
  });

  return win;
}

// ---------- 会话快照 ----------

function boundsOf(s) {
  const win = s.win;
  if (!win || win.isDestroyed()) return null;
  try {
    return win.getBounds();
  } catch (error) {
    return null;
  }
}

// 当前窗口需要多大的帧：收起 300pt→600px，放大 960pt→1920px，上限 2560
function frameTargetOf(s) {
  let width = config.width;
  let height = config.height;
  const win = s.win;
  if (win && !win.isDestroyed()) {
    try {
      const size = win.getContentSize();
      if (size && size[0] > 0 && size[1] > 0) { width = size[0]; height = size[1]; }
    } catch (error) {
      // 窗口销毁瞬间读不到，用默认值
    }
  }
  const size = computeFrameTarget(width, height, {
    scale: THUMB_SCALE,
    min: THUMB_MIN_PIXEL_WIDTH,
    max: THUMB_MAX_PIXEL_WIDTH,
  });
  return { width: size.width, height: size.height, expanded: Boolean(s.flags.expanded) };
}

function sessionHealth(s) {
  return {
    session: s.id,
    label: s.titleHint ? normalizeDshTitle(s.titleHint, HOST_TITLE_SUFFIX) : '',
    exists: true,
    pid: process.pid,
    error: serverError || null,
    createdAt: s.createdAt,
    status: s.state.status,
    activity: s.state.activity,
    visible: s.state.visible,
    idleMs: config.idleHideMs,
    pinned: s.state.pinned,
    expanded: s.flags.expanded,
    hovering: s.flags.hovering,
    clickThrough: Boolean(s.flags.clickThrough),
    screenLocked: platform.isScreenLocked(),
    lastActivityAt: s.state.lastActivityAt,
    hardHideMs: HARD_HIDE_MS,
    windowId: s.state.windowId,
    titleHint: s.titleHint || null,
    matched: Boolean(s.matched),
    dshTitle: dshTitle || null,
    hostKind: hostKind,
    hostVisible: Boolean(hostVisible),
    hostBoundsStale: Boolean(hostBoundsStale),
    hostPoll: { lastAt: lastAttachAt || null, intervalMs: lastAttachIntervalMs, busy: attachBusy },
    frontmost: frontmostBundle,
    logs: s.state.logs.length,
    fps: frameFps(s),
    frameBytes: s.frameBytes,
    frames: s.frameCount || 0,
    captureMs: s.captureMs,
    frameWidth: Number(s.state.thumbnail.width) || 0,
    frameHeight: Number(s.state.thumbnail.height) || 0,
    bounds: boundsOf(s),
    thumbnail: {
      state: s.state.thumbnail.state,
      updatedAt: s.state.thumbnail.updatedAt,
      error: s.state.thumbnail.error,
    },
  };
}

function missingSessionHealth(id) {
  return {
    session: id,
    exists: false,
    createdAt: null,
    status: '待命',
    activity: 'idle',
    visible: false,
    idleMs: config.idleHideMs,
    pinned: false,
    expanded: false,
    hovering: false,
    clickThrough: true,
    lastActivityAt: null,
    hardHideMs: HARD_HIDE_MS,
    windowId: null,
    titleHint: null,
    matched: false,
    dshTitle: dshTitle || null,
    hostKind: hostKind,
    hostVisible: Boolean(hostVisible),
    hostBoundsStale: Boolean(hostBoundsStale),
    logs: 0,
    fps: 0,
    frameBytes: 0,
    frames: 0,
    captureMs: 0,
    frameWidth: 0,
    frameHeight: 0,
    bounds: null,
    thumbnail: { state: 'no-window', updatedAt: null, error: null },
  };
}

// 渲染进程启动时拿的完整快照（含日志正文与最后一帧）
function rendererSnapshot(s) {
  return {
    session: s.id,
    // 给人看的标签：优先用会话标题，其次才退回内部 session id（非默认会话悬停时显示）
    label: s.titleHint ? normalizeDshTitle(s.titleHint, HOST_TITLE_SUFFIX) : '',
    status: s.state.status,
    activity: s.state.activity,
    visible: s.state.visible,
    logs: s.state.logs,
    windowId: s.state.windowId,
    expanded: s.flags.expanded,
    thumbnail: Object.assign({}, s.state.thumbnail, { state: thumbStateForRenderer(s.state.thumbnail.state) }),
    bounds: boundsOf(s),
    server: {
      host: config.host,
      port: config.port,
      running: Boolean(overlayServer && overlayServer.address),
      sessions: sessionCount(),
    },
    limits: { maxLogs: MAX_LOGS, maxSessions: MAX_SESSIONS },
  };
}

// ---------- HTTP ----------

async function startServer() {
  overlayServer = createOverlayServer({
    host: config.host,
    port: config.port,
    // 本地控制面票据：启动时确保存在（600 权限），所有请求都要带
    token: ensureTokenSync(),
    handlers: {
      onLog: (session, text, titleHint) => {
        const s = ensureSession(session, 'HTTP /log');
        setTitleHint(s, titleHint);
        maybeAutoBindTitle(s);
        return pushLog(s, text, 'action');
      },
      onStatus: (session, text, requestedActivity, titleHint) => {
        const s = ensureSession(session, 'HTTP /status');
        setTitleHint(s, titleHint);
        maybeAutoBindTitle(s);
        return setStatus(s, text, requestedActivity);
      },
      onWindow: async (session, raw, title) => {
        const s = ensureSession(session, 'HTTP /window');
        // task-27 R5：/window 也是首活动的常见入口，先用当前宿主标题自动绑定会话标题，避免绕过标题门控
        maybeAutoBindTitle(s);
        await refreshSelfWindows();
        const id = normalizeWindowId(raw);
        const result = setWindowId(s, raw, 'HTTP /window', title);
        if (!result && id && selfWindowIds.has(id)) {
          const error = new Error('拒绝绑定 DeepSeek Harness 自身窗口（' + id + '），请指定被控应用窗口');
          error.statusCode = 403;
          throw error;
        }
        return result;
      },
      onVisible: (session, visible) => {
        const s = ensureSession(session, 'HTTP /visible');
        // task-27 R5：/visible 是首活动入口之一，先自动绑定标题
        maybeAutoBindTitle(s);
        return setVisibleManual(s, visible);
      },
      onFrame: (session, dataUrl, note, cursor, width, height) => {
        const s = ensureSession(session, 'HTTP /frame');
        // task-27 R5：/frame 是首活动入口之一，先自动绑定标题
        maybeAutoBindTitle(s);
        return pushExternalFrame(s, dataUrl, note, cursor, width, height);
      },
      onExpand: (session) => toggleExpand(ensureSession(session, 'HTTP /expand')),
      stopTask: (session) => stopBackgroundTask(sessions.get(session) || null),
      close: (session) => closeSession(session),
      frameTarget: (session) => {
        const s = sessions.get(session);
        if (!s) return { width: config.width * THUMB_SCALE, height: config.height * THUMB_SCALE, expanded: false };
        return frameTargetOf(s);
      },
      sessions: () => Array.from(sessions.values()).map(sessionHealth),
      health: (session) => {
        const s = sessions.get(session);
        return Object.assign(s ? sessionHealth(s) : missingSessionHealth(session), {
          crash: crashLog.get(),
          supervisor: supervisor.status(),
          // M1/M2：抓图失败的权限原因与「窗口标题全空」分开报，便于排障
          screenRecording: {
            status: screenPermission.status,
            granted: screenPermission.granted,
            message: screenPermission.message,
            checkedAt: screenPermission.checkedAt || 0,
          },
          windowTitles: {
            status: windowTitleHealth.status,
            total: windowTitleHealth.total,
            empty: windowTitleHealth.empty,
            emptyRatio: windowTitleHealth.emptyRatio,
            suspectPermission: windowTitleHealth.suspectPermission,
            message: windowTitleHealth.message,
            checkedAt: windowTitleHealth.checkedAt || 0,
          },
        });
      },
      windows: listWindows,
    },
  });

  try {
    const address = await overlayServer.listen();
    const message = 'HTTP 接口就绪：http://' + address.address + ':' + address.port + '（多会话模式）';
    const def = sessions.get(DEFAULT_SESSION);
    if (def) pushLog(def, message, 'system');
    console.log('[overlay] ' + message);
  } catch (error) {
    const message = error && error.code === 'EADDRINUSE'
      ? '端口 ' + config.port + ' 已被占用'
      : String((error && error.message) || error);
    serverError = message;
    const def = sessions.get(DEFAULT_SESSION);
    if (def) pushLog(def, 'HTTP 监听失败：' + message, 'system');
    console.error('[overlay] HTTP 监听失败：' + message);
  }
}

// ---------- 放大 / IPC / 生命周期 ----------

function toggleExpand(s) {
  const win = s.win;
  if (!win || win.isDestroyed()) return { expanded: false };
  // task-27 R6：窗口不可见时忽略展开，避免隐藏态先落盘 expanded、下次合法显示直接变成大窗。
  // 折叠（expanded=true → false）始终允许，避免窗口卡在放大态。
  if (shouldIgnoreExpand({ visible: s.state.visible, expanded: s.flags.expanded })) {
    return { expanded: false, ignored: true };
  }
  if (!s.flags.expanded) {
    const bounds = win.getBounds();
    s.flags.smallBounds = { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
    const display = screen.getDisplayMatching({ x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height });
    const area = display.workArea;
    // 按最近一帧画面的宽高比放大，避免 4:3 硬编码导致上下/左右黑边；没有画面时回退 4:3
    const frameW = Number(s.state.thumbnail.width) || 0;
    const frameH = Number(s.state.thumbnail.height) || 0;
    const aspect = frameW > 0 && frameH > 0 ? frameH / frameW : 0.75;
    let width = Math.min(960, Math.round(area.width * 0.72));
    let height = Math.round(width * aspect);
    const maxHeight = Math.round(area.height * 0.92);
    if (height > maxHeight) {
      height = maxHeight;
      width = Math.round(height / aspect);
    }
    width = Math.max(360, Math.round(width));
    height = Math.max(200, Math.round(height));
    const nx = Math.round(area.x + (area.width - width) / 2);
    const ny = Math.round(area.y + (area.height - height) / 2);
    if (s.flags.settingBounds) return { expanded: false };
    // 先置 expanded 再改 bounds：move 事件里不会再被吸回/夹回 DSH
    s.flags.expanded = true;
    clearIdleTimer(s); // 放大期间用户在看全貌，暂停自动隐藏
    s.flags.settingBounds = true;
    win.setBounds({ x: nx, y: ny, width, height });
    setTimeout(() => { s.flags.settingBounds = false; }, 150);
  } else {
    if (s.flags.smallBounds) win.setBounds(s.flags.smallBounds);
    s.flags.expanded = false;
    // 折叠回小窗时也要用「真实前台」，不能写死宿主 bundle：
    // 写死会让 frontOk 恒为 true，用户切走了小窗还以为宿主在前台。
    setTimeout(() => {
      readFrontmostBundle()
        .then((frontNow) => attachToDsh(s, frontNow || frontmostBundle, dshBounds))
        .catch(() => {});
    }, 100);
    scheduleIdleHide(s);
  }
  return { expanded: s.flags.expanded };
}

// 停止后台任务：小窗上的「■」按钮和 POST /stop-task 都走这里
async function stopBackgroundTask(s) {
  // 小窗是 CJS，不能 import ESM 的 core/ports.mjs，这里保持同样的优先级：AGENTD_URL > AGENTD_PORT > 默认
  const daemonBase = String(process.env.AGENTD_URL || '').trim().replace(/\/+$/, '')
    || ('http://127.0.0.1:' + (Number(process.env.AGENTD_PORT) || 7789));
  const url = daemonBase + '/stop';
  try {
    // daemon 的写接口要票据 + JSON Content-Type；之前这里两样都没带，点「■」其实一直 401。
    // AGENTD_URL 可自定义：token 只跟回环地址走，非回环默认不发（M-5）。
    const res = await fetch(url, {
      method: 'POST',
      headers: tokenHeadersFor(url, { 'Content-Type': 'application/json' }),
      body: '{}',
      signal: AbortSignal.timeout(2000),
    });
    const data = await res.json().catch(() => null);
    const stopped = Boolean(data && data.stopped);
    if (s) {
      pushLog(s, stopped ? '已请求停止当前任务（等待进程退出）' : '没有正在运行的任务', 'action');
      setStatus(s, stopped ? '正在停止任务…' : '待命', stopped ? 'running' : 'idle');
    }
    return { ok: Boolean(res.ok), stopped: stopped };
  } catch (error) {
    if (s) pushLog(s, '停止任务失败：' + String(error && error.message || error).slice(0, 60), 'system');
    return { ok: false, error: String(error && error.message || error) };
  }
}

function sessionFromEvent(event) {
  for (const s of sessions.values()) {
    if (s.win && !s.win.isDestroyed() && s.win.webContents === event.sender) return s;
  }
  return null;
}

function registerIpc() {
  ipcMain.handle('overlay:get-state', (event) => {
    const s = sessionFromEvent(event);
    return s ? rendererSnapshot(s) : null;
  });

  ipcMain.handle('overlay:toggle-expand', (event) => {
    const s = sessionFromEvent(event);
    return s ? toggleExpand(s) : { expanded: false };
  });

  ipcMain.on('overlay:hover', (event, value) => {
    const s = sessionFromEvent(event);
    if (!s) return;
    s.flags.hovering = Boolean(value);
    if (s.flags.hovering) clearIdleTimer(s);
    else scheduleIdleHide(s);
  });

  ipcMain.on('overlay:interactive', (event, value) => {
    const s = sessionFromEvent(event);
    if (!s) return;
    s.flags.rendererInteractive = Boolean(value);
    applyClickThrough(s);
  });

  // 渲染进程状态条上的错误操作按钮是否可见：只有可见时才把底部区域设为可点击热区
  ipcMain.on('overlay:action', (event, value) => {
    const s = sessionFromEvent(event);
    if (!s) return;
    s.flags.hasAction = Boolean(value);
  });

  ipcMain.on('overlay:fix', (event, kind) => {
    const s = sessionFromEvent(event);
    if (!s) return;
    if (kind === 'settings') openScreenRecordingSettings();
    else retryThumbnailCapture(s);
  });

  ipcMain.on('overlay:stop-task', (event) => {
    const s = sessionFromEvent(event);
    stopBackgroundTask(s).catch(() => {});
  });

  ipcMain.on('overlay:close', (event) => {
    const s = sessionFromEvent(event);
    if (s) closeSession(s.id);
  });
}

function cleanup() {
  if (cleanedUp) return;
  cleanedUp = true;

  for (const s of sessions.values()) stopSessionTimers(s);
  sessions.clear();

  stopHideGuard();
  stopCursorWatch();
  if (sessionSweepTimer) { clearInterval(sessionSweepTimer); sessionSweepTimer = null; }

  stopAttachLoop();

  if (overlayServer) {
    overlayServer.close().catch(() => {});
    overlayServer = null;
  }

  if (tempDir) {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (error) {
      // 退出阶段忽略清理失败
    }
    tempDir = null;
  }
  pendingTempFiles.clear();
}

async function boot() {
  if (!config.showDock) {
    // 让 app 以 accessory 身份运行：不出现 Dock 图标，也不会在启动时抢焦点。
    if (typeof app.setActivationPolicy === 'function') app.setActivationPolicy('accessory');
    if (app.dock && typeof app.dock.hide === 'function') app.dock.hide();
  }

  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-agent-overlay-'));

  registerIpc();

  // 默认会话在启动时就创建，保持旧版「启动即有小窗」的行为；其它会话按需创建。
  const def = ensureSession(DEFAULT_SESSION, '启动');
  startAttachLoop();
  startHideGuard();
  startCursorWatch();
  startSessionSweep();

  // 启动时先扫一遍窗口，填充 selfWindowIds，避免把小窗绑到 DeepSeek Harness 自己身上；
  // 顺便刷新 windowTitles 健康（M2）并静默探测一次屏幕录制权限（M1，不会弹框）。
  listWindows().catch(() => {});
  ensureScreenPermission().catch(() => {});

  pushLog(
    def,
    def.state.windowId
      ? 'overlay 启动（多会话），目标窗口 ' + def.state.windowId
      : 'overlay 启动（多会话），尚未指定目标窗口（可 POST /window 设置）',
    'system'
  );

  await startServer();
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    // 不 activate 已有窗口：overlay 永远不抢焦点。
  });

  app.whenReady()
    .then(async () => {
      // 先把后台 daemon 带起来：打包后用户只需打开这一个 App
      const sup = await supervisor.startDaemon();
      if (sup.ok) console.log('[overlay] daemon 就绪', sup.reused ? '(复用已有)' : 'pid=' + sup.pid);
      else console.error('[overlay] daemon 启动失败：' + sup.error);
      return boot();
    })
    .catch((error) => {
      console.error('[overlay] 启动失败', error);
      app.quit();
    });
}

// 渲染/子进程崩溃要留痕：/health 里能看到最后一次崩溃原因，
// 排障时不用猜「小窗没出现」是没绑上窗口还是崩了。
app.on('child-process-gone', (_event, details) => {
  noteCrash('child-process-gone', (details && (String(details.type || '') + '/' + String(details.reason || ''))) || '');
});
process.on('uncaughtException', (error) => {
  noteCrash('uncaughtException', (error && error.stack) || error);
});
process.on('unhandledRejection', (error) => {
  noteCrash('unhandledRejection', (error && error.stack) || error);
});

app.on('before-quit', () => {
  try { supervisor.stopDaemon(); } catch {}
  cleanup();
});

// 多会话模式：关掉所有窗口不退出进程，HTTP 服务继续运行；
// 下一条带 session 的请求会重新召唤对应的小窗，不影响其它会话。
app.on('window-all-closed', () => {
  console.log('[overlay] 所有会话窗口已关闭，HTTP 服务继续运行，等待新的 session');
});