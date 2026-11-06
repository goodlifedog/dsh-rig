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
const { normalizeDshTitle, matchesTitle } = require('./session-gate.js');
const { createOverlayServer, DEFAULT_SESSION, SESSION_PATTERN } = require('./server.js');
const { normalizeWindowId, resolveWindowId } = require('./window-id.js');

const APP_NAME = 'desktop-agent-overlay';

// 贴在 DeepSeek Harness 窗口内（右上角），多会话按格子平铺，不自由漂浮
const ATTACH_TO_DSH = process.env.OVERLAY_ATTACH_DSH !== '0';
// 宿主应用（小窗贴谁、按谁的会话标题门控）——默认 DSH，可用环境变量换成任何应用
const HOST_PROCESS = process.env.OVERLAY_HOST_PROCESS || process.env.OVERLAY_DSH_PROCESS || 'DeepSeek Harness';
const HOST_BUNDLES = (process.env.OVERLAY_HOST_BUNDLES || 'com.deepseek.dsh')
  .split(',').map((x) => x.trim()).filter(Boolean);
const HOST_TITLE_SUFFIX = process.env.OVERLAY_HOST_TITLE_SUFFIX || 'DeepSeek Harness';
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
const FADE_MS = 180;

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
  // 抓帧频率：默认 7fps（约 143ms 一帧，screencapture 单帧约 100–125ms）
  fps: clamp(toNumber(process.env.OVERLAY_FPS, 15), 1, 30),
  width: Math.round(toNumber(process.env.OVERLAY_WIDTH, DEFAULT_WIDTH)),
  height: Math.round(toNumber(process.env.OVERLAY_HEIGHT, DEFAULT_HEIGHT)),
  margin: Math.round(toNumber(process.env.OVERLAY_MARGIN, 16)),
  showDock: process.env.OVERLAY_SHOW_DOCK === '1',
  windowId: resolveWindowId(process.argv, process.env),
  // 最后一次活动后多少毫秒自动隐藏；0 表示关闭自动隐藏
  idleHideMs: Math.max(0, Math.round(toNumber(process.env.OVERLAY_IDLE_HIDE_MS, 5000))),
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
    const error = new Error('会话数已达上限 ' + MAX_SESSIONS);
    error.statusCode = 409;
    throw error;
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
      const fallback = 'tell application "System Events" to tell process "' + DSH_PROCESS +
        '" to get {' + '{position of window 1}' + ', ' + '{size of window 1}' + '}';
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
      'const target=' + JSON.stringify(HOST_PROCESS) + ';' +
      'const opts=$.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements;' +
      'const arr=ObjC.castRefToObject($.CGWindowListCopyWindowInfo(opts, 0));' +
      'const out=[];' +
      'for (let i=0;i<arr.count;i++){' +
      '  try {' +
      '    const d=arr.objectAtIndex(i);' +
      '    const owner=ObjC.unwrap(d.objectForKey("kCGWindowOwnerName")) || "";' +
      '    if (owner !== target) continue;' +
      '    const layer=Number(ObjC.unwrap(d.objectForKey("kCGWindowLayer")));' +
      '    if (layer !== 0) continue;' +
      '    const b=ObjC.deepUnwrap(d.objectForKey("kCGWindowBounds"));' +
      '    const name=ObjC.unwrap(d.objectForKey("kCGWindowName")) || "";' +
      '    out.push({x:Number(b.X),y:Number(b.Y),w:Number(b.Width),h:Number(b.Height),name:String(name)});' +
      '  } catch(e){}' +
      '}' +
      'JSON.stringify(out);';
    execFile('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script], { timeout: 2000 }, (err, stdout) => {
      if (err) return resolve({ ok: false, window: null });
      try {
        const list = JSON.parse(String(stdout));
        if (!Array.isArray(list)) return resolve({ ok: false, window: null });
        let best = null;
        for (const item of list) {
          if (!item || item.w < 200 || item.h < 150) continue;
          const area = item.w * item.h;
          if (!best || area > best.area) best = { x: item.x, y: item.y, w: item.w, h: item.h, title: item.name || '', area: area };
        }
        resolve({ ok: true, window: best ? { x: best.x, y: best.y, w: best.w, h: best.h, title: best.title } : null });
      } catch (error) {
        resolve({ ok: false, window: null });
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
let hostVisible = true;
let hostBoundsStale = false;
let hostCheckedAt = 0;

// 多会话平铺：优先排满右上角一行，再往下一行；都限制在 DSH 窗口内部
function tilePosition(s, b) {
  const [cw, ch] = s.win.getSize();
  const usableWidth = Math.max(cw, b.w - 2 * DSH_MARGIN);
  const cols = Math.max(1, Math.floor((usableWidth + TILE_GAP) / (cw + TILE_GAP)));
  const col = s.index % cols;
  const row = Math.floor(s.index / cols);

  const rawX = b.x + b.w - DSH_MARGIN - cw - col * (cw + TILE_GAP);
  let rawY = b.y + DSH_MARGIN + row * (ch + TILE_GAP);

  // 超出 DSH 底部时贴底，避免窗口跑到 DSH 外面（多到堆不下时才会互相压住）
  const maxY = b.y + b.h - DSH_MARGIN - ch;
  if (rawY > maxY) rawY = maxY;

  return {
    x: Math.round(clamp(rawX, b.x, Math.max(b.x, b.x + b.w - cw))),
    y: Math.round(clamp(rawY, b.y, Math.max(b.y, maxY))),
  };
}

function clampIntoDsh(s) {
  const b = dshBounds;
  const win = s.win;
  if (!b || !win || win.isDestroyed() || s.flags.expanded || s.flags.settingBounds) return;

  const [x, y] = win.getPosition();
  const [cw, ch] = win.getSize();
  const minX = b.x;
  const minY = b.y;
  const maxX = Math.max(minX, b.x + b.w - cw);
  const maxY = Math.max(minY, b.y + b.h - ch);
  const nx = clamp(x, minX, maxX);
  const ny = clamp(y, minY, maxY);

  if (Math.abs(nx - x) > 1 || Math.abs(ny - y) > 1) {
    s.flags.settingBounds = true;
    win.setPosition(Math.round(nx), Math.round(ny));
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
  if (!s.matched && s.win && !s.win.isDestroyed() && s.win.isVisible()) {
    s.flags.suppressBySession = true;
    s.win.hide();
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

  // 只在「召唤它的 DSH 会话」里显示：DSH 不在前台、或当前前台会话标题对不上，就隐藏。
  // 标题门控对放大态同样生效，避免别的会话的小窗一直挂着。
  // 宿主可以是任意应用：由 HOST_BUNDLES 配置
  const self = 'com.github.Electron';
  const frontOk = !front || HOST_BUNDLES.includes(front) || front === self;
  const shouldHide = !hostVisible || !frontOk || !s.matched;
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
      win.showInactive();
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

async function attachTick() {
  const front = await readFrontmostBundle();
  let bounds = null;
  if (ATTACH_TO_DSH) {
    const cg = await readHostWindowCg();
    if (cg.ok) {
      hostCheckedAt = Date.now();
      if (cg.window) {
        // 屏幕上真的能读到宿主窗口：位置/标题都刷新，stale=false
        bounds = cg.window;
        dshBounds = bounds;
        if (bounds.title) dshTitle = bounds.title;
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
  }
}

function startAttachLoop() {
  if (!ATTACH_TO_DSH || attachTimer) return;
  attachTimer = setInterval(() => { attachTick().catch(() => {}); }, 1200);
  attachTick().catch(() => {});
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
  // 标题门控：当前前台 DSH 会话不是它的时候，活动也不让窗口冒出来
  if (s.titleHint && !titleMatches(s)) {
    s.matched = false;
    return;
  }
  s.state.visible = true;
  // 还没 ready-to-show 的窗口交给 ready-to-show 首次显示
  if (!s.flags.ready) return;

  if (!win.isVisible()) {
    win.setOpacity(0);
    // showInactive：只显示，不激活、不抢焦点
    win.showInactive();
  }
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
  const next = String(text == null ? '' : text).replace(/\s+/g, ' ').trim().slice(0, 300) || '待命';
  const activity = ACTIVITY_STATES.indexOf(requestedActivity) !== -1
    ? requestedActivity
    : (next === '待命' ? 'idle' : 'running');

  s.state.status = next;
  s.state.activity = activity;
  send(s, 'overlay:status', { text: next, activity: activity });
  markActivity(s, 'status');
  return { text: next, activity: activity };
}

function signalThumbState(s, force) {
  const payload = {
    state: s.state.thumbnail.state,
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
  const url = 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture';
  shell.openExternal(url).catch(() => {});
}

function retryThumbnailCapture(s) {
  if (!s || !s.win || s.win.isDestroyed()) return;
  s.externalFrameAt = 0; // 允许本地抓帧，别被外部帧的 3 秒接管窗口挡住
  s.lastCaptureError = null;
  pushLog(s, '手动重试抓取画面', 'system');
  void captureThumbnail(s);
}

function explainCaptureError(error) {
  if (!error) return '未知错误';
  if (error.killed || error.signal === 'SIGTERM') return 'screencapture 超时';
  if (error.code === 'ENOENT') return '找不到 ' + SCREENSHOT_CMD;

  const stderr = String(error.stderr || '').trim();
  if (/not authorized|permission|denied|screen recording/i.test(stderr)) {
    return '没有屏幕录制权限，点「打开设置」授权';
  }
  if (/could not create image|invalid window|window .*not found|no such window/i.test(stderr)) {
    return '目标窗口已失效或不可见，点「重试」再抓一次';
  }
  if (stderr) {
    const firstLine = stderr.split('\n').filter(Boolean)[0];
    if (firstLine) return firstLine.slice(0, 160);
  }
  return String(error.message || ('screencapture 退出码 ' + error.code));
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
function base64DataBytes(dataUrl) {
  const text = String(dataUrl || '');
  const comma = text.indexOf(',');
  if (comma < 0) return 0;
  const b64 = text.length - comma - 1;
  let padding = 0;
  if (text.endsWith('==')) padding = 2;
  else if (text.endsWith('=')) padding = 1;
  return Math.max(0, Math.floor((b64 * 3) / 4) - padding);
}

// 只读图片头拿宽高（JPEG SOF / PNG IHDR），不整图解码。
// 连续推帧时尺寸已知就完全不解析，避免每帧 nativeImage 解码拖慢主进程。
function imageSizeFromDataUrl(dataUrl) {
  try {
    const text = String(dataUrl || '');
    const comma = text.indexOf(',');
    if (comma < 0) return null;
    const meta = text.slice(0, comma);
    const buf = Buffer.from(text.slice(comma + 1), 'base64');
    if (!buf.length) return null;
    if (/^data:image\/png/i.test(meta)) {
      if (buf.length >= 24 && buf.readUInt32BE(12) === 0x49484452) { // 'IHDR'
        const width = buf.readUInt32BE(16);
        const height = buf.readUInt32BE(20);
        if (width > 0 && height > 0) return { width: width, height: height };
      }
    } else {
      const size = jpegSize(buf);
      if (size && size.width > 0 && size.height > 0) return size;
    }
  } catch (error) {
    // 解析失败按「尺寸未知」处理
  }
  return null;
}

// cursor 是画面像素坐标 { x, y, click }，渲染进程据此画虚拟光标
function sanitizeCursor(cursor) {
  if (!cursor || typeof cursor !== 'object') return null;
  const x = Number(cursor.x);
  const y = Number(cursor.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return {
    x: Math.round(x * 100) / 100,
    y: Math.round(y * 100) / 100,
    click: Boolean(cursor.click),
  };
}

// 外部推送的画面（例如 headless CDP 截图）：接管该会话的缩略图，暂停 screencapture。
// 连续推帧时每次都会刷新时间戳/状态，不会被当成「一次性画面」；
// 本地 screencapture 在最后一次外部帧后 3 秒才恢复，期间不会和外部位图抢画面。
function pushExternalFrame(s, dataUrl, note, cursor, width, height) {
  s.externalFrameAt = Date.now();
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
function jpegSize(buf) {
  try {
    let i = 2;
    while (i < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1];
      const len = buf.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      }
      i += 2 + len;
    }
  } catch {}
  return { width: 0, height: 0 };
}

async function captureThumbnail(s) {
  const win = s.win;
  if (!win || win.isDestroyed() || !s.flags.ready) return;
  // 窗口隐藏时暂停抓帧，显示后补一帧即可
  if (!s.state.visible) return;
  // 外部画面接管中（3 秒内有推送）就不再做窗口截图
  if (Date.now() - s.externalFrameAt < 3000) return;
  if (!s.state.windowId || s.flags.capturing || !tempDir) return;

  s.flags.capturing = true;
  const captureStartedAt = Date.now();
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
    s.lastCaptureError = null;
    s.captureMs = Date.now() - captureStartedAt;
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
    const message = explainCaptureError(error);
    s.state.thumbnail.state = 'error';
    s.state.thumbnail.error = message;

    if (message !== s.lastCaptureError) {
      s.lastCaptureError = message;
      pushLog(s, '缩略图捕获失败：' + message, 'system');
    }
    signalThumbState(s);
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
      const delay = Math.max(0, period - (Date.now() - startedAt));
      s.timers.thumb = setTimeout(tick, delay);
    });
  };
  s.timers.thumb = setTimeout(tick, 0);
}

// ---------- 窗口 ----------

function setWindowId(s, raw, source, title) {
  const id = normalizeWindowId(raw);
  if (!id) return null;

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

  pushLog(s, '缩略图目标窗口 → ' + id + (source ? '（' + source + '）' : ''), 'system');
  markActivity(s, 'window');
  startThumbnailLoop(s);
  return id;
}

async function refreshSelfWindows() {
  try {
    await listWindows();
  } catch (error) {
    // 取不到窗口列表时不阻塞绑定流程
  }
}

async function listWindows() {
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
    win.setOpacity(0);
    win.showInactive(); // 不 activate、不抢焦点
    applyClickThrough(s); // 默认整窗穿透
    s.state.visible = true;
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

function sessionHealth(s) {
  return {
    session: s.id,
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
    lastActivityAt: s.state.lastActivityAt,
    hardHideMs: HARD_HIDE_MS,
    windowId: s.state.windowId,
    titleHint: s.titleHint || null,
    matched: Boolean(s.matched),
    dshTitle: dshTitle || null,
    hostVisible: Boolean(hostVisible),
    hostBoundsStale: Boolean(hostBoundsStale),
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
    status: s.state.status,
    activity: s.state.activity,
    visible: s.state.visible,
    logs: s.state.logs,
    windowId: s.state.windowId,
    expanded: s.flags.expanded,
    thumbnail: s.state.thumbnail,
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
      onVisible: (session, visible) => setVisibleManual(ensureSession(session, 'HTTP /visible'), visible),
      onFrame: (session, dataUrl, note, cursor, width, height) => pushExternalFrame(ensureSession(session, 'HTTP /frame'), dataUrl, note, cursor, width, height),
      onExpand: (session) => toggleExpand(ensureSession(session, 'HTTP /expand')),
      close: (session) => closeSession(session),
      sessions: () => Array.from(sessions.values()).map(sessionHealth),
      health: (session) => {
        const s = sessions.get(session);
        return s ? sessionHealth(s) : missingSessionHealth(session);
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
    setTimeout(() => { attachToDsh(s, 'com.deepseek.dsh', dshBounds).catch(() => {}); }, 100);
    scheduleIdleHide(s);
  }
  return { expanded: s.flags.expanded };
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

  if (attachTimer) {
    clearInterval(attachTimer);
    attachTimer = null;
  }

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

  // 启动时先扫一遍窗口，填充 selfWindowIds，避免把小窗绑到 DeepSeek Harness 自己身上。
  listWindows().catch(() => {});

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

app.on('before-quit', () => {
  try { supervisor.stopDaemon(); } catch {}
  cleanup();
});

// 多会话模式：关掉所有窗口不退出进程，HTTP 服务继续运行；
// 下一条带 session 的请求会重新召唤对应的小窗，不影响其它会话。
app.on('window-all-closed', () => {
  console.log('[overlay] 所有会话窗口已关闭，HTTP 服务继续运行，等待新的 session');
});