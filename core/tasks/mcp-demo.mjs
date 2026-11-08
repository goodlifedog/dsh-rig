/**
 * 通过 MCP 接口演示 ocu 工具调用
 */
'use strict';
// MCP 常驻连接演示：对比「每次 spawn CLI」与「一次握手后连续调用」。
import { getOcuMcp, closeOcuMcp } from '../ocu-mcp.mjs';
import { isAppRunning } from '../background.mjs';
import { requireAppRunning, reportAppPresence } from '../app-presence.mjs';

async function main() {
  // 目标应用没在跑就跳过：get_app_state 对未运行的应用会把它拉起来并顶到前台。
  // 检查放在握手之前——连 ocu 进程都不必起（本 demo 只读，绝不为测试启动应用）。
  const target = process.env.TARGET_APP || 'Google Chrome';
  const presence = await requireAppRunning(target, { isAppRunning });
  if (reportAppPresence(presence)) {
    console.log(JSON.stringify({ ok: true, skipped: true, reason: 'app-not-running', app: target }));
    return;
  }
  const started = Date.now();
  const mcp = await getOcuMcp();
  const handshakeMs = Date.now() - started;
  console.log('握手耗时:', handshakeMs, 'ms');
  console.log('服务端:', mcp.serverInfo && mcp.serverInfo.serverInfo ? mcp.serverInfo.serverInfo.name : '(未提供)');
  console.log('工具数:', mcp.tools.length);
  console.log('工具:', mcp.tools.map((t) => t.name).join(', '));

  const t1 = Date.now();
  const apps = await mcp.callTool('list_apps', {});
  const listMs = Date.now() - t1;
  // list_apps 返回的是纯文本，一行一个应用
  const appCount = (apps.text || '').split('\n').filter((l) => l.trim()).length;
  console.log('list_apps:', listMs, 'ms, 应用数:', appCount);

  const t2 = Date.now();
  const state = await mcp.callTool('get_app_state', { app: target, include_screenshot: false }, 45000);
  const stateMs = Date.now() - t2;
  const text = state.text || '';
  console.log('get_app_state:', stateMs, 'ms, 返回', text.length, '字符');

  const t3 = Date.now();
  const again = await mcp.callTool('list_apps', {});
  console.log('第二次 list_apps:', Date.now() - t3, 'ms（复用同一会话，无进程启动开销）');

  await closeOcuMcp();
  console.log(JSON.stringify({
    ok: appCount > 0 && text.length > 0,
    handshakeMs, listMs, stateMs, tools: mcp.tools.length, appCount,
  }));
}

main().catch(async (e) => { await closeOcuMcp(); console.error('FAIL:', e.message); process.exit(1); });