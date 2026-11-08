'use strict';
// 核对器：打开 BOSS 消息页，读出最近会话（时间 + 对象 + 预览），作为「是否真的发出去了」的唯一依据。
//
// 注意：这里用的是**专用离屏 Chrome**（core/browser.mjs，独立 profile），
// 只读取消息列表，不碰用户正在用的窗口；同一个 BOSS 账号，所以看到的就是真实会话状态。
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from '../browser.mjs';
import { isDirectRun } from '../direct-run.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROFILE = process.env.AGENT_CHROME_PROFILE || (process.env.HOME + '/.desktop-agent/chrome-profile');

const CHAT_URL = 'https://www.zhipin.com/web/geek/chat';

// 会话项形如： "12:49 潘雪娇智云食品有限责任公司人资 [送达] 您好，我是…"
const TIME_RE = /^(\d{1,2}:\d{2}|\d{1,2}月\d{1,2}日|昨天|前天|刚刚)\s*/;

const EXPR = 'JSON.stringify(Array.from(document.querySelectorAll(".user-list li, [class*=user-item]"))' +
  '.slice(0, LIMIT).map(function(e){return (e.innerText||"").replace(/\\s+/g," ").trim();}))';

export function normalizeItem(raw) {
  const text = String(raw || '').replace(/\s+/g, ' ').trim();
  const m = TIME_RE.exec(text);
  const time = m ? m[1] : '';
  const body = m ? text.slice(m[0].length) : text;
  // who = 时间之后的「姓名+公司+职位」，遇到状态标记 [送达]/[已读]/[新招呼] 就截断
  const who = body.split(/ \[/)[0].trim();
  return { raw: text, time, body, who };
}

/**
 * 读消息列表。返回 [{ raw, time, body, who }]。
 * 会轮询等列表渲染（首次加载 BOSS 会先白屏 2~5 秒）。
 */
export async function readChatItems(limit = 12) {
  const b = await launch({ userDataDir: PROFILE, port: 0, profileDirectory: 'Profile 1', timeoutMs: 60000 });
  try {
    const p = await b.connect({ timeoutMs: 30000 });
    await p.send('Page.enable');
    await p.send('Page.navigate', { url: CHAT_URL });

    let items = [];
    let sawLogin = false;
    const started = Date.now();
    while (Date.now() - started < 35000) {
      await new Promise((r) => setTimeout(r, 1200));
      try {
        const r = await p.send('Runtime.evaluate', {
          expression: EXPR.replace('LIMIT', String(limit)),
          returnByValue: true,
        });
        const raw = r && r.result && r.result.value;
        if (raw) {
          const arr = JSON.parse(raw);
          if (arr.length) { items = arr; break; }
        }
        const lr = await p.send('Runtime.evaluate', {
          expression: 'document.body ? document.body.innerText.indexOf("扫码登录") >= 0 || document.body.innerText.indexOf("请登录") >= 0 : false',
          returnByValue: true,
        });
        if (lr && lr.result && lr.result.value) { sawLogin = true; break; }
      } catch { /* 页面还在加载 */ }
    }
    if (!items.length) {
      throw new Error(sawLogin
        ? '消息页要求登录：专用 Chrome profile 登录态失效了（需要手动在 ~/.desktop-agent/chrome-profile 里登录一次）'
        : '消息列表 35 秒内没渲染出任何会话，无法核对（不要当成「没送达」，先查网络/登录态）');
    }
    return items.map(normalizeItem);
  } finally {
    await b.close().catch(() => {});
  }
}

/** 兼容旧接口：只要文本列表 */
export async function readChatList(limit = 12) {
  const items = await readChatItems(limit);
  return items.map((x) => x.raw);
}

/**
 * 前后差集：who 新出现的会话，以及 who 相同但内容变了的会话。
 * 新增会话是「新打招呼」的正常表现；同一个人内容变化 = 追加了消息。
 */
export function diffChat(before, after) {
  const bMap = new Map();
  for (const it of before) bMap.set(it.who, it.raw);
  const fresh = [];
  const changed = [];
  for (const it of after) {
    if (!bMap.has(it.who)) fresh.push(it);
    else if (bMap.get(it.who) !== it.raw) changed.push(it);
  }
  return { fresh, changed };
}

// 直接运行：打印当前会话列表
const isMain = isDirectRun(import.meta.url);
if (isMain) {
  readChatItems(12)
    .then((list) => { console.log(JSON.stringify(list, null, 1)); })
    .catch((e) => { console.error('FAIL', e.message); process.exit(1); });
}
