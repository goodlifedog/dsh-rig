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

const { app, BrowserWindow, desktopCapturer, ipcMain, nativeImage, screen } = require('electron');
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createOverlayServer, DEFAULT_SESSION, SESSION_PATTERN } = require('./server.js');
const { normalizeWindowId, resolveWindowId } = require('./window-id.js');

const APP_NAME = 'desktop-agent-overlay';

// 贴在 DeepSeek Harness 窗口内（右上角），多会话按格子平铺，不自由漂浮
const ATTACH_TO_DSH = process.env.OVERLAY_ATTACH_DSH !== '0';
const DSH_PROCESS = process.env.OVERLAY_DSH_PROCESS || 'DeepSeek Harness';
const DSH_MARGIN = 16;
const TILE_GAP = 10;

// 这些窗口永远不能被当成"被控目标"：DeepSeek Harness 自己，以及 overlay 自己的窗口
const SELF_WINDOW_PATTERN = /DeepSeek Harness|com\.deepseek\.dsh|\bdsh\b|^Desktop Agent/i;
const MAX_LOGS = 200;
const MAX_SESSIONS = Math.max(1, Math.round(Number(process.env.OVERLAY_MAX_SESSIONS) || 12));
const DEFAULT_PORT = 7788;
const DEFAULT_WIDTH = 300;
const DEFAULT_HEIGHT = 190;
const SCREENSHOT_CMD = '/usr/sbin/screencapture';
// 缩略图按「窗口宽 × 2（Retina）」出图，上限 1600；质量 88
const THUMB_SCALE = 2;
const THUMB_MAX_PIXEL_WIDTH = 1600;
const THUMB_MIN_PIXEL_WIDTH = 300;
const THUMB_JPEG_QUALITY = 88;
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
  fps: clamp(toNumber(process.env.OVERLAY_FPS, 7), 1, 12),
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

function readFrontmostBundle() {
  return new Promise((resolve) => {
    execFile('/usr/bin/osascript', ['-e',
      'tell application "System Events" to get bundle identifier of first process whose frontmost is true'],
      { timeout: 1500 }, (err, stdout) => resolve(err ? null : String(stdout).trim()));
  });
}

// DSH 窗口位置/标题由 attach 循环每秒缓存一次，拖动时直接用缓存，避免每条 move 事件都起一个 osascript
let dshBounds = null;
let dshTitle = '';

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

// DSH 窗口标题形如「规划布局探讨 — DeepSeek Harness」，匹配前先去掉后缀
function normalizeDshTitle(raw) {
  return String(raw || '').trim().replace(/\s*[—–-]\s*DeepSeek Harness\s*$/i, '').trim();
}

// 第一次推 /status 或 /log 且没显式给 titleHint 时，用当前 DSH 标题自动绑定该会话。
// 读不到标题就先不绑，下次活动再试（避免把窗口误藏）。
function maybeAutoBindTitle(s) {
  if (s.explicitTitleHint || s.autoTitleBound) return;
  if (!dshTitle) return;
  const short = normalizeDshTitle(dshTitle);
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
  if (!s.titleHint) return true; // 旧行为：没有 titleHint 的会话不受标题门控
  if (!dshTitle) return true;    // 读不到 DSH 标题：保持旧行为，避免把所有窗口误藏
  return normalizeDshTitle(dshTitle).indexOf(s.titleHint) !== -1;
}

async function attachToDsh(s, front, bounds) {
  const win = s.win;
  s.matched = titleMatches(s);

  if (!ATTACH_TO_DSH || !win || win.isDestroyed()) return;

  // 只在「召唤它的 DSH 会话」里显示：DSH 不在前台、或当前前台会话标题对不上，就隐藏。
  // 标题门控对放大态同样生效，避免别的会话的小窗一直挂着。
  const ours = 'com.deepseek.dsh';
  const self = 'com.github.Electron';
  const frontOk = !front || front === ours || front === self;
  const shouldHide = !frontOk || !s.matched;
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
    bounds = await readDshBounds();
    if (bounds) {
      dshBounds = bounds;
      if (bounds.title) dshTitle = bounds.title;
    } else {
      bounds = dshBounds;
    }
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
      const hotspot = inside && cursorInHotspot(win, point);
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

// 与渲染进程的热区保持一致：边缘/顶部 8px + 右上角两个按钮 + 左上角状态胶囊
function cursorInHotspot(win, point) {
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
  if (x >= 4 && x <= 170 && y >= 4 && y <= 36) return true;            // 状态胶囊
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

function explainCaptureError(error) {
  if (!error) return '未知错误';
  if (error.killed || error.signal === 'SIGTERM') return 'screencapture 超时';
  if (error.code === 'ENOENT') return '找不到 ' + SCREENSHOT_CMD;

  const stderr = String(error.stderr || '').trim();
  if (/could not create image|not authorized|permission|denied/i.test(stderr)) {
    return '取不到画面（窗口 ID 失效，或没有屏幕录制权限）';
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

// 外部推送的画面（例如 CDP 截图）：接管该会话的缩略图，暂停 screencapture
function pushExternalFrame(s, dataUrl, note, cursor) {
  s.externalFrameAt = Date.now();
  const prev = s.state.thumbnail || {};
  // 外部推帧也要知道画面宽高：放大态按最近一帧比例算窗口，不知道尺寸就会退回 4:3 出现黑边
  let frameWidth = Number(prev.width) || 0;
  let frameHeight = Number(prev.height) || 0;
  try {
    const image = nativeImage.createFromDataURL(dataUrl);
    if (!image.isEmpty()) {
      const size = image.getSize();
      if (size.width > 0 && size.height > 0) {
        frameWidth = size.width;
        frameHeight = size.height;
      }
    }
  } catch (error) {
    // 解码失败就沿用上一帧的尺寸，不影响推帧
  }
  s.state.thumbnail = {
    state: 'live',
    dataUrl: dataUrl,
    width: frameWidth,
    height: frameHeight,
    updatedAt: s.externalFrameAt,
    error: null,
    note: note || 'agent',
  };
  recordFrame(s, String(dataUrl || '').length);
  send(s, 'overlay:thumb', { state: 'live', dataUrl: dataUrl, updatedAt: s.externalFrameAt, cursor: cursor || null });
  markActivity(s, 'frame');
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
  const file = path.join(tempDir, 'frame-' + slug + '-' + Date.now() + '-' + (s.thumbSeq++) + '.png');
  pendingTempFiles.add(file);

  try {
    await execFileAsync(
      SCREENSHOT_CMD,
      ['-x', '-o', '-l', String(s.state.windowId), '-t', 'png', file],
      { timeout: CAPTURE_TIMEOUT_MS, maxBuffer: 1024 * 1024 }
    );

    const image = nativeImage.createFromPath(file);
    if (image.isEmpty()) throw new Error('screencapture 没有产出有效图片');

    const original = image.getSize();
    // 只做一次 nativeImage.resize：PNG 中间格式无损，最终只编码一次 JPEG
    const targetWidth = thumbnailTargetWidth(s);
    const frame = original.width > targetWidth
      ? image.resize({ width: targetWidth, quality: 'best' })
      : image;
    const frameSize = frame.getSize();
    const jpeg = frame.toJPEG(THUMB_JPEG_QUALITY);

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
    s.state.thumbnail.state = 'no-window';
    signalThumbState(s, true);
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
  const period = Math.max(100, Math.round(1000 / config.fps));
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

function setWindowId(s, raw, source) {
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
    logs: s.state.logs.length,
    fps: frameFps(s),
    frameBytes: s.frameBytes,
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
    logs: 0,
    fps: 0,
    frameBytes: 0,
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
      onWindow: async (session, raw) => {
        const s = ensureSession(session, 'HTTP /window');
        await refreshSelfWindows();
        const id = normalizeWindowId(raw);
        const result = setWindowId(s, raw, 'HTTP /window');
        if (!result && id && selfWindowIds.has(id)) {
          const error = new Error('拒绝绑定 DeepSeek Harness 自身窗口（' + id + '），请指定被控应用窗口');
          error.statusCode = 403;
          throw error;
        }
        return result;
      },
      onVisible: (session, visible) => setVisibleManual(ensureSession(session, 'HTTP /visible'), visible),
      onFrame: (session, dataUrl, note, cursor) => pushExternalFrame(ensureSession(session, 'HTTP /frame'), dataUrl, note, cursor),
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

  app.whenReady().then(boot).catch((error) => {
    console.error('[overlay] 启动失败', error);
    app.quit();
  });
}

app.on('before-quit', cleanup);

// 多会话模式：关掉所有窗口不退出进程，HTTP 服务继续运行；
// 下一条带 session 的请求会重新召唤对应的小窗，不影响其它会话。
app.on('window-all-closed', () => {
  console.log('[overlay] 所有会话窗口已关闭，HTTP 服务继续运行，等待新的 session');
});