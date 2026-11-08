'use strict';
/**
 * 应用清点：把「本机装了什么」「预设里有什么」「最近测过什么」对到一起，
 * 输出每个应用的状态，避免靠手写清单（一装新软件就过期）。
 *
 * 状态口径：
 *   未安装     —— 预设里有，但本机找不到
 *   未测       —— 装了，但没有任何证据（矩阵没读过、也没有通道级实测）
 *   部分验证   —— 通道级证据（CDP cdp-ok / AppleScript 只读通过）有，但矩阵没读过界面；
 *                 只证明「通道能用」，不能算已适配，也不能并进「未测」
 *   限制       —— 测过，但读不到界面树、也抓不到画面，或者启动即退（应用侧问题）
 *   可只用画面 —— 测过、画面能回显，但 AX 元素为空（只能坐标操作）
 *   专用方案   —— 测过且界面树读不到，但运行时是 electron/chromium 且 CDP 实测可用
 *   已适配     —— 测过，界面树可读
 */

import { recommendStrategy } from './app-strategy.mjs';
import { RUNTIME_CHAINS } from './app-runtime.mjs';

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
 * CDP 状态是否算「实测可用」。
 * cdp-driver 报告里写的是 'cdp-ok'，历史上单测里用的是 'ok'——两个都认，避免口径分裂。
 */
export function isCdpOk(cdpStatus) {
  const value = String(cdpStatus || '');
  return value === 'ok' || value === 'cdp-ok';
}

/** 是否有「通道级证据」（CDP 实测 cdp-ok / AppleScript 只读通过）。纯函数。 */
export function hasChannelEvidence(cdpStatus, applescriptStatus) {
  return isCdpOk(cdpStatus) || String(applescriptStatus || '') === 'ok';
}

/** 通道级证据的可读描述（报告/说明用）。纯函数。 */
export function channelEvidenceLabel(cdpStatus, applescriptStatus) {
  const parts = [];
  if (isCdpOk(cdpStatus)) parts.push('CDP cdp-ok');
  if (String(applescriptStatus || '') === 'ok') parts.push('AppleScript 只读通过');
  return parts.join(' + ');
}

/**
 * 单条状态判定。
 *
 * 注意「部分验证」的优先级：它只从原来的「未测」里细分出来——
 * 矩阵没读过（或跳过）但有通道级证据时才算；有矩阵读数时仍按原来的规则判（已适配/限制/…）。
 *
 * @param {{tested?: object|null, installed?: boolean, special?: object|null, runtime?: string, cdpStatus?: string, applescriptStatus?: string}} input
 * @returns {'未安装'|'未测'|'部分验证'|'限制'|'可只用画面'|'专用方案'|'已适配'}
 */
export function classifyApp({ tested, installed = true, special = null, runtime = '', cdpStatus = '', applescriptStatus = '' }) {
  if (special && special.status) return special.status;
  if (!installed) return '未安装';
  if (!tested || tested.skipped) {
    // 矩阵没读（或跳过）：通道级证据只能证明「通道可用」，不能冒充已适配；
    // 但也不该并进「未测」——否则「CDP 测过、矩阵没跑」会被误读成「完全没碰过」。
    if (hasChannelEvidence(cdpStatus, applescriptStatus)) return '部分验证';
    return '未测';
  }
  if (!tested.readable) {
    // 有画面但读不到界面树：只能画面+坐标
    if (tested.capture === 'live' || tested.capture === 'offscreen') return '可只用画面';
    // 连进程都没起来/启动即退：这是应用侧问题，跟运行时族无关，先判这个
    if (tested.selfExited || tested.launch === 'error') return '限制';
    // 界面树读不到、但运行时是 electron/chromium 且 CDP 实测通过：才算「专用方案」。
    // 只是「这一族有 CDP 通道」不算——实测 OpenCode/抖音的调试端口根本没起来。
    if ((runtime === 'electron' || runtime === 'chromium') && isCdpOk(cdpStatus)) return '专用方案';
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
 *   installed: Array<{name:string, bundle:string, process?:string, runtime?:string}>,
 *   presetApps: Array<{name:string,bundle:string,process:string,preset?:string}>,
 *   tested: Array<{app:string, bundle:string, readable?:boolean, capture?:string, skipped?:boolean}>,
 *   special?: Record<string, {status:string, detail?:string}>,
 *   cdpByBundle?: Record<string, {status:string, detail?:string}>,
 *   applescriptByBundle?: Record<string, {status:string, detail?:string}>,
 * }} input
 * @returns {Array<{name:string, bundle:string, process:string, preset:string, installed:boolean, status:string, detail:string}>}
 */
export function mergeInventory({ installed = [], presetApps = [], tested = [], special = {}, cdpByBundle = {}, applescriptByBundle = {} } = {}) {
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
    const runtime = String((installedApp && installedApp.runtime) || '');
    const cdpInfo = cdpByBundle[installedApp?.bundle || bundle] || cdpByBundle[bundle] || null;
    const cdpStatus = cdpInfo ? String(cdpInfo.status || '') : '';
    const ascInfo = applescriptByBundle[installedApp?.bundle || bundle] || applescriptByBundle[bundle] || null;
    const applescriptStatus = ascInfo ? String(ascInfo.status || '') : '';
    const status = classifyApp({
      tested: testedRow,
      installed: Boolean(installedApp),
      special: specialInfo,
      runtime,
      cdpStatus,
      applescriptStatus,
    });
    const notes = [];
    if (specialInfo && specialInfo.detail) notes.push(specialInfo.detail);
    if (installedApp && installedApp.bundle !== bundle) {
      notes.push('预设包名过期（实际 ' + installedApp.bundle + '）');
    }
    if (testedRow) {
      notes.push('节点 ' + (testedRow.nodes ?? '-') + ' / 按钮 ' + (testedRow.buttons ?? '-') + ' / 画面 ' + (testedRow.capture || '-'));
    } else if (status === '部分验证') {
      notes.push('通道测过（' + channelEvidenceLabel(cdpStatus, applescriptStatus) + '），矩阵未读界面');
    } else {
      notes.push(installedApp ? '装了但还没测' : '预设里有、本机没装');
    }
    if (specialInfo && !specialInfo.detail) notes.push('按特殊规则处理');
    const strategy = recommendStrategy(testedRow, { special: specialInfo, installed: Boolean(installedApp), runtime, cdpStatus });
    if (runtime && !testedRow) notes.push('运行时 ' + runtime + (status === '部分验证' ? '（矩阵未测）' : '（未测）'));
    if (cdpInfo) notes.push('CDP 实测 ' + cdpStatus + (cdpInfo.detail ? '：' + cdpInfo.detail : ''));
    else if (runtime === 'electron' || runtime === 'chromium') notes.push('可试 CDP 专用通道（未验证）');
    if (ascInfo) notes.push('AppleScript 实测 ' + applescriptStatus + (ascInfo.detail ? '：' + ascInfo.detail : ''));
    rows.push({
      name: installedApp?.name || presetApp.name,
      bundle: installedApp?.bundle || bundle,
      process: installedApp?.process || presetApp.process,
      preset: presetApp.preset || '',
      installed: Boolean(installedApp),
      runtime,
      cdpStatus,
      applescriptStatus,
      channelVerified: hasChannelEvidence(cdpStatus, applescriptStatus),
      matrixTested: Boolean(testedRow && !testedRow.skipped),
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
    const runtime = String(app.runtime || '');
    const cdpInfo = cdpByBundle[bundle] || null;
    const cdpStatus = cdpInfo ? String(cdpInfo.status || '') : '';
    const ascInfo = applescriptByBundle[bundle] || null;
    const applescriptStatus = ascInfo ? String(ascInfo.status || '') : '';
    const status = classifyApp({
      tested: testedRow,
      installed: true,
      special: specialInfo,
      runtime,
      cdpStatus,
      applescriptStatus,
    });
    const strategy = recommendStrategy(testedRow, { special: specialInfo, installed: true, runtime, cdpStatus });
    rows.push({
      name: app.name,
      bundle,
      process: app.process || '',
      preset: '',
      installed: true,
      runtime,
      cdpStatus,
      applescriptStatus,
      channelVerified: hasChannelEvidence(cdpStatus, applescriptStatus),
      matrixTested: Boolean(testedRow && !testedRow.skipped),
      status,
      strategy: strategy.mode,
      strategyLabel: strategy.label,
      canType: strategy.canType,
      detail: [
        specialInfo && specialInfo.detail
          ? specialInfo.detail
          : (testedRow
            ? '不在预设里，但测过（节点 ' + (testedRow.nodes ?? '-') + ' / 画面 ' + (testedRow.capture || '-') + '）'
            : (status === '部分验证'
              ? '不在预设里；通道测过（' + channelEvidenceLabel(cdpStatus, applescriptStatus) + '），矩阵未读界面'
              : '不在预设里，未测')),
        cdpInfo
          ? 'CDP 实测 ' + cdpStatus + (cdpInfo.detail ? '：' + cdpInfo.detail : '')
          : ((runtime === 'electron' || runtime === 'chromium') ? '可试 CDP 专用通道（未验证）' : ''),
        ascInfo ? 'AppleScript 实测 ' + applescriptStatus + (ascInfo.detail ? '：' + ascInfo.detail : '') : '',
      ].filter(Boolean).join('；'),
    });
  }
  return rows;
}

/**
 * 给清点行补「读取会抢前台（前台风险名单）」标注。
 *
 * 报告要回答「这个应用现在到底能不能用」：历史测过「已适配」但在风险名单里的应用，
 * 当前默认会被所有后台读取跳过——不标出来，看报告的人会以为它还在正常被控制。
 *
 * @param {Array<{name?:string, bundle?:string, detail?:string}>} rows
 * @param {{apps?:Record<string,{expiresAt?:number,count?:number}>}} riskState
 * @param {number} [now]
 */
export function annotateRisk(rows, riskState, now = Date.now()) {
  const list = Array.isArray(rows) ? rows : [];
  const apps = (riskState && riskState.apps) || {};
  const clean = (value) => normalizeName(value).replace(/[^a-z0-9\u4e00-\u9fa5]/g, '');
  const active = new Map();
  for (const [name, entry] of Object.entries(apps)) {
    if (!entry || !Number.isFinite(entry.expiresAt) || entry.expiresAt <= now) continue;
    active.set(normalizeName(name), entry);
    // 紧凑形式：'WPS Office' 与进程名 'wpsoffice' 也能对上（本地化名/进程名经常不一致）
    if (clean(name)) active.set('#' + clean(name), entry);
  }
  return list.map((row) => {
    if (!row) return row;
    const keys = [normalizeName(row.name), normalizeName(row.bundle), normalizeName(row.process), '#' + clean(row.name), '#' + clean(row.process)];
    const hit = keys.map((k) => active.get(k)).find(Boolean);
    if (!hit) return row;
    const daysLeft = Math.max(1, Math.ceil((hit.expiresAt - now) / (24 * 60 * 60 * 1000)));
    const note = '读取会抢前台（前台风险名单，' + daysLeft + ' 天后过期），默认跳过界面读取';
    return Object.assign({}, row, {
      riskSkip: true,
      detail: row.detail ? row.detail + '；' + note : note,
    });
  });
}

/**
 * 交叉校验「状态」和「建议控法」是否自相矛盾。
 * 两套判定是分开写的，规则一改就可能对不上（比如状态说已适配、策略却说只能画面操作）。
 *
 * @param {Array<{name?:string, status?:string, strategy?:string}>} rows
 * @returns {Array<{name:string, status:string, strategy:string, reason:string}>}
 */
export function checkStrategyConsistency(rows) {
  const allowed = {
    '已适配': ['ax', 'ax-read'],
    // 矩阵没读过：策略仍是未判定（策略字段保持原语义，不因为细分状态而改）
    '部分验证': ['unknown'],
    '可只用画面': ['visual'],
    '专用方案': ['dedicated'],
    '不动': ['no-touch'],
    '限制': ['blocked', 'ax-read'],
    '未测': ['unknown'],
    '未安装': ['unknown'],
  };
  const out = [];
  for (const row of rows || []) {
    const status = String(row.status || '');
    const strategy = String(row.strategy || '');
    const ok = (allowed[status] || []).includes(strategy);
    if (ok) continue;
    out.push({ name: String(row.name || '?'), status, strategy, reason: '状态「' + status + '」不该配「' + strategy + '」' });
  }
  return out;
}

/**
 * 按运行时族汇总适配情况（纯函数）。
 *
 * 为什么按族看：用户问「还有什么软件能适配」时，逐个应用列表回答不了这个问题；
 * 同一族共用一套通道（原生 AX / Electron CDP / Chromium CDP…），族里有一个跑通，
 * 其余应用大概率直接可用。这里把「每族装了多少、适配到什么程度、默认通道链」列清楚。
 *
 * @param {Array<{name:string, runtime?:string, status:string}>} rows
 * @returns {Array<{family:string, total:number, adapted:number, partial:number, visual:number, dedicated:number, limited:number, untouched:number, untested:number, apps:string[], chain:string}>}
 */
export function summarizeByFamily(rows) {
  const buckets = new Map();
  for (const row of rows || []) {
    const family = String((row && row.runtime) || '') || '未识别';
    if (!buckets.has(family)) {
      buckets.set(family, { family, total: 0, adapted: 0, partial: 0, visual: 0, dedicated: 0, limited: 0, untouched: 0, untested: 0, apps: [] });
    }
    const b = buckets.get(family);
    b.total += 1;
    if (row.name) b.apps.push(String(row.name));
    switch (row.status) {
      case '已适配': b.adapted += 1; break;
      case '部分验证': b.partial += 1; break;
      case '可只用画面': b.visual += 1; break;
      case '专用方案': b.dedicated += 1; break;
      case '限制': b.limited += 1; break;
      case '不动': b.untouched += 1; break;
      default: b.untested += 1; break;
    }
  }
  const order = ['native', 'electron', 'chromium', 'flutter', 'qt', 'java', '未识别'];
  const list = Array.from(buckets.values());
  for (const b of list) {
    b.chain = (RUNTIME_CHAINS[b.family] || []).join(' → ') || '-';
    b.apps.sort((a, c) => a.localeCompare(c));
  }
  list.sort((a, c) => {
    const ia = order.indexOf(a.family);
    const ic = order.indexOf(c.family);
    const da = ia < 0 ? order.length : ia;
    const dc = ic < 0 ? order.length : ic;
    return da !== dc ? da - dc : c.total - a.total;
  });
  return list;
}

/**
 * 给「未测」的应用生成下一步要跑的命令，省得人手写 MATRIX_APPS_JSON。
 * @param {Array<{name:string, bundle:string, process:string, installed:boolean, status:string}>} rows
 * @returns {string[]}
 */
export function nextProbeCommands(rows) {
  // 「部分验证」也需要补跑矩阵：通道测过不代表读过界面
  const pending = (rows || []).filter((r) => (r.status === '未测' || r.status === '部分验证') && r.installed !== false && r.bundle && r.process);
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
    '- 数据来源：/Applications、~/Applications 与 /System/Applications 扫描 + core/app-presets.mjs + ' + (meta.matrixReport || '最近一次矩阵报告'),
    '- 合计：' + rows.length + ' 个应用',
    '',
    '| 应用 | 门类 | 运行时 | 状态 | 建议控法 | 说明 |',
    '| --- | --- | --- | --- | --- | --- |',
  ];
  const order = ['已适配', '部分验证', '可只用画面', '专用方案', '不动', '限制', '未测', '未安装'];
  const sorted = [...rows].sort((a, b) => {
    const d = order.indexOf(a.status) - order.indexOf(b.status);
    return d !== 0 ? d : String(a.name).localeCompare(String(b.name));
  });
  for (const row of sorted) {
    lines.push('| ' + row.name + ' | ' + (row.preset || '-') + ' | ' + (row.runtime || '-') + ' | ' + row.status
      + ' | ' + (row.strategyLabel || '-') + ' | ' + row.detail + ' |');
  }
  lines.push('');
  lines.push('汇总：' + order.filter((s) => counts.has(s)).map((s) => s + ' ' + counts.get(s)).join('，'));
  if (counts.get('部分验证')) {
    const names = rows.filter((r) => r.status === '部分验证').map((r) => r.name);
    lines.push('其中 **部分验证（通道测过、矩阵未读界面）** ' + names.length + ' 个：' + names.join('、')
      + ' —— 通道可用（CDP cdp-ok / AppleScript 只读通过），但还没跑 app-matrix 界面读数，不能算「已适配」，也不是「完全没测」');
  }
  if (meta.riskCount) {
    lines.push('其中 ' + meta.riskCount + ' 个在**前台风险名单**里：历史测过能控，但现在默认跳过界面读取（`npm run front:risk` 可看/清）');
  }
  const stubs = (meta.shortcutStubs || []).filter(Boolean);
  if (stubs.length) {
    lines.push('');
    lines.push('另有 ' + stubs.length + ' 个快捷方式壳未计入统计（只有 run.sh 启动器、没有 bundle id，属于游戏/启动器快捷方式，不在后台接管范围）：' + stubs.join('、'));
  }

  // 按运行时族汇总：回答「还有什么软件能适配」要看族，不是逐个应用看
  lines.push('');
  lines.push('## 按运行时族看适配');
  lines.push('');
  lines.push('同一族共用一套通道：族里有应用跑通，新装同类软件通常直接可用。');
  lines.push('');
  lines.push('| 运行时族 | 装了几个 | 已适配 | 部分验证 | 可只用画面 | 专用方案 | 限制 | 不动 | 未测 | 默认通道链 |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const family of summarizeByFamily(rows)) {
    lines.push('| ' + family.family + ' | ' + family.total + ' | ' + family.adapted + ' | ' + family.partial
      + ' | ' + family.visual + ' | ' + family.dedicated + ' | ' + family.limited + ' | ' + family.untouched
      + ' | ' + family.untested + ' | ' + family.chain + ' |');
  }
  const problems = checkStrategyConsistency(rows);
  lines.push('');
  lines.push(problems.length
    ? '⚠️ 状态与建议控法有 ' + problems.length + ' 处不一致：' + problems.map((p) => p.name + '（' + p.reason + '）').join('；')
    : '状态与建议控法一致。');
  const next = nextProbeCommands(rows);
  if (next.length) {
    lines.push('');
    lines.push('## 下一步补测');
    lines.push('');
    lines.push('下面这些应用还没跑矩阵（含「通道测过、矩阵未读」的），直接跑这条命令（探测完会自动关掉自己拉起的实例）：');
    lines.push('');
    lines.push('```bash');
    lines.push(next[0]);
    lines.push('```');
  }
  return lines.join('\n') + '\n';
}
