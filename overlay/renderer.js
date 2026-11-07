'use strict';

/**
 * 渲染进程：手机浮窗风格的最小 UI。
 * 主体是一张圆角缩略图，底部一条状态胶囊，日志默认收起，悬停/点击胶囊展开。
 */

(function () {
  const MAX_LOGS = 200;
  const api = window.overlay;

  const elements = {
    app: document.getElementById('app'),
    close: document.getElementById('close'),
    pill: document.getElementById('pill'),
    bar: document.getElementById('statusbar'),
    barDot: document.getElementById('bar-dot'),
    barText: document.getElementById('bar-text'),
    elapsed: document.getElementById('elapsed'),
    fix: document.getElementById('fix'),
    sess: document.getElementById('sess'),
    logs: document.getElementById('logs'),
    loglist: document.getElementById('loglist'),
    thumb: document.getElementById('thumb'),
    expand: document.getElementById('expand'),
    stop: document.getElementById('stop'),
    vcur: document.getElementById('vcur'),
    vcurRing: document.getElementById('vcur-ring'),
    backdrop: document.getElementById('thumb-backdrop'),
    placeholder: document.getElementById('placeholder'),
    dragTop: document.getElementById('drag-top'),
    dragLeft: document.getElementById('drag-left'),
    dragRight: document.getElementById('drag-right'),
    dragBottom: document.getElementById('drag-bottom'),
  };

  const view = {
    logs: [],
    activity: 'idle',
    statusText: '',
    hasFrame: false,
    thumbState: 'waiting',
    logsOpen: false,
    logsPinned: false,
    hoveringPill: false,
    hoveringLogs: false,
    followLogs: true,
    frameSeq: 0,
    interactive: null,
    lastCursor: null,
    activitySince: null,
    elapsedTimer: null,
    thumbError: null,
    actionKind: null,
  };

  function pad2(value) {
    return value < 10 ? '0' + value : String(value);
  }

  function formatTime(ts) {
    const date = new Date(ts || Date.now());
    return pad2(date.getHours()) + ':' + pad2(date.getMinutes()) + ':' + pad2(date.getSeconds());
  }

  // ---------- 会话标识（仅非 default 会话在悬停时显示） ----------

  function renderSession(id, label) {
    if (!elements.sess) return;
    // 优先显示会话标题（用户认得的那个），没有才退回内部 session id
    const raw = (typeof label === 'string' && label.trim()) || (typeof id === 'string' ? id : '');
    const text = raw && raw !== 'default' ? (raw.length > 28 ? raw.slice(0, 27) + '…' : raw) : '';
    elements.sess.textContent = text;
    elements.sess.classList.toggle('on', Boolean(text));
  }

  // ---------- 底部状态胶囊：画面是主体，状态是配角 ----------

  function formatElapsed(ms) {
    const seconds = Math.max(0, Math.floor(ms / 1000));
    if (seconds < 60) return seconds + 's';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return minutes + 'm' + pad2(seconds % 60) + 's';
    return Math.floor(minutes / 60) + 'h' + pad2(minutes % 60) + 'm';
  }

  function refreshElapsed() {
    if (!elements.elapsed) return;
    // 错误态/空闲不显示运行计时，避免和错误原因抢注意力
    if (view.activity !== 'running' || !view.activitySince || view.thumbError) {
      elements.elapsed.textContent = '';
      return;
    }
    elements.elapsed.textContent = formatElapsed(Date.now() - view.activitySince);
  }

  function startElapsedTimer() {
    stopElapsedTimer();
    view.elapsedTimer = setInterval(refreshElapsed, 1000);
  }

  function stopElapsedTimer() {
    if (view.elapsedTimer) {
      clearInterval(view.elapsedTimer);
      view.elapsedTimer = null;
    }
  }

  // 错误原因 -> 一句人话 + 一个可操作动作
  function actionForError(reason) {
    if (/权限|授权|屏幕录制|permission|not authorized|screen recording/i.test(reason || '')) {
      return { kind: 'settings', label: '打开设置' };
    }
    return { kind: 'retry', label: '重试' };
  }

  function setActionVisible(visible) {
    if (elements.fix) elements.fix.classList.toggle('show', Boolean(visible));
    if (api.setAction) api.setAction(Boolean(visible));
  }

  function updateBar() {
    if (!elements.bar) return;
    const reason = view.thumbError;
    const isError = Boolean(reason) || view.activity === 'error';
    const shouldShow = Boolean(reason) || view.activity === 'running' || view.activity === 'error';
    elements.bar.classList.toggle('error', isError);
    elements.bar.classList.toggle('on', shouldShow);
    if (!shouldShow) {
      refreshElapsed();
      return;
    }

    let text;
    if (reason) text = '画面不可用：' + reason;
    else if (view.activity === 'error') text = view.statusText || '出错了';
    else text = view.statusText || '待命';
    elements.barText.textContent = text;
    elements.barText.title = text;

    if (elements.barDot) {
      elements.barDot.classList.remove('idle', 'running', 'error');
      elements.barDot.classList.add(isError ? 'error' : view.activity);
    }

    if (reason) {
      const action = actionForError(reason);
      view.actionKind = action.kind;
      elements.fix.textContent = action.label;
      elements.fix.title = action.kind === 'settings' ? '打开系统屏幕录制设置' : '重新抓取画面';
      setActionVisible(true);
    } else {
      view.actionKind = null;
      setActionVisible(false);
    }

    refreshElapsed();
  }

  function renderActivity(activity) {
    const next = activity === 'running' || activity === 'error' ? activity : 'idle';
    if (next !== view.activity) {
      if (next === 'running') {
        view.activitySince = Date.now();
        startElapsedTimer();
      } else {
        view.activitySince = null;
        stopElapsedTimer();
      }
    }
    view.activity = next;
    // 只有任务在跑时才给「停止」入口，空闲时别多一个按钮干扰
    if (elements.stop) elements.stop.style.display = next === 'running' ? 'block' : 'none';
    updateBar();
  }

  function renderStatus(payload) {
    const data = typeof payload === 'string' ? { text: payload, activity: 'running' } : (payload || {});
    const nextText = typeof data.text === 'string' && data.text.trim() ? data.text.trim() : '待命';
    view.statusText = nextText;
    if (data.activity) renderActivity(data.activity);
    else updateBar();
  }

  // ---------- 日志抽屉 ----------

  function syncLogsScrollable() {
    const scrollable = elements.logs.scrollHeight > elements.logs.clientHeight + 1;
    elements.logs.classList.toggle('scrollable', scrollable);
  }

  function scrollLogsToBottom() {
    elements.logs.scrollTop = elements.logs.scrollHeight;
    syncLogsScrollable();
  }

  function openLogs() {
    if (view.logsOpen) return;
    view.logsOpen = true;
    view.followLogs = true;
    elements.logs.classList.add('open');
    elements.logs.setAttribute('aria-hidden', 'false');
    requestAnimationFrame(scrollLogsToBottom);
  }

  function closeLogs() {
    if (!view.logsOpen) return;
    view.logsOpen = false;
    elements.logs.classList.remove('open');
    elements.logs.setAttribute('aria-hidden', 'true');
  }

  let closeTimer = null;

  function cancelScheduledClose() {
    if (closeTimer) {
      clearTimeout(closeTimer);
      closeTimer = null;
    }
  }

  // 胶囊和日志面板之间留一点缓冲，鼠标移过去时才不会瞬间收起
  function scheduleCloseLogs() {
    if (view.logsPinned) return;
    cancelScheduledClose();
    closeTimer = setTimeout(() => {
      closeTimer = null;
      if (!view.logsPinned && !view.hoveringPill && !view.hoveringLogs) closeLogs();
    }, 220);
  }

  function togglePinned() {
    view.logsPinned = !view.logsPinned;
    if (view.logsPinned) {
      openLogs();
    } else {
      closeLogs();
    }
  }

  function appendLog(entry, animate) {
    if (!entry || typeof entry.text !== 'string') return;

    view.logs.push(entry);

    const row = document.createElement('li');
    row.className = 'log-row' + (entry.kind === 'system' ? ' system' : '');

    const time = document.createElement('span');
    time.className = 't';
    time.textContent = formatTime(entry.ts);

    const text = document.createElement('span');
    text.className = 'x';
    text.textContent = entry.text;

    row.appendChild(time);
    row.appendChild(text);
    elements.loglist.appendChild(row);

    while (elements.loglist.childElementCount > MAX_LOGS) {
      elements.loglist.removeChild(elements.loglist.firstElementChild);
    }
    while (view.logs.length > MAX_LOGS) view.logs.shift();

    if (view.logsOpen && view.followLogs) scrollLogsToBottom();
    else syncLogsScrollable();
  }

  function renderLogs(list) {
    elements.loglist.textContent = '';
    view.logs = [];
    (list || []).forEach((entry) => appendLog(entry, false));
  }

  // ---------- 缩略图 ----------

  function placeholderText() {
    if (view.thumbState === 'offscreen') return '窗口在其它桌面，画面不可见（仍可后台操作）';
    if (view.thumbState === 'no-window') return '等待目标窗口';
    if (view.thumbState === 'error') return '画面暂时不可用';
    if (view.thumbState === 'waiting') return '正在连接窗口…';
    return '正在获取画面…';
  }

  function renderThumbState(payload) {
    const data = payload || {};
    view.thumbState = typeof data.state === 'string' ? data.state : 'waiting';
    // 抓帧失败/权限缺失时，状态条要给出人话原因 + 可操作按钮
    view.thumbError = view.thumbState === 'error' ? (data.error || '未知错误') : null;
    if (view.hasFrame) {
      elements.placeholder.classList.add('hidden');
      updateBar();
      return;
    }
    elements.placeholder.textContent = placeholderText();
    elements.placeholder.classList.remove('hidden');
    updateBar();
  }

  function applyFrame(url) {
    view.hasFrame = true;
    elements.thumb.src = url;
    elements.backdrop.src = url;
    elements.thumb.classList.add('visible');
    elements.backdrop.classList.add('visible');
    elements.placeholder.classList.add('hidden');
  }

  // 把画面像素坐标映射到 object-fit: contain 后的实际显示区域。
  // frameWidth/frameHeight 优先用帧里带的尺寸：第一帧还没 decode 完也能立刻画出光标。
  function positionCursor(cursor, frameWidth, frameHeight) {
    if (!cursor || !elements.vcur) return;
    const img = elements.thumb;
    if (!img) return;
    const naturalWidth = Number(frameWidth) || img.naturalWidth;
    const naturalHeight = Number(frameHeight) || img.naturalHeight;
    if (!naturalWidth || !naturalHeight) return;
    const boxW = img.clientWidth, boxH = img.clientHeight;
    if (!boxW || !boxH) return;
    const scale = Math.min(boxW / naturalWidth, boxH / naturalHeight);
    const dispW = naturalWidth * scale, dispH = naturalHeight * scale;
    const offX = (boxW - dispW) / 2, offY = (boxH - dispH) / 2;
    const x = offX + cursor.x * scale;
    const y = offY + cursor.y * scale;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;

    view.lastCursor = { cursor: cursor, width: naturalWidth, height: naturalHeight };
    elements.vcur.classList.add('on');
    elements.vcur.style.transform = 'translate(' + x.toFixed(1) + 'px,' + y.toFixed(1) + 'px)';

    // 点击瞬间波纹（CSS #vcur.clicking #vcur-ring）
    if (cursor.click) {
      elements.vcur.classList.remove('clicking');
      void elements.vcur.offsetWidth;
      elements.vcur.classList.add('clicking');
    }
  }

  function hideCursor() {
    view.lastCursor = null;
    if (!elements.vcur) return;
    elements.vcur.classList.remove('on', 'clicking');
  }

  // 窗口尺寸变化（含 ⤢ 放大）后重新按当前画面尺寸摆放光标
  function repositionCursor() {
    if (view.lastCursor) {
      positionCursor(view.lastCursor.cursor, view.lastCursor.width, view.lastCursor.height);
    }
  }

  function renderThumb(frame) {
    if (!frame || typeof frame.dataUrl !== 'string') return;
    const url = frame.dataUrl;
    const frameWidth = Number(frame.width) || 0;
    const frameHeight = Number(frame.height) || 0;
    const seq = ++view.frameSeq;

    // 先在内存里解码完成再替换，避免每帧刷新时闪白
    const preload = new Image();
    const swap = () => {
      if (seq !== view.frameSeq) return;
      applyFrame(url);
      // 外部帧总带 cursor 字段：有坐标就画，显式 null 就隐藏；本地抓帧不带该字段，保持不动
      if (frame.cursor) positionCursor(frame.cursor, frameWidth, frameHeight);
      else if (frame.cursor === null) hideCursor();
    };
    preload.onload = swap;
    preload.onerror = swap;
    preload.src = url;
  }

  // ---------- 初始化与事件 ----------

  function handleInitialState(snapshot) {
    if (!snapshot) return;

    renderSession(snapshot.session, snapshot.label);
    renderStatus({ text: snapshot.status, activity: snapshot.activity });
    renderActivity(snapshot.activity);
    renderLogs(snapshot.logs);
    renderThumbState(snapshot.thumbnail);

    if (snapshot.thumbnail && typeof snapshot.thumbnail.dataUrl === 'string') {
      applyFrame(snapshot.thumbnail.dataUrl);
      if (snapshot.thumbnail.cursor) {
        positionCursor(snapshot.thumbnail.cursor, snapshot.thumbnail.width, snapshot.thumbnail.height);
      } else if (snapshot.thumbnail.cursor === null) {
        hideCursor();
      }
    }
  }

  // 点击穿透：只有按钮、状态胶囊、8px 拖拽条热区需要接收鼠标，其余区域让点击落到 DSH
  function isInteractivePoint(x, y) {
    const zones = [
      elements.close, elements.expand, elements.pill, elements.fix,
      elements.dragTop, elements.dragLeft, elements.dragRight, elements.dragBottom,
    ];
    for (const element of zones) {
      if (!element) continue;
      const rect = element.getBoundingClientRect();
      if (!rect.width || !rect.height) continue;
      if (x >= rect.left - 2 && x <= rect.right + 2 && y >= rect.top - 2 && y <= rect.bottom + 2) {
        return true;
      }
    }
    return false;
  }

  function syncInteractive(x, y) {
    if (!api.setInteractive) return;
    const interactive = x === null ? false : isInteractivePoint(x, y);
    if (interactive === view.interactive) return;
    view.interactive = interactive;
    api.setInteractive(interactive);
  }

  function wireEvents() {
    api.onLog((entry) => appendLog(entry, true));
    api.onStatus((payload) => renderStatus(payload));
    api.onActivity((activity) => renderActivity(activity));
    api.onThumb((frame) => renderThumb(frame));
    api.onThumbState((payload) => renderThumbState(payload));

    elements.close.addEventListener('click', () => api.close());
    if (elements.fix && api.fix) {
      elements.fix.addEventListener('click', (event) => {
        event.stopPropagation();
        if (view.actionKind) api.fix(view.actionKind);
      });
    }
    if (api.setHover) {
      document.addEventListener('mouseenter', () => api.setHover(true));
      document.addEventListener('mouseleave', () => api.setHover(false));
    }
    if (elements.stop && api.stopTask) {
      elements.stop.addEventListener('click', (event) => {
        event.stopPropagation();
        api.stopTask();
      });
    }

    if (elements.expand && api.toggleExpand) {
      elements.expand.addEventListener('click', () => { api.toggleExpand().catch(() => {}); });
    }
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') api.close();
    });

    elements.pill.addEventListener('mouseenter', () => {
      view.hoveringPill = true;
      cancelScheduledClose();
      openLogs();
    });
    elements.pill.addEventListener('mouseleave', () => {
      view.hoveringPill = false;
      scheduleCloseLogs();
    });
    elements.pill.addEventListener('click', () => togglePinned());

    elements.logs.addEventListener('scroll', () => {
      view.followLogs = elements.logs.scrollHeight - elements.logs.scrollTop - elements.logs.clientHeight < 20;
      syncLogsScrollable();
    });

    elements.logs.addEventListener('mouseenter', () => {
      view.hoveringLogs = true;
      cancelScheduledClose();
    });
    elements.logs.addEventListener('mouseleave', () => {
      view.hoveringLogs = false;
      scheduleCloseLogs();
    });

    document.addEventListener('mouseleave', () => {
      syncInteractive(null, null);
      if (!view.logsPinned) closeLogs();
    });

    document.addEventListener('pointermove', (event) => {
      syncInteractive(event.clientX, event.clientY);
    });

    window.addEventListener('resize', () => { repositionCursor(); });
  }

  async function boot() {
    if (!api) {
      if (elements.barText) elements.barText.textContent = 'preload 未加载';
      if (elements.bar) elements.bar.classList.add('on', 'error');
      renderActivity('error');
      return;
    }

    wireEvents();

    try {
      handleInitialState(await api.getState());
    } catch (error) {
      if (elements.barText) elements.barText.textContent = '读取初始状态失败';
      if (elements.bar) elements.bar.classList.add('on', 'error');
      renderActivity('error');
    }
  }

  boot();
})();