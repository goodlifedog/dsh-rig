'use strict';
// 应用清点：把安装清单、预设、历史矩阵报告对到一起，逻辑错了会误导「适配进度」
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeName,
  nextProbeCommands,
  checkStrategyConsistency,
  flattenPresets,
  classifyApp,
  summarizeByFamily,
  mergeInventory,
  renderInventoryMarkdown,
  annotateRisk,
} from '../core/app-inventory.mjs';

test('名字归一化：去 .app、去多余空白、转小写', () => {
  assert.equal(normalizeName('Pages Creator Studio.app'), 'pages creator studio');
  assert.equal(normalizeName('  WeChat   .app '), 'wechat');
  assert.equal(normalizeName(''), '');
});

test('预设摊平：同一 bundle 只留第一次出现', () => {
  const flat = flattenPresets({
    im: [{ name: 'QQ', bundle: 'com.tencent.qq', process: 'QQ' }],
    system: [{ name: 'QQ 副本', bundle: 'com.tencent.qq', process: 'QQ' }],
  });
  assert.equal(flat.length, 1);
  assert.equal(flat[0].preset, 'im');
});

test('状态判定：特殊处理优先于一切', () => {
  assert.equal(classifyApp({ tested: { readable: true }, special: { status: '不动' } }), '不动');
});

test('状态判定：没装 / 没测 / 测过但跳过', () => {
  assert.equal(classifyApp({ installed: false }), '未安装');
  assert.equal(classifyApp({ tested: null }), '未测');
  assert.equal(classifyApp({ tested: { skipped: true } }), '未测');
});

test('状态判定：读不到树但有画面 → 可只用画面；连画面都没有 → 限制', () => {
  assert.equal(classifyApp({ tested: { readable: false, capture: 'live' } }), '可只用画面');
  assert.equal(classifyApp({ tested: { readable: false, capture: 'offscreen' } }), '可只用画面');
  assert.equal(classifyApp({ tested: { readable: false, capture: 'none' } }), '限制');
  assert.equal(classifyApp({ tested: { readable: true, nodes: 12 } }), '已适配');
});

test('状态判定：electron/chromium 读不到树，只有 CDP 实测可用才算专用方案', () => {
  const row = { readable: false, capture: 'none', launch: 'launched' };
  assert.equal(classifyApp({ tested: row, runtime: 'electron', cdpStatus: 'ok' }), '专用方案');
  assert.equal(classifyApp({ tested: row, runtime: 'chromium', cdpStatus: 'ok' }), '专用方案');
  assert.equal(classifyApp({ tested: row, runtime: 'electron' }), '限制', '没验证过 CDP 只能是限制');
  assert.equal(classifyApp({ tested: row, runtime: 'electron', cdpStatus: 'cdp-unavailable' }), '限制', '端口没起来就是不可控');
  assert.equal(classifyApp({ tested: row, runtime: 'native' }), '限制');
  assert.equal(classifyApp({ tested: row, runtime: 'qt' }), '限制');
});

test('状态判定：启动就退/根本起不来，运行时再对也还是限制', () => {
  assert.equal(classifyApp({ tested: { readable: false, capture: 'none', selfExited: true }, runtime: 'electron', cdpStatus: 'ok' }), '限制');
  assert.equal(classifyApp({ tested: { readable: false, capture: 'none', launch: 'error' }, runtime: 'electron', cdpStatus: 'ok' }), '限制');
});

test('合并：运行时族与 CDP 实测结果都要带到行里，状态与策略不矛盾', () => {
  const tested = [{ app: 'Antigravity', bundle: 'com.google.antigravity', readable: false, capture: 'none', launch: 'launched', nodes: 0 }];
  const presetApps = [{ name: 'Antigravity', bundle: 'com.google.antigravity', process: 'Antigravity', preset: 'dev' }];
  const installed = [{ name: 'Antigravity', bundle: 'com.google.antigravity', runtime: 'electron' }];
  const rows = mergeInventory({
    installed,
    presetApps,
    tested,
    cdpByBundle: { 'com.google.antigravity': { status: 'cdp-unavailable', detail: '端口没起来' } },
  });
  assert.equal(rows[0].runtime, 'electron');
  assert.equal(rows[0].cdpStatus, 'cdp-unavailable');
  assert.equal(rows[0].status, '限制');
  assert.equal(rows[0].strategy, 'blocked');
  assert.ok(rows[0].detail.includes('端口没起来'), 'CDP 实测结果要写进说明，不能只给个「限制」');
  assert.deepEqual(checkStrategyConsistency(rows), []);
  // CDP 真跑通的才算专用方案
  const okRows = mergeInventory({
    installed,
    presetApps,
    tested,
    cdpByBundle: { 'com.google.antigravity': { status: 'ok' } },
  });
  assert.equal(okRows[0].status, '专用方案');
  assert.equal(okRows[0].strategy, 'dedicated');
  assert.deepEqual(checkStrategyConsistency(okRows), []);
});

test('合并：包名对得上，测过的行带节点与画面', () => {
  const rows = mergeInventory({
    installed: [{ name: 'FastZip', bundle: 'cn.better365.FastZip' }],
    presetApps: [{ name: 'FastZip', bundle: 'cn.better365.FastZip', process: 'FastZip', preset: 'tools' }],
    tested: [{ app: 'FastZip', bundle: 'cn.better365.FastZip', readable: true, nodes: 51, buttons: 7, capture: 'live' }],
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, '已适配');
  assert.ok(rows[0].detail.includes('节点 51'));
  assert.ok(rows[0].detail.includes('live'));
});

test('合并：包名过期时按名字兜底，并如实提示', () => {
  const rows = mergeInventory({
    installed: [{ name: 'Pages Creator Studio', bundle: 'com.apple.Pages' }],
    presetApps: [{ name: 'Pages Creator Studio', bundle: 'com.apple.iWork.Pages', process: 'Pages', preset: 'office' }],
    tested: [],
  });
  assert.equal(rows.length, 1, '不能因为包名过期就把应用算成两个');
  assert.equal(rows[0].installed, true);
  assert.equal(rows[0].status, '未测');
  assert.equal(rows[0].bundle, 'com.apple.Pages');
  assert.ok(rows[0].detail.includes('预设包名过期'));
});

test('合并：装了但不在预设里的也要列出来', () => {
  const rows = mergeInventory({
    installed: [{ name: 'Google Chrome', bundle: 'com.google.Chrome' }],
    presetApps: [],
    tested: [],
    special: { 'com.google.Chrome': { status: '专用方案', detail: '走 headless 实例' } },
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, '专用方案');
  assert.ok(rows[0].detail.includes('headless'));
  assert.equal(rows[0].preset, '');
});

test('合并：没装的应用照样出现在清点里', () => {
  const rows = mergeInventory({
    installed: [],
    presetApps: [{ name: 'GarageBand', bundle: 'com.apple.garageband10', process: 'GarageBand', preset: 'media' }],
    tested: [],
  });
  assert.equal(rows[0].status, '未安装');
  assert.ok(rows[0].detail.includes('没装'));
});

test('报告渲染：有表头、有状态列、汇总按顺序', () => {
  const md = renderInventoryMarkdown([
    { name: 'A', preset: 'im', status: '未测', detail: '装了但还没测' },
    { name: 'B', preset: '', status: '不动', detail: '代理工具' },
    { name: 'C', preset: 'dev', status: '已适配', detail: '节点 9' },
  ], { matrixReport: 'reports/app-matrix-x.json' });
  assert.ok(md.includes('| 应用 | 门类 | 运行时 | 状态 | 建议控法 | 说明 |'));
  assert.ok(md.indexOf('已适配') < md.indexOf('不动'), '汇总按 已适配→不动 排序');
  assert.ok(md.includes('汇总：已适配 1，不动 1，未测 1'));
});
test('给未测应用生成补测命令，跳过没装/不动的', () => {
  const cmds = nextProbeCommands([
    { name: 'GarageBand', bundle: 'com.apple.garageband10', process: 'GarageBand', installed: true, status: '未测' },
    { name: 'UURemote', bundle: 'com.netease.uuremote', process: 'UURemote', installed: true, status: '未测' },
    { name: '没装的', bundle: 'x.y', process: 'x', installed: false, status: '未安装' },
    { name: 'Clash', bundle: 'a.b', process: 'clash', installed: true, status: '不动' },
  ]);
  assert.equal(cmds.length, 1);
  assert.ok(cmds[0].startsWith('MATRIX_APPS_JSON='));
  assert.ok(cmds[0].includes('GarageBand'));
  assert.ok(!cmds[0].includes('没装的'));
  assert.ok(!cmds[0].includes('Clash'));
  assert.ok(cmds[0].endsWith('npm run matrix'));
});

test('没有未测应用：不生成命令', () => {
  assert.deepEqual(nextProbeCommands([{ name: 'A', status: '已适配', installed: true }]), []);
  assert.deepEqual(nextProbeCommands([]), []);
});

test('报告里的下一步补测段落只对未测应用出现', () => {
  const withPending = renderInventoryMarkdown([
    { name: 'A', preset: 'media', status: '未测', installed: true, bundle: 'a.b', process: 'a', detail: '装了但还没测' },
  ]);
  assert.ok(withPending.includes('## 下一步补测'));
  assert.ok(withPending.includes('npm run matrix'));
  const noPending = renderInventoryMarkdown([
    { name: 'B', preset: 'im', status: '已适配', installed: true, detail: '节点 9' },
  ]);
  assert.ok(!noPending.includes('下一步补测'));
});
test('按运行时族汇总：计数、默认通道链、未识别族兜底', () => {
  const rows = [
    { name: 'Notes', runtime: 'native', status: '已适配' },
    { name: 'Calculator', runtime: 'native', status: '已适配' },
    { name: 'Keynote', runtime: 'native', status: '可只用画面' },
    { name: 'ChatGPT', runtime: 'electron', status: '已适配' },
    { name: 'Antigravity', runtime: 'electron', status: '限制' },
    { name: 'Chrome', runtime: 'chromium', status: '专用方案' },
    { name: 'Safari', runtime: '', status: '可只用画面' },
  ];
  const families = summarizeByFamily(rows);
  const native = families.find((f) => f.family === 'native');
  assert.equal(native.total, 3);
  assert.equal(native.adapted, 2);
  assert.equal(native.visual, 1);
  assert.equal(native.chain, 'ax → applescript → visual');
  const electron = families.find((f) => f.family === 'electron');
  assert.equal(electron.limited, 1);
  assert.equal(electron.chain, 'ax → cdp → applescript → visual');
  const unknown = families.find((f) => f.family === '未识别');
  assert.equal(unknown.total, 1, '没有运行时信息的应用不能丢');
  assert.equal(unknown.chain, '-');
  assert.equal(families[0].family, 'native', '按族固定顺序排，native 在前');
});

test('报告里要有一段按运行时族的适配汇总', () => {
  const md = renderInventoryMarkdown([
    { name: 'Notes', preset: 'system', runtime: 'native', status: '已适配', strategy: 'ax', detail: 'ok' },
    { name: 'ChatGPT', preset: 'im', runtime: 'electron', status: '已适配', strategy: 'ax', detail: 'ok' },
  ]);
  assert.ok(md.includes('## 按运行时族看适配'));
  assert.ok(md.includes('| 运行时族 | 装了几个 |'));
  assert.ok(md.includes('ax → cdp → applescript → visual'), '要写清每族默认通道顺序');
});

test('状态与建议控法一致时没有问题', () => {
  const problems = checkStrategyConsistency([
    { name: 'A', status: '已适配', strategy: 'ax' },
    { name: 'B', status: '已适配', strategy: 'ax-read' },
    { name: 'C', status: '可只用画面', strategy: 'visual' },
    { name: 'D', status: '专用方案', strategy: 'dedicated' },
    { name: 'E', status: '不动', strategy: 'no-touch' },
    { name: 'F', status: '限制', strategy: 'blocked' },
    { name: 'G', status: '未测', strategy: 'unknown' },
    { name: 'H', status: '未安装', strategy: 'unknown' },
  ]);
  assert.deepEqual(problems, []);
});

test('自相矛盾的状态要被挑出来（比如已适配却只能画面操作）', () => {
  const problems = checkStrategyConsistency([
    { name: 'Keynote', status: '已适配', strategy: 'blocked' },
  ]);
  assert.equal(problems.length, 1);
  assert.ok(problems[0].reason.includes('已适配'));
  assert.ok(problems[0].reason.includes('blocked'));
});

test('报告里会写出策略一致性结论', () => {
  const good = renderInventoryMarkdown([{ name: 'A', status: '已适配', strategy: 'ax', detail: 'ok' }]);
  assert.ok(good.includes('状态与建议控法一致'));
  const bad = renderInventoryMarkdown([{ name: 'B', status: '已适配', strategy: 'visual', detail: 'x' }]);
  assert.ok(bad.includes('不一致'));
});
test('风险名单标注：生效的标出「默认跳过读取」，过期的/不在名单的不标', () => {
  const now = 1_800_000_000_000;
  const state = {
    apps: {
      ChatGPT: { count: 3, expiresAt: now + 5 * 86400000 },
      Expired: { count: 1, expiresAt: now - 1000 },
    },
  };
  const rows = annotateRisk([
    { name: 'ChatGPT', bundle: 'com.openai.codex', detail: '节点 13' },
    { name: 'Expired', bundle: 'x.y', detail: '' },
    { name: 'Calculator', bundle: 'com.apple.calculator', detail: '节点 37' },
  ], state, now);
  assert.equal(rows[0].riskSkip, true);
  assert.match(rows[0].detail, /读取会抢前台/);
  assert.match(rows[0].detail, /节点 13/, '原有说明不能丢');
  assert.equal(rows[1].riskSkip, undefined);
  assert.equal(rows[2].riskSkip, undefined);
});

test('风险名单标注：按 bundle 也能命中（名字本地化变了也不漏）', () => {
  const now = 1_800_000_000_000;
  const state = { apps: { 'WPS Office': { count: 1, expiresAt: now + 86400000 } } };
  const rows = annotateRisk([{ name: 'wpsoffice', bundle: 'com.kingsoft.wpsoffice.mac', detail: '' }], state, now);
  assert.equal(rows[0].riskSkip, true);
});
