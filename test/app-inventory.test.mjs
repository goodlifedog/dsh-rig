'use strict';
// 应用清点：把安装清单、预设、历史矩阵报告对到一起，逻辑错了会误导「适配进度」
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeName,
  nextProbeCommands,
  flattenPresets,
  classifyApp,
  mergeInventory,
  renderInventoryMarkdown,
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
  assert.ok(md.includes('| 应用 | 门类 | 状态 | 建议控法 | 说明 |'));
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
