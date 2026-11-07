#!/usr/bin/env node
/**
 * 驱动另一个 agent 工具：把一个提示词送进桌面 agent 应用，等它回复，再读回来。
 *
 *   node core/tasks/drive-agent.mjs
 *   AGENT_APP=ChatGPT AGENT_PROMPT="只回复两个字：收到" node core/tasks/drive-agent.mjs
 *
 * 全程后台：不激活应用、不抢前台；窗口镜像到小窗方便观察。
 */
import { execFileSync } from 'node:child_process';
import { getOcuMcp, closeOcuMcp } from '../ocu-mcp.mjs';
import { restoreFront } from '../front-watch.mjs';
import { isScreenLocked } from '../platform.mjs';
import { localHeaders } from '../local-token.mjs';

const APP = process.env.AGENT_APP || 'ChatGPT';
const PROMPT = process.env.AGENT_PROMPT || '只回复两个字：收到';
const SESSION = 'agent-drive';
const OVERLAY = process.env.OVERLAY_URL || 'http://127.0.0.1:7788';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function front() {
  try {
    return execFileSync('/usr/bin/osascript', ['-e', 'tell application "System Events" to get name of first process whose frontmost is true'], { encoding: 'utf8' }).trim();
  } catch { return '(unknown)'; }
}
const getJson = async (url) => {
  try { return await (await fetch(url, { headers: localHeaders(), signal: AbortSignal.timeout(3000) })).json(); } catch { return null; }
};
const post = (pathname, body) => fetch(OVERLAY + pathname, {
  method: 'POST',
  headers: localHeaders({ 'Content-Type': 'application/json' }),
  body: JSON.stringify(body || {}),
  signal: AbortSignal.timeout(5000),
}).then((r) => r.json()).catch(() => null);

const steps = [];
function record(name, ok, detail) {
  steps.push({ name, ok, detail: detail || '' });
  console.log((ok ? '  ✅ ' : '  ❌ ') + name + (detail ? '  ' + detail : ''));
}

async function findWindowId(ownerPattern) {
  const list = await getJson(OVERLAY + '/windows');
  const win = ((list && list.windows) || []).find((w) => ownerPattern.test(w.owner || w.title || ''));
  return win ? win.windowId : null;
}

async function main() {
  if (await isScreenLocked()) {
    console.log('环境跳过：屏幕已锁，AX 与键盘通路不可用，等解锁后再跑');
    return;
  }

  const before = front();
  const titleHint = (await getJson(OVERLAY + '/health?session=__none__'))?.dshTitle || '';
  console.log('目标 agent:', APP, '| 提示词:', PROMPT, '| 起点前台:', before);

  // 镜像窗口（用户能看见 agent 在动）
  const windowId = await findWindowId(new RegExp(APP, 'i'));
  if (windowId) {
    await post('/status', { session: SESSION, text: APP + '：后台驱动中', titleHint });
    await post('/window', { session: SESSION, windowId });
    await post('/visible', { session: SESSION, visible: true });
    await sleep(1200);
    const h = await getJson(OVERLAY + '/health?session=' + SESSION);
    record('窗口镜像到小窗', Boolean(h && h.thumbnail && h.thumbnail.state === 'live'), 'state=' + (h && h.thumbnail && h.thumbnail.state));
  } else {
    record('窗口镜像到小窗', false, '没找到窗口');
  }

  const m = await getOcuMcp();

  // 找输入区
  const ta = await m.callTool('query', { app: APP, role: 'AXTextArea', limit: 5, max_nodes: 12000 });
  const area = ((ta.json && ta.json.matches) || [])[0];
  record('找到输入区', Boolean(area), area ? 'index=' + area.index : '没有文本区');
  if (!area) { await closeOcuMcp(); process.exitCode = 1; return; }

  // 写入提示词
  const sv = await m.callTool('set_value', { app: APP, element_index: String(area.index), value: PROMPT });
  const afterSet = front();
  if (afterSet !== before) await restoreFront(before);
  record('后台写入提示词', !sv.isError && afterSet === before, sv.isError ? '写入失败' : (afterSet === before ? '' : '前台被抢（已还原）'));
  await sleep(400);

  // 提交前先记一份界面树：回复用"新增内容"来识别，避免把界面上的固定文案当回复
  const baselineTree = String((await m.callTool('get_app_state', { app: APP, include_screenshot: false, max_tree_nodes: 12000 })).text || '');
  const baseline = new Set(baselineTree.split('\n').map((l) => l.trim()).filter(Boolean));

  // 提交（回车；有些应用需要发送按钮）
  const enter = await m.callTool('press_key', { app: APP, key: 'ENTER', key_method: 'sky_key' });
  const afterEnter = front();
  if (afterEnter !== before) await restoreFront(before);
  record('后台提交（回车）', !enter.isError && afterEnter === before, enter.isError ? '回车失败' : (afterEnter === before ? '' : '前台被抢（已还原）'));

  // 等回复：用「新增的行」识别（提交前没有、提交后出现的短文本）
  const started = Date.now();
  let reply = '';
  const CHROME = /ChatGPT|Codex|模型|模式|设置|返回|前进|搜索|新建|归档|置顶|项目|插件|资料库|图像|定时|首页|个人资料|更新|侧边栏|Window:|App=|菜单栏|按钮|文本输入区|container|Frame:/;
  for (let i = 0; i < 45; i += 1) {
    await sleep(1000);
    const st = await m.callTool('get_app_state', { app: APP, include_screenshot: false, max_tree_nodes: 12000 });
    const tree = String(st.text || '');
    const fresh = [];
    for (const raw of tree.split('\n')) {
      const line = raw.trim();
      if (!line || baseline.has(line)) continue;
      const text = (line.match(/^\d+\s+(?:文本|container[^\n]*?)\s*(.+)$/) || [])[1] || '';
      const clean = text.replace(/^\(settable[^)]*\)\s*/, '').trim();
      if (!clean || clean === PROMPT) continue;
      if (CHROME.test(clean)) continue;
      if (clean.length > 120) continue;
      fresh.push(clean);
    }
    if (fresh.length) {
      // 优先取最短的一句（回复通常很短，长的是界面描述）
      fresh.sort((a, b) => a.length - b.length);
      reply = fresh[0];
      break;
    }
  }
  record('读到 agent 回复', Boolean(reply), reply ? '「' + reply + '」用时 ' + Math.round((Date.now() - started) / 1000) + 's' : '45 秒内没读到');

  const end = front();
  record('全程前台未变', before === end, before + ' -> ' + end);

  const report = { ok: steps.every((s) => s.ok), app: APP, prompt: PROMPT, reply, frontStart: before, frontEnd: end, steps };
  console.log('\n' + JSON.stringify(report, null, 2));

  const keepMs = Number(process.env.AGENT_KEEP_MS || 8000);
  if (keepMs > 0) await sleep(keepMs);
  await post('/window', { session: SESSION, windowId: null });
  await post('/status', { session: SESSION, clear: true });
  await post('/visible', { session: SESSION, visible: false });
  await closeOcuMcp().catch(() => {});
  if (!report.ok) process.exitCode = 1;
}

main().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
