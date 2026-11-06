'use strict';
// 内层：在后台 Chrome 里完成「点卡片 -> 确认右侧详情就是目标岗位 -> 点立即沟通 -> 关掉弹窗」。
//
// 关键原则（踩过的坑都写在这）：
//   1) 详情必须用「查看更多信息」链接里的 job_detail id 校验，不能用标题模糊匹配
//      —— 左侧列表里到处是 "Java"，旧版 indexOf(key) 永远为真，等于没校验。
//   2) 点「立即沟通」之前必须确认页面上没有残留的「已向BOSS发送消息」弹窗
//      —— 「留在此页」在 AX 里只是 container 里的普通文本，不是 link，旧版按
//      (\d+)\s+(link|按钮) 取 index 永远拿到 -1，弹窗从来没被关掉；之后每次
//      检测到的「已向BOSS发送消息」都是上一个没关掉的弹窗，于是全部假报成功。
//   3) 弹窗只代表「平台受理了这次点击」，不代表真的建了会话。真送达由外层读
//      消息列表差集判定（core/tasks/boss-greet.mjs）。
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function rand(a, b) { return a + Math.random() * (b - a); }

var APP = (typeof process !== 'undefined' && process.env.TARGET_APP) || 'Google Chrome';
var LIMIT = Number((typeof process !== 'undefined' && process.env.GREET_LIMIT) || 1);
// 一次最多翻几张卡片：外层是「发一条、核一条」，所以默认只处理第一张候选卡。
var MAXCARDS = Number((typeof process !== 'undefined' && process.env.GREET_CARDS) || 1);
// GREET_DRY=1：只验证「点卡片 -> 详情正确」，不点「立即沟通」，用于排障和回归
var DRY = (typeof process !== 'undefined' && process.env.GREET_DRY) === '1';
var SKIP = {};
(((typeof process !== 'undefined' && process.env.GREET_SKIP) || '')).split(',').forEach(function (x) {
  if (x.trim()) SKIP[x.trim()] = 1;
});

var BAD_DEGREE = /硕士|博士/;
var BAD_EXP = /(5-10年|10年以上|3-5年)/;
var WANT = /(AI|Agent|agent|大模型|Java|java|后端|工作流|Python|全栈|开发)/;
var DIALOG_MARK = '已向BOSS发送消息';
var JOBS_URL = 'zhipin.com/web/geek/jobs';
var CARD_RE = /^\s*(\d+)\s+link \[([^\]]+)\]\(https:\/\/www\.zhipin\.com\/job_detail\/([^?)]+?)\.html\)\s*$/;
var MORE_RE = /link \[查看更多信息\]\(https:\/\/www\.zhipin\.com\/job_detail\/([^?)]+)/;

var app = await cua.getApp(APP, { initialState: false });

async function rawState() {
  var s = await app.getAXState({ includeScreenshot: false, emit: false, maxTreeNodes: 12000, maxTreeDepth: 96 });
  return typeof s === 'string' ? s : JSON.stringify(s);
}

// 机器上可能同时有好几个 Chrome 实例（历史测试残留），ocu 有概率抓到别的窗口。
// 所以只认「当前标签页 URL 是 BOSS 职位列表」的那棵树，抓错就重试。
async function state(tries) {
  var n = tries || 8;
  for (var i = 0; i < n; i++) {
    var t = '';
    try { t = await rawState(); } catch (e) { t = ''; }
    if (t.indexOf(JOBS_URL) >= 0) return t;
    if (i < n - 1) await sleep(1200);
  }
  throw new Error('Chrome 当前不是 BOSS 职位列表页（可能抓到别的 Chrome 实例，或标签页被切走了）');
}

function leadIdx(line) { var m = /^\s*(\d+)\s/.exec(line); return m ? Number(m[1]) : -1; }

// ---- 解析 ----
function parseCards(t) {
  var ls = t.split('\n'), out = [], seen = {};
  for (var i = 0; i < ls.length; i++) {
    var m = CARD_RE.exec(ls[i]);
    if (m && !seen[m[3]]) { seen[m[3]] = 1; out.push({ idx: Number(m[1]), title: m[2].trim(), id: m[3] }); }
  }
  return out;
}

// 当前右侧详情面板对应哪个岗位（以「查看更多信息」的 job_detail id 为准）
function detailInfo(t) {
  var ls = t.split('\n');
  var id = '', boss = '', company = '', button = '', buttonIdx = -1;
  for (var i = 0; i < ls.length; i++) {
    var mMore = MORE_RE.exec(ls[i]);
    if (mMore && !id) id = mMore[1].replace(/\.html$/, '');
    if (buttonIdx < 0 && ls[i].indexOf('link [立即沟通]') >= 0) { buttonIdx = leadIdx(ls[i]); button = '立即沟通'; }
    if (buttonIdx < 0 && ls[i].indexOf('link [继续沟通]') >= 0) { buttonIdx = leadIdx(ls[i]); button = '继续沟通'; }
    var mBoss = /标题\s+(\S+)\s+.*活跃/.exec(ls[i]);
    if (mBoss && !boss) boss = mBoss[1];
    var mCo = /文本\s+([^\s].*?)\s+·\s+/.exec(ls[i]);
    if (mCo && !company) company = mCo[1];
  }
  return { id: id, boss: boss, company: company, button: button, buttonIdx: buttonIdx };
}

function dialogInfo(t) {
  var ls = t.split('\n'), start = -1;
  for (var i = 0; i < ls.length; i++) { if (ls[i].indexOf(DIALOG_MARK) >= 0) { start = i; break; } }
  if (start < 0) return null;
  var closeIdx = -1, stayIdx = -1;
  for (var j = start; j < Math.min(ls.length, start + 40); j++) {
    if (closeIdx < 0) {
      var m = /^\s*(\d+)\s+button\b.*Frame: x=(-?\d+), y=(-?\d+), w=(\d+), h=(\d+)/.exec(ls[j]);
      if (m) closeIdx = Number(m[1]);
    }
    if (ls[j].indexOf('留在此页') >= 0 && ls[j].indexOf('继续沟通') >= 0) {
      stayIdx = leadIdx(ls[j]);
      break;
    }
  }
  return { closeIdx: closeIdx, stayIdx: stayIdx };
}

function hasDialog(t) { return t.indexOf(DIALOG_MARK) >= 0; }

// ---- 动作 ----
// 关掉「已向BOSS发送消息」弹窗：优先点弹窗里的 x，退而点「留在此页」那行的容器；
// 每一轮都重新取状态，确认它真的消失了才算成功。
async function closeDialog(t) {
  var d = dialogInfo(t);
  if (!d) return { ok: true, already: true, how: 'none' };
  for (var round = 0; round < 4; round++) {
    var idx = d.closeIdx > 0 ? d.closeIdx : d.stayIdx;
    var how = d.closeIdx > 0 ? 'close-button' : 'stay-text';
    if (idx > 0) {
      try { await app.click(idx, { clickMethod: 'accessibility' }); } catch (e) { how = 'click-error'; }
      await sleep(rand(700, 1100));
    }
    var s = await rawState();
    if (!hasDialog(s)) return { ok: true, how: how, rounds: round + 1 };
    d = dialogInfo(s) || { closeIdx: -1, stayIdx: -1 };
  }
  return { ok: false, how: 'failed' };
}

// 点一个元素并等条件成立；每次循环都重新取状态、重新解析 index（index 不跨调用复用）
async function clickUntil(resolveIdx, done, opts) {
  var o = opts || {};
  var tries = o.tries || 3, gap = o.gap || 900;
  for (var i = 0; i < tries; i++) {
    var t = await rawState();
    if (done(t)) return { ok: true, t: t, tries: i };
    var idx = resolveIdx(t);
    if (!(idx > 0)) { await sleep(gap); continue; }
    try { await app.click(idx, { clickMethod: 'accessibility' }); } catch (e) {}
    await sleep(gap + rand(0, 400));
    var t2 = await rawState();
    if (done(t2)) return { ok: true, t: t2, tries: i + 1 };
  }
  return { ok: false, t: await rawState() };
}

// ---- 主流程 ----
var results = [];
var sent = 0;
var t0 = await state();

// 护栏：命中验证码/安全页立即中止，绝不尝试自动过滑块
(function () {
  var m = /URL: (https:\/\/www\.zhipin\.com[^\s,)]*)/.exec(t0);
  var u = m ? m[1] : '';
  if (u.indexOf('verify') >= 0 || u.indexOf('security') >= 0) {
    nodeRepl.write(JSON.stringify({ ok: false, blocked: 'verify', url: u, results: [] }, null, 1));
    throw new Error('命中验证页，已中止');
  }
})();

// 开场先清掉可能残留的弹窗，否则后面所有点击都会被遮罩吃掉
if (hasDialog(t0)) {
  var c0 = await closeDialog(t0);
  if (!c0.ok) {
    nodeRepl.write(JSON.stringify({ ok: false, error: '开场弹窗关不掉，放弃（避免在被遮罩的页面上瞎点）', results: [] }));
    throw new Error('stale dialog cannot be closed');
  }
  t0 = await state();
}

var cards = parseCards(t0).filter(function (j) {
  return !SKIP[j.id] && !BAD_DEGREE.test(j.title) && !BAD_EXP.test(j.title) && WANT.test(j.title);
});

for (var n = 0; n < cards.length && n < MAXCARDS && sent < LIMIT; n++) {
  var j = cards[n];
  var rec = { id: j.id, title: j.title };
  try {
    // 1) 点卡片，并确认右侧详情真的切换到了这个岗位
    var pick = await clickUntil(
      function (t) {
        // 必须精确匹配「卡片链接」，不能只 indexOf 到 job_detail id ——
        // 右侧详情的「查看更多信息」链接也含同一个 id，点它会新开标签页（明令禁止）。
        var ls = t.split('\n');
        for (var i = 0; i < ls.length; i++) {
          var m = CARD_RE.exec(ls[i]);
          if (m && m[3] === j.id) return Number(m[1]);
        }
        return -1;
      },
      function (t) { return detailInfo(t).id === j.id; },
      { tries: 3, gap: 1300 }
    );
    // 详情面板是异步渲染的：id（查看更多信息）先出现，招聘方信息可能晚半拍。
    // 所以确认切换后再补读一次，尽量把 boss/company 拿全（外层靠它做归属核对）。
    var settled = pick.t;
    if (pick.ok) { await sleep(rand(500, 900)); settled = await rawState(); }
    var d = detailInfo(settled);
    rec.detailId = d.id;
    rec.boss = d.boss;
    rec.company = d.company;
    if (!pick.ok || d.id !== j.id) { rec.r = '详情未切换'; results.push(rec); continue; }

    // 2) 已经联系过的岗位，按钮是「继续沟通」；千万别点，那是去聊天页
    if (d.button === '继续沟通') { rec.r = '已联系过'; results.push(rec); continue; }
    if (d.buttonIdx < 0) { rec.r = '无立即沟通按钮'; results.push(rec); continue; }

    // 3) 点之前再确认一次没有残留弹窗
    if (hasDialog(pick.t)) {
      var cd = await closeDialog(pick.t);
      if (!cd.ok) { rec.r = '弹窗关不掉'; results.push(rec); continue; }
    }

    // 试运行：到这里就够了，不再往下点（不消耗真实配额）
    if (DRY) { rec.r = 'dry-run:详情校验通过'; results.push(rec); continue; }

    // 4) 点「立即沟通」，以「弹窗从无到有」作为受理信号
    var fire = await clickUntil(
      function (t) { return detailInfo(t).buttonIdx; },
      function (t) { return hasDialog(t); },
      { tries: 3, gap: 1400 }
    );
    rec.dialog = hasDialog(fire.t);
    if (!fire.ok) { rec.r = '点击未生效'; results.push(rec); await sleep(rand(800, 1400)); continue; }

    // 5) 立刻关掉弹窗，否则下一条又会被遮罩吃掉
    var closed = await closeDialog(fire.t);
    rec.dialogClosed = closed.ok;
    rec.dialogClosedBy = closed.how;
    rec.r = closed.ok ? '已受理待核对' : '已受理但弹窗关不掉';
    rec.sent = true;
    sent++;
    results.push(rec);
    await sleep(rand(1500, 2600));
  } catch (e) {
    rec.r = '异常:' + String(e && e.message ? e.message : e).slice(0, 120);
    results.push(rec);
  }
}

nodeRepl.write(JSON.stringify({ ok: true, sent: sent, results: results }, null, 1));