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
    dot: document.getElementById('dot'),
    status: document.getElementById('status'),
    sess: document.getElementById('sess'),
    logs: document.getElementById('logs'),
    loglist: document.getElementById('loglist'),
    thumb: document.getElementById('thumb'),
    expand: document.getElementById('expand'),
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
  };

  function pad2(value) {
    return value < 10 ? '0' + value : String(value);
  }

  function formatTime(ts) {
    const date = new Date(ts || Date.now());
    return pad2(date.getHours()) + ':' + pad2(date.getMinutes()) + ':' + pad2(date.getSeconds());
  }

  // ---------- 会话标识（仅非 default 会话在悬停时显示） ----------

  function renderSession(id) {
    if (!elements.sess) return;
    const text = typeof id === 'string' && id && id !== 'default' ? id : '';
    elements.sess.textContent = text;
    elements.sess.classList.toggle('on', Boolean(text));
  }

  // ---------- 状态行 ----------

  function renderActivity(activity) {
    const next = activity === 'running' || activity === 'error' ? activity : 'idle';
    view.activity = next;
    elements.dot.classList.remove('idle', 'running', 'error');
    elements.dot.classList.add(next);
  }

  function renderStatus(payload) {
    const data = typeof payload === 'string' ? { text: payload, activity: 'running' } : (payload || {});
    const nextText = typeof data.text === 'string' && data.text.trim() ? data.text.trim() : '待命';

    if (nextText !== view.statusText) {
      view.statusText = nextText;
      elements.status.textContent = nextText;
      elements.status.title = nextText;
      elements.status.classList.remove('fade');
      void elements.status.offsetWidth;
      elements.status.classList.add('fade');
    }

    if (data.activity) renderActivity(data.activity);
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
    if (view.thumbState === 'no-window') return '等待目标窗口';
    if (view.thumbState === 'error') return '画面暂时不可用';
    if (view.thumbState === 'waiting') return '正在连接窗口…';
    return '正在获取画面…';
  }

  function renderThumbState(payload) {
    const data = payload || {};
    view.thumbState = typeof data.state === 'string' ? data.state : 'waiting';
    if (view.hasFrame) {
      elements.placeholder.classList.add('hidden');
      return;
    }
    elements.placeholder.textContent = placeholderText();
    elements.placeholder.classList.remove('hidden');
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

    renderSession(snapshot.session);
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
      elements.close, elements.expand, elements.pill,
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
    if (api.setHover) {
      document.addEventListener('mouseenter', () => api.setHover(true));
      document.addEventListener('mouseleave', () => api.setHover(false));
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
      elements.status.textContent = 'preload 未加载';
      renderActivity('error');
      return;
    }

    wireEvents();

    try {
      handleInitialState(await api.getState());
    } catch (error) {
      elements.status.textContent = '读取初始状态失败';
      renderActivity('error');
    }
  }

  boot();
})();