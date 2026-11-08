'use strict';
// H1 权限闸门：任务执行前先看权限，缺权限按「环境跳过」（exit 0/不是 FAIL），探测不出来不卡任务。
// 全部纯函数 / 注入探测，绝不真的跑 ocu doctor，也不碰屏幕。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  decidePermissionGate, permissionParamsFromCheckPermissions, probePermissions,
  inferTaskPermissionNeed, evaluateTaskPermissionGate, permissionSkipLines, stripSourceComments,
  overrideFromEnv, PERMISSION_SETTINGS, OVERRIDE_ENV, PERMISSION_KEYS,
} from '../core/permission-gate.mjs';

const AX = { accessibility: true, screenCapture: false };
const SC = { accessibility: false, screenCapture: true };

// ---------- decidePermissionGate：need 有/无 × perms true/false/undefined × override ----------

test('need 为空（任务不需要 AX/录屏）→ 放行，且不因 perms=false 拦（组合 1）', () => {
  for (const perms of [true, false, undefined, { accessibility: false, screenCapture: false }]) {
    const d = decidePermissionGate({ need: {}, perms });
    assert.equal(d.proceed, true, JSON.stringify(perms));
    assert.equal(d.skipped, false);
    assert.equal(d.warning, '');
    assert.deepEqual(d.missing, []);
  }
});

test('need AX + perms 已授权 → 放行且无 warning（组合 2）', () => {
  const d = decidePermissionGate({ need: AX, perms: { accessibility: true } });
  assert.equal(d.proceed, true);
  assert.equal(d.skipped, false);
  assert.equal(d.forced, false);
  assert.equal(d.warning, '');
  assert.equal(d.skipReason, '');
});

test('need AX + perms 明确缺失 → 环境跳过，提示指到辅助功能设置页（组合 3）', () => {
  const d = decidePermissionGate({ need: AX, perms: { accessibility: false }, allowOverride: false });
  assert.equal(d.proceed, false);
  assert.equal(d.skipped, true);
  assert.match(d.skipReason, /^环境跳过：/);
  assert.match(d.skipReason, /缺少辅助功能/);
  assert.match(d.skipReason, /隐私与安全性 → 辅助功能/);
  assert.ok(d.skipReason.includes(OVERRIDE_ENV), '要告诉用户临时忽略的开关');
  assert.deepEqual(d.missing, ['accessibility']);
  assert.equal(d.settings.length, 1);
  assert.match(d.settings[0].url, /Privacy_Accessibility/);
});

test('need AX + perms 缺失 + allowOverride → 放行但标 forced 且带 warning（组合 4）', () => {
  const d = decidePermissionGate({ need: AX, perms: { accessibility: false }, allowOverride: true });
  assert.equal(d.proceed, true);
  assert.equal(d.skipped, false);
  assert.equal(d.forced, true);
  assert.match(d.warning, /强制继续/);
  assert.match(d.warning, new RegExp(OVERRIDE_ENV));
});

test('need AX+录屏 + 只缺录屏 → 跳过原因只点名屏幕录制（组合 5）', () => {
  const d = decidePermissionGate({ need: { accessibility: true, screenCapture: true }, perms: { accessibility: true, screenCapture: false } });
  assert.equal(d.proceed, false);
  assert.match(d.skipReason, /屏幕录制/);
  assert.doesNotMatch(d.skipReason, /缺少辅助功能/);
  assert.match(d.skipReason, /隐私与安全性 → 屏幕录制/);
  assert.deepEqual(d.missing, ['screenCapture']);
  assert.match(d.settings[0].url, /Privacy_ScreenCapture/);
});

test('need AX+录屏 + 一个缺失一个探测不出来 → 缺的优先（仍然跳过）（组合 6）', () => {
  const d = decidePermissionGate({ need: { accessibility: true, screenCapture: true }, perms: { accessibility: undefined, screenCapture: false } });
  assert.equal(d.proceed, false);
  assert.equal(d.skipped, true);
  assert.deepEqual(d.missing, ['screenCapture']);
  assert.deepEqual(d.unknown, ['accessibility']);
});

test('need AX + perms 探测不出来（undefined）→ 放行 + warning，不卡任务（组合 7）', () => {
  const d = decidePermissionGate({ need: AX, perms: { accessibility: undefined } });
  assert.equal(d.proceed, true, '探测不出来绝不能卡任务');
  assert.equal(d.skipped, false);
  assert.match(d.warning, /探测不出来/);
  assert.match(d.warning, /ocu doctor/);
  assert.match(d.warning, /隐私与安全性 → 辅助功能/);
  assert.deepEqual(d.unknown, ['accessibility']);
});

test('perms 形状不对（null/字符串/缺键）按探测不出来处理（组合 8）', () => {
  for (const perms of [null, {}, { accessibility: null }, { accessibility: 'yes' }]) {
    const d = decidePermissionGate({ need: AX, perms });
    assert.equal(d.proceed, true, JSON.stringify(perms));
    assert.match(d.warning, /探测不出来/);
  }
});

test('override 不会把「探测不出来」变成 missing：仍然只给 warning', () => {
  const d = decidePermissionGate({ need: AX, perms: { accessibility: undefined }, allowOverride: true });
  assert.equal(d.proceed, true);
  assert.equal(d.forced, false);
  assert.match(d.warning, /探测不出来/);
});

// ---------- checkPermissions 结果 → perms 形状 ----------

test('permissionParamsFromCheckPermissions：授权/缺项/unknown/Windows/空结果', () => {
  assert.deepEqual(permissionParamsFromCheckPermissions({ ok: true, missing: [], platform: 'darwin' }), { accessibility: true, screenCapture: true });
  assert.deepEqual(permissionParamsFromCheckPermissions({ ok: false, missing: ['screenCapture'], platform: 'darwin' }), { accessibility: true, screenCapture: false });
  assert.deepEqual(permissionParamsFromCheckPermissions({ ok: false, missing: ['accessibility'], platform: 'darwin' }), { accessibility: false, screenCapture: true });
  assert.deepEqual(permissionParamsFromCheckPermissions({ ok: false, missing: ['unknown'], platform: 'darwin' }), { accessibility: undefined, screenCapture: undefined });
  assert.deepEqual(permissionParamsFromCheckPermissions(null), { accessibility: undefined, screenCapture: undefined });
  assert.deepEqual(permissionParamsFromCheckPermissions({ platform: 'windows' }), { accessibility: true, screenCapture: true }, 'Windows 无 TCC，不挡任务');
  assert.deepEqual(permissionParamsFromCheckPermissions({ platform: 'win32' }), { accessibility: true, screenCapture: true });
});

test('probePermissions：注入的探测抛错/超时按 undefined，不抛给调用方', async () => {
  const got = await probePermissions(async () => { throw new Error('ocu doctor 超时'); });
  assert.deepEqual(got, { accessibility: undefined, screenCapture: undefined });

  const ok = await probePermissions(async () => ({ ok: false, missing: ['accessibility'], platform: 'darwin' }));
  assert.deepEqual(ok, { accessibility: false, screenCapture: true });
});

// ---------- 任务需求静态推断 ----------

test('inferTaskPermissionNeed：AX 操作要辅助功能；ocu 截图/系统 screencapture 才要录屏', () => {
  assert.deepEqual(inferTaskPermissionNeed("await state('Calculator');"), { accessibility: true, screenCapture: false });
  assert.deepEqual(inferTaskPermissionNeed("await readSafe(APP); await click(APP, 1);"), { accessibility: true, screenCapture: false });
  assert.deepEqual(inferTaskPermissionNeed("const s = await ocu.call('get_app_state', { include_screenshot: true });"), { accessibility: true, screenCapture: true });
  assert.deepEqual(inferTaskPermissionNeed("exec('/usr/sbin/screencapture', ['-x']);"), { accessibility: false, screenCapture: true });
  // 纯 CDP 演示：Page.captureScreenshot 不是系统录屏权限，不需要挡
  assert.deepEqual(inferTaskPermissionNeed("await page.send('Page.captureScreenshot', { format: 'jpeg' });"), { accessibility: false, screenCapture: false });
  assert.deepEqual(inferTaskPermissionNeed('console.log(1);'), { accessibility: false, screenCapture: false });
});

// ---------- 编排：不需要就不探测；探测失败不卡 ----------

test('evaluateTaskPermissionGate：任务不需要权限时返回 null，且不调用探测', async () => {
  let probes = 0;
  const result = await evaluateTaskPermissionGate({
    source: "await page.send('Page.navigate', { url: 'about:blank' });",
    probe: async () => { probes += 1; return { accessibility: true, screenCapture: true }; },
  });
  assert.equal(result, null);
  assert.equal(probes, 0, '不需要权限的任务不该跑 ocu doctor');
});

test('evaluateTaskPermissionGate：需要权限且探测失败 → 放行 + warning（不卡任务）', async () => {
  const result = await evaluateTaskPermissionGate({
    source: "await state('Calculator');",
    probe: async () => { throw new Error('ocu 没装'); },
  });
  assert.ok(result, '有 need 就应返回判定');
  assert.equal(result.proceed, true);
  assert.match(result.warning, /探测不出来/);
});

test('evaluateTaskPermissionGate：需要权限且明确缺失 → skip 判定（调用方按 exit 0）', async () => {
  const result = await evaluateTaskPermissionGate({
    source: "await state('Calculator');",
    probe: async () => ({ accessibility: false, screenCapture: true }),
    allowOverride: false,
  });
  assert.equal(result.proceed, false);
  assert.equal(result.skipped, true);
  assert.match(result.skipReason, /环境跳过/);
});

// ---------- 展示/开关辅助 ----------

test('permissionSkipLines：原因一行 + 每个缺失权限一行设置页深链', () => {
  const d = decidePermissionGate({ need: { accessibility: true, screenCapture: true }, perms: { accessibility: false, screenCapture: false } });
  const lines = permissionSkipLines(d);
  assert.equal(lines.length, 3);
  assert.match(lines[0], /环境跳过/);
  assert.ok(lines.some((l) => l.includes(PERMISSION_SETTINGS.accessibility.path) && l.includes(PERMISSION_SETTINGS.accessibility.url)));
  assert.ok(lines.some((l) => l.includes(PERMISSION_SETTINGS.screenCapture.path) && l.includes(PERMISSION_SETTINGS.screenCapture.url)));
  assert.deepEqual(PERMISSION_KEYS, ['accessibility', 'screenCapture']);
});

test('overrideFromEnv：只有 AGENT_ALLOW_MISSING_PERMISSION=1 才算强制', () => {
  assert.equal(overrideFromEnv({ [OVERRIDE_ENV]: '1' }), true);
  assert.equal(overrideFromEnv({ [OVERRIDE_ENV]: '0' }), false);
  assert.equal(overrideFromEnv({}), false);
});

// ---------- 覆盖补齐：MCP callTool / ocu js 内层 cua.getApp / 外层 execFile(OCU,['js']) ----------

test('覆盖：mcp.callTool 的 AX 工具要辅助功能（get_app_state/query/click/type_text/set_value）', () => {
  for (const tool of ['get_app_state', 'query', 'click', 'type_text', 'set_value']) {
    const src = "const s = await mcp.callTool('" + tool + "', { app: 'Calculator' });";
    const need = inferTaskPermissionNeed(src);
    assert.equal(need.accessibility, true, tool);
    assert.equal(need.screenCapture, false, tool + ' 不该顺带要录屏');
  }
  // 只列应用（list_apps）不读界面，不该误判
  assert.equal(inferTaskPermissionNeed("await mcp.callTool('list_apps', {});").accessibility, false);
});

test('覆盖：ocu js 内层脚本里的 cua.getApp( 要辅助功能', () => {
  const src = [
    "execFile(OCU, ['js', '--file', innerPath]);",
    '// 内层 greet-inner.mjs:',
    "var app = await cua.getApp('Google Chrome', { initialState: false });",
    'var s = await app.getAXState({ emit: false });',
  ].join('\n');
  assert.deepEqual(inferTaskPermissionNeed(src), { accessibility: true, screenCapture: false });
});

test('覆盖：外层 execFile(OCU, [\'js\', …]) 要辅助功能（内层代码在单独文件时也拦得住）', () => {
  const src = [
    'await new Promise((resolve) => {',
    '  execFile(',
    '    OCU,',
    "    ['js', '--timeout', '60000', '--file', innerPath],",
    '    { timeout: 70000 },',
    '    () => resolve(),',
    '  );',
    '});',
  ].join('\n');
  assert.deepEqual(inferTaskPermissionNeed(src), { accessibility: true, screenCapture: false });
  // execFileSync / spawn 同类写法
  assert.equal(inferTaskPermissionNeed("execFileSync(OCU, ['js', '--file', p]);").accessibility, true);
  assert.equal(inferTaskPermissionNeed("spawn(resolveOcu(), ['js', '--file', p]);").accessibility, true);
  // 普通 js 文件名 / --js-flags 不能误判
  assert.equal(inferTaskPermissionNeed("execFile(node, ['script.js']);").accessibility, false);
  assert.equal(inferTaskPermissionNeed("spawn(CHROME_BIN, ['--js-flags=--expose-gc']);").accessibility, false);
});

test('覆盖：CDP / headless 写法不能被误判成需要 AX/录屏', () => {
  const cases = [
    "await page.send('Page.captureScreenshot', { format: 'jpeg' });",
    "await page.send('Page.navigate', { url: 'https://example.com' });",
    "const b = await launch({ userDataDir: PROFILE, headless: true });",
    "spawn(CHROME_BIN, ['--headless=new', '--remote-debugging-port=0']);",
    "const t = await cdp.listTargets();",
  ];
  for (const src of cases) {
    assert.deepEqual(inferTaskPermissionNeed(src), { accessibility: false, screenCapture: false }, src);
  }
});

test('dry-run 覆盖清单：真实任务里 mcp-demo / boss-greet 判需要 AX；CDP/headless 任务不误判', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const HERE = path.dirname(fileURLToPath(import.meta.url));
  const TASKS = path.join(HERE, '..', 'core', 'tasks');
  const readTask = (name) => fs.readFileSync(path.join(TASKS, name + '.mjs'), 'utf8');

  const need = (name) => inferTaskPermissionNeed(readTask(name)).accessibility;
  assert.equal(need('mcp-demo'), true, 'mcp.callTool(get_app_state) 必须判需要 AX');
  assert.equal(need('boss-greet'), true, "execFile(OCU, ['js', …]) 必须判需要 AX");
  for (const name of ['browser-demo', 'cdp-channel', 'parallel-demo', 'headless-demo']) {
    assert.equal(need(name), false, name + ' 是 CDP/headless，不能误判需要 AX');
  }
  // 统计：当前仓库至少 17 个任务需要 AX（旧口径 16 + 本次补齐的 mcp-demo/boss-greet 等）
  const names = fs.readdirSync(TASKS).filter((f) => f.endsWith('.mjs')).map((f) => f.replace(/\.mjs$/, ''));
  const needAX = names.filter((name) => inferTaskPermissionNeed(readTask(name)).accessibility);
  assert.ok(needAX.length >= 17, '需要 AX 的任务数 = ' + needAX.length);
});

// ---------- M3：录屏判定先剥注释（注释里的 screencapture 不算） ----------

test('M3 录屏判定：注释里的 screencapture / include_screenshot 不算需要录屏', () => {
  const cases = [
    '/**\n * 小窗画面来自 screencapture -l\n */\nconsole.log(1);',
    '// 之前用 include_screenshot: true 拿过画面\nconsole.log(1);',
    '/* includeScreenshot: true */\nconsole.log(1);',
    'const a = 1; /* 说明：会调 screencapture */ const b = 2;',
  ];
  for (const src of cases) {
    assert.equal(inferTaskPermissionNeed(src).screenCapture, false, JSON.stringify(src));
  }
});

test('M3 录屏判定：真实调用/真实参数仍然要录屏', () => {
  assert.equal(inferTaskPermissionNeed("execFileSync('/usr/sbin/screencapture', ['-x']);").screenCapture, true);
  assert.equal(inferTaskPermissionNeed("await ocu.call('get_app_state', { include_screenshot: true });").screenCapture, true);
  assert.equal(inferTaskPermissionNeed('const o = { includeScreenshot: true };').screenCapture, true);
});

test('M3 剥注释保留字符串/模板字符串与 URL 里的双斜杠', () => {
  assert.equal(stripSourceComments("const u = 'https://x/y'; // tail"), "const u = 'https://x/y'; ");
  assert.equal(inferTaskPermissionNeed('const s = "include_screenshot: true";').screenCapture, true, '字符串里的参数保留');
  const bt = String.fromCharCode(96);
  assert.equal(inferTaskPermissionNeed('const t = ' + bt + 'include_screenshot: true' + bt + ';').screenCapture, true, '模板字符串内容保留');
  assert.equal(inferTaskPermissionNeed('// a\nconst t = ' + bt + '\n screencapture -l\n' + bt + ';').screenCapture, true);
});

test('M3 回归：parallel-real-demo 只提注释里的 screencapture -l → 不再判需要录屏，且 AX 判定不变', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const HERE = path.dirname(fileURLToPath(import.meta.url));
  const src = fs.readFileSync(path.join(HERE, '..', 'core', 'tasks', 'parallel-real-demo.mjs'), 'utf8');
  const need = inferTaskPermissionNeed(src);
  assert.equal(need.screenCapture, false, '注释里的 screencapture -l 不能算需要录屏');
  assert.equal(need.accessibility, true, '该任务确实用 ocu/AX，AX 判定不受影响');
});
