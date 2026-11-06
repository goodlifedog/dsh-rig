/**
 * probe-inner.mjs — 由 probe.mjs 注入占位符后，交给 ocu js --file 执行的内层脚本。
 *
 * 为什么单独放一个文件：ocu 的 element index 只有和 getAXState 在同一个原生会话里才有效，
 * 所以必须用 ocu 的持久 JS 会话做「取状态 -> 解析 index -> 点击 -> 再取状态」。
 * 这个文件不要直接运行；请运行 probe.mjs。
 *
 * 占位符（由 probe.mjs 在运行时注入）：
 *   目标应用名、期望的页面 URL 片段、点击后应出现的弹层标志文本。
 *
 * 实测要点（2026-11-05）：
 *   - 打开：accessibility 点左侧筛选栏「武汉」按钮；第一次点击经常被「吞掉」，需要重试并轮询等待。
 *   - 关闭：必须点弹层右上角的 × 按钮（accessibility）；再点筛选按钮并不会关闭弹层。
 *   - 弹层节点在 AX 树里出现/消失都有 0.5~2s 延迟，判定必须轮询。
 */

var APP = __APP__;
var FRAGMENT = __FRAGMENT__;
var DIALOG_MARKER = __DIALOG_MARKER__;

var out = {
  marker: "ocu-probe-v1",
  checks: {},
  evidence: [],
  steps: [],
  errors: [],
};

function sleep(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }
function emit() { nodeRepl.write("OCU_PROBE_JSON=" + JSON.stringify(out)); }

function normLines(state) {
  return state.split("\n").map(function (line) {
    return line.replace(/^\t*\d+\s*/, "").trim();
  }).filter(Boolean);
}

// 弹层判定：直接判「弹层节点是否存在」，不看新增行数。
// 注意：页面页脚本来就有「热门城市」链接分组，不能拿它当弹层标志！
// 城市弹层的可靠标志：标题「请选择城市」或字母分栏按钮（ABCDE/FGHJ/...）。
function dialogMarkers(state) {
  return {
    title: state.indexOf(DIALOG_MARKER) >= 0,
    letterTabs: /^\t*\d+ button (ABCDE|FGHJ|KLMN|PQRST|WXYZ)/m.test(state),
    hotCitySection: /^\t*\d+ button 热门城市/m.test(state),
  };
}
function dialogOpen(state) {
  var m = dialogMarkers(state);
  return m.title || m.letterTabs;
}

// 左侧筛选栏的城市按钮：role=button、文本出现「武汉」、带 Frame。
function findCityButton(state) {
  var lines = state.split("\n");
  for (var i = 0; i < lines.length; i++) {
    var m = /^\t*(\d+)\s+button\s+\S*\s*武汉\s+Frame: x=(\d+), y=(\d+), w=(\d+), h=(\d+)/.exec(lines[i]);
    if (!m) continue;
    var x = Number(m[2]), y = Number(m[3]), w = Number(m[4]), h = Number(m[5]);
    if (y >= 120 && y <= 500 && w >= 30 && w <= 400) {
      return { index: m[1], x: x, y: y, w: w, h: h, line: lines[i].trim() };
    }
  }
  return null;
}

// 弹层右上角的 × 按钮：带 Frame 的无文本 button，坐标落在弹层标题右侧。
function findDialogCloseButton(state) {
  var lines = state.split("\n");
  for (var i = 0; i < lines.length; i++) {
    var m = /^\t*(\d+)\s+button\s+Frame: x=(\d+), y=(\d+), w=(\d+), h=(\d+)/.exec(lines[i]);
    if (!m) continue;
    var x = Number(m[2]), y = Number(m[3]), w = Number(m[4]), h = Number(m[5]);
    if (x >= 880 && x <= 1020 && y >= 240 && y <= 380 && w <= 40 && h <= 40) {
      return { index: m[1], x: x, y: y, w: w, h: h, cx: x + w / 2, cy: y + h / 2, line: lines[i].trim() };
    }
  }
  return null;
}

function diffAdded(beforeState, afterState) {
  var a = normLines(beforeState), b = normLines(afterState);
  var counts = new Map();
  for (var i = 0; i < a.length; i++) { counts.set(a[i], (counts.get(a[i]) || 0) + 1); }
  var added = [];
  for (var j = 0; j < b.length; j++) {
    var line = b[j], c = counts.get(line) || 0;
    if (c > 0) { counts.set(line, c - 1); } else { added.push(line); }
  }
  return added;
}

// 关弹层：点 × 按钮；每次点击后轮询等待 AX 树更新，没关掉就重试用新 index。
async function ensureClosed(app, opts) {
  var tries = [];
  var state = null;
  for (var attempt = 0; attempt < 4; attempt++) {
    state = await app.getAXState(opts);
    if (!dialogOpen(state)) return { closed: true, state: state, tries: tries, attempts: attempt };

    var closeBtn = findDialogCloseButton(state);
    if (!closeBtn) {
      // 兜底：没有 × 按钮时再试一次筛选按钮
      var cityBtn = findCityButton(state);
      if (!cityBtn) { tries.push("no-close-target"); break; }
      try { await app.click(cityBtn.index, { clickMethod: "accessibility" }); tries.push("a11y-city@" + cityBtn.index); }
      catch (e) { tries.push("a11y-city:err"); }
    } else {
      try { await app.click(closeBtn.index, { clickMethod: "accessibility" }); tries.push("a11y-close@" + closeBtn.index); }
      catch (e) { tries.push("a11y-close:err"); }
    }

    for (var poll = 0; poll < 3; poll++) {
      await sleep(800);
      state = await app.getAXState(opts);
      if (!dialogOpen(state)) return { closed: true, state: state, tries: tries, attempts: attempt + 1 };
    }
  }
  return { closed: false, state: state, tries: tries };
}

// 开弹层：点筛选按钮；第一次点击可能被吞，重试并轮询等待 AX 更新。
async function ensureOpen(app, opts) {
  var tries = [];
  var state = null;
  var button = null;
  for (var attempt = 0; attempt < 4; attempt++) {
    state = await app.getAXState(opts);
    if (dialogOpen(state)) return { opened: true, state: state, tries: tries, button: button, attempts: attempt };

    button = findCityButton(state);
    if (!button) { tries.push("no-city-button"); break; }
    try { await app.click(button.index, { clickMethod: "accessibility" }); tries.push("a11y-city@" + button.index); }
    catch (e) { tries.push("a11y-city:err:" + String((e && e.message) || e)); }

    for (var poll = 0; poll < 3; poll++) {
      await sleep(800);
      state = await app.getAXState(opts);
      if (dialogOpen(state)) return { opened: true, state: state, tries: tries, button: button, attempts: attempt + 1 };
    }
  }
  return { opened: false, state: state, tries: tries, button: button };
}

try {
  var app = await cua.getApp(APP, { initialState: false });
  var opts = { emit: false, maxTreeNodes: 3000, maxTreeDepth: 96, textLimit: 500 };

  var initial = await app.getAXState(opts);
  out.page = { url: (/URL: (\S+)/.exec(initial) || [])[1] || null };
  out.checks.onBossJobsPage = initial.indexOf(FRAGMENT) >= 0;

  if (!out.checks.onBossJobsPage) {
    out.errors.push("前置条件不满足：当前不是 BOSS 职位页(" + FRAGMENT + ")，为避免误操作已跳过所有点击");
  }

  // 保证从「弹层关闭」的干净状态开始；若清不掉就不点击，避免把残留状态误判成点击效果。
  var clean = await ensureClosed(app, opts);
  out.steps.push({ step: "ensure-closed-before", closed: clean.closed, method: clean.method, tried: clean.tries, attempts: clean.attempts });
  var before = clean.state || await app.getAXState(opts);
  out.checks.axBeforeLines = before.split("\n").length;
  out.checks.dialogAbsentBefore = !dialogOpen(before);
  out.checks.cleanStart = out.checks.onBossJobsPage && out.checks.dialogAbsentBefore;

  if (out.checks.onBossJobsPage && !out.checks.dialogAbsentBefore) {
    out.errors.push("清场失败：点击前城市弹层仍然存在，无法做干净的对照，已跳过点击");
  }

  if (out.checks.cleanStart) {
    var openRes = await ensureOpen(app, opts);
    out.steps.push({ step: "open-city-dialog", opened: openRes.opened, attempts: openRes.tries });
    if (openRes.button) out.evidence.push("目标控件: " + openRes.button.line);

    var after = openRes.state || await app.getAXState(opts);
    var markers = dialogMarkers(after);
    out.checks.cityButtonFound = !!(openRes.button || findCityButton(before));
    out.checks.axAfterLines = after.split("\n").length;
    out.checks.dialogAppeared = openRes.opened === true;
    out.checks.dialogMarkersAfter = markers;
    out.checks.hotCitySectionSeen = markers.hotCitySection === true;
    out.checks.urlUnchanged = after.indexOf(FRAGMENT) >= 0;

    var added = diffAdded(before, after);
    out.checks.addedLineCount = added.length;
    out.evidence = out.evidence.concat(added.slice(0, 12).map(function (line) { return "+ " + line; }));

    // 无论验证结果如何都清场，别把用户页面留在弹层状态。
    var restore = await ensureClosed(app, opts);
    out.checks.dialogClosedAfterProbe = restore.closed;
    out.steps.push({ step: "restore-page-state", closed: restore.closed, method: restore.method, tried: restore.tries, attempts: restore.attempts });
  }
} catch (e) {
  out.errors.push("内层执行异常: " + String((e && e.message) || e));
}

emit();
