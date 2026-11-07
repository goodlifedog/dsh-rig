'use strict';
/**
 * 应用清点：把「本机装了什么」「预设里有什么」「最近测过什么」对到一起，
 * 输出每个应用的状态，避免靠手写清单（一装新软件就过期）。
 *
 * 状态口径：
 *   未安装     —— 预设里有，但本机找不到
 *   未测       —— 装了，但最近的矩阵报告里没有它
 *   限制       —— 测过，但读不到界面树、也抓不到画面，或者启动即退（应用侧问题）
 *   可只用画面 —— 测过、画面能回显，但 AX 元素为空（只能坐标操作）
 *   已适配     —— 测过，界面树可读
 */

import { recommendStrategy } from './app-strategy.mjs';

/** 名字归一化：去 .app 后缀、去多余空白、转小写，用于「包名对不上时按名字兜底」 */
export function normalizeName(name) {
  return String(name || '')
    .trim()                 // 先去掉首尾空白，否则「xxx.app 」这种带空格的去不掉后缀
    .replace(/\.app$/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * 把预设摊平成 [{name,bundle,process,preset}]，同一 bundle 只保留第一次出现。
 * @param {Record<string, Array<{name:string,bundle:string,process:string}>>} presets
 * @returns {Array<{name:string,bundle:string,process:string,preset:string}>}
 */
export function flattenPresets(presets) {
  const out = [];
  const seen = new Set();
  for (const [preset, list] of Object.entries(presets || {})) {
    for (const app of list || []) {
      const bundle = String(app.bundle || '');
      if (!bundle || seen.has(bundle)) continue;
      seen.add(bundle);
      out.push({ name: String(app.name || ''), bundle, process: String(app.process || ''), preset });
    }
  }
  return out;
}

/**
 * 单条状态判定。
 * @param {{tested?: object|null, installed?: boolean}} input
 * @returns {'未安装'|'未测'|'限制'|'可只用画面'|'已适配'}
 */
export function classifyApp({ tested, installed = true, special = null }) {
  if (special && special.status) return special.status;
  if (!installed) return '未安装';
  if (!tested) return '未测';
  if (tested.skipped) return '未测';
  if (!tested.readable) {
    // 有画面但读不到界面树：只能画面+坐标
    if (tested.capture === 'live' || tested.capture === 'offscreen') return '可只用画面';
    return '限制';
  }
  return '已适配';
}

/**
 * 合并三份数据。
 *
 * 包名对不上时按名字兜底（本机升级/更名后包名会变，不能因此把一个装着的应用标成"没装"），
 * 这种不一致会在 detail 里如实写出来，提示去修预设。
 *
 * @param {{
 *   installed: Array<{name:string, bundle:string, process?:string}>,
 *   presetApps: Array<{name:string,bundle:string,process:string,preset?:string}>,
 *   tested: Array<{app:string, bundle:string, readable?:boolean, capture?:string, skipped?:boolean}>,
 *   special?: Record<string, {status:string, detail?:string}>,
 * }} input
 * @returns {Array<{name:string, bundle:string, process:string, preset:string, installed:boolean, status:string, detail:string}>}
 */
export function mergeInventory({ installed = [], presetApps = [], tested = [], special = {} } = {}) {
  const installedByBundle = new Map();
  const installedByName = new Map();
  for (const app of installed) {
    if (!app || !app.bundle) continue;
    installedByBundle.set(String(app.bundle), app);
    installedByName.set(normalizeName(app.name), app);
  }
  const testedByBundle = new Map();
  const testedByName = new Map();
  for (const row of tested) {
    if (!row) continue;
    if (row.bundle) testedByBundle.set(String(row.bundle), row);
    if (row.app) testedByName.set(normalizeName(row.app), row);
    // 矩阵报告里应用名可能带本地化后缀（如「Keynote Creator Studio」），再存一份首个词
    if (row.app) testedByName.set(normalizeName(String(row.app).split(' ')[0]), row);
  }

  const rows = [];
  const seenPreset = new Set();
  const usedInstalled = new Set();
  for (const presetApp of presetApps) {
    const bundle = String(presetApp.bundle || '');
    if (!bundle || seenPreset.has(bundle)) continue;
    seenPreset.add(bundle);
    const installedApp = installedByBundle.get(bundle) || installedByName.get(normalizeName(presetApp.name)) || null;
    if (installedApp) usedInstalled.add(installedApp.bundle);
    const testedRow = testedByBundle.get(bundle) ||
      testedByName.get(normalizeName(presetApp.name)) ||
      (installedApp ? testedByName.get(normalizeName(installedApp.name)) : null) ||
      null;
    const specialInfo = special[installedApp?.bundle || bundle] || special[bundle] || null;
    const status = classifyApp({ tested: testedRow, installed: Boolean(installedApp), special: specialInfo });
    const notes = [];
    if (specialInfo && specialInfo.detail) notes.push(specialInfo.detail);
    if (installedApp && installedApp.bundle !== bundle) {
      notes.push('预设包名过期（实际 ' + installedApp.bundle + '）');
    }
    if (testedRow) {
      notes.push('节点 ' + (testedRow.nodes ?? '-') + ' / 按钮 ' + (testedRow.buttons ?? '-') + ' / 画面 ' + (testedRow.capture || '-'));
    } else {
      notes.push(installedApp ? '装了但还没测' : '预设里有、本机没装');
    }
    if (specialInfo && !specialInfo.detail) notes.push('按特殊规则处理');
    const strategy = recommendStrategy(testedRow, { special: specialInfo, installed: Boolean(installedApp) });
    rows.push({
      name: installedApp?.name || presetApp.name,
      bundle: installedApp?.bundle || bundle,
      process: installedApp?.process || presetApp.process,
      preset: presetApp.preset || '',
      installed: Boolean(installedApp),
      status,
      strategy: strategy.mode,
      strategyLabel: strategy.label,
      canType: strategy.canType,
      detail: notes.join('；'),
    });
  }
  // 装了但不在任何预设里的：也要列出来，提醒补进预设
  for (const [bundle, app] of installedByBundle) {
    if (usedInstalled.has(bundle)) continue;
    const testedRow = testedByBundle.get(bundle) || testedByName.get(normalizeName(app.name)) || null;
    const specialInfo = special[bundle] || null;
    const strategy = recommendStrategy(testedRow, { special: specialInfo, installed: true });
    rows.push({
      name: app.name,
      bundle,
      process: app.process || '',
      preset: '',
      installed: true,
      status: classifyApp({ tested: testedRow, installed: true, special: specialInfo }),
      strategy: strategy.mode,
      strategyLabel: strategy.label,
      canType: strategy.canType,
      detail: specialInfo && specialInfo.detail
        ? specialInfo.detail
        : (testedRow
          ? '不在预设里，但测过（节点 ' + (testedRow.nodes ?? '-') + ' / 画面 ' + (testedRow.capture || '-') + '）'
          : '不在预设里，未测'),
    });
  }
  return rows;
}

/**
 * 给「未测」的应用生成下一步要跑的命令，省得人手写 MATRIX_APPS_JSON。
 * @param {Array<{name:string, bundle:string, process:string, installed:boolean, status:string}>} rows
 * @returns {string[]}
 */
export function nextProbeCommands(rows) {
  const pending = (rows || []).filter((r) => r.status === '未测' && r.installed !== false && r.bundle && r.process);
  if (!pending.length) return [];
  const apps = pending.map((r) => ({ name: r.name, bundle: r.bundle, process: r.process }));
  const json = JSON.stringify(apps);
  return ["MATRIX_APPS_JSON=" + "'" + json + "'" + " npm run matrix"];
}

/**
 * 渲染成 markdown 报告。
 * @param {Array<object>} rows mergeInventory 的输出
 * @param {{now?:Date, matrixReport?:string}} [meta]
 */
export function renderInventoryMarkdown(rows, meta = {}) {
  const counts = new Map();
  for (const row of rows) counts.set(row.status, (counts.get(row.status) || 0) + 1);
  const lines = [
    '# 本机应用适配清点',
    '',
    '- 生成时间：' + (meta.now ? meta.now.toISOString() : new Date().toISOString()),
    '- 数据来源：/Applications 与 /System/Applications 扫描 + core/app-presets.mjs + ' + (meta.matrixReport || '最近一次矩阵报告'),
    '- 合计：' + rows.length + ' 个应用',
    '',
    '| 应用 | 门类 | 状态 | 建议控法 | 说明 |',
    '| --- | --- | --- | --- | --- |',
  ];
  const order = ['已适配', '可只用画面', '专用方案', '不动', '限制', '未测', '未安装'];
  const sorted = [...rows].sort((a, b) => {
    const d = order.indexOf(a.status) - order.indexOf(b.status);
    return d !== 0 ? d : String(a.name).localeCompare(String(b.name));
  });
  for (const row of sorted) {
    lines.push('| ' + row.name + ' | ' + (row.preset || '-') + ' | ' + row.status + ' | ' + (row.strategyLabel || '-') + ' | ' + row.detail + ' |');
  }
  lines.push('');
  lines.push('汇总：' + order.filter((s) => counts.has(s)).map((s) => s + ' ' + counts.get(s)).join('，'));
  const next = nextProbeCommands(rows);
  if (next.length) {
    lines.push('');
    lines.push('## 下一步补测');
    lines.push('');
    lines.push('下面这些应用装了但还没测，直接跑这条命令（探测完会自动关掉自己拉起的实例）：');
    lines.push('');
    lines.push('```bash');
    lines.push(next[0]);
    lines.push('```');
  }
  return lines.join('\n') + '\n';
}
