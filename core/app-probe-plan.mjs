'use strict';
/**
 * 探测计划的参数解析（纯逻辑，便于单测）。
 *
 *   npm run apps:probe -- GarageBand,UURemote      # 按应用名/门类预设名临时探测
 *   npm run apps:probe -- --preset tools           # 按预设门类
 *   npm run apps:probe -- --preset tools --dry     # 只打印将要执行的命令
 */

/**
 * @param {string[]} argv 如 ['--preset','tools','--dry']
 * @returns {{mode:'preset'|'apps'|'default', preset:string, names:string[], dry:boolean, keep:boolean, refresh:boolean, error:string}}
 */
export function parseProbeArgs(argv = []) {
  const out = { mode: 'default', preset: '', names: [], dry: false, keep: false, refresh: true, error: '' };
  const args = (argv || []).map(String);
  let preset = '';
  let sawPresetFlag = false;
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--dry') out.dry = true;
    else if (a === '--keep') out.keep = true;          // 探测完不关应用（排障用）
    else if (a === '--no-refresh') out.refresh = false; // 不刷新清点报告
    else if (a === '--preset') {
      sawPresetFlag = true;
      preset = args[i + 1] || '';
      i += 1;
      if (!preset) out.error = '--preset 后面要给门类名';
    } else if (a.startsWith('--preset=')) {
      sawPresetFlag = true;
      preset = a.slice('--preset='.length);
    } else if (a.startsWith('-')) {
      out.error = '不认识的参数：' + a;
    } else {
      out.names.push(...a.split(',').map((s) => s.trim()).filter(Boolean));
    }
  }
  if (out.error) return out;
  if (sawPresetFlag && out.names.length) out.error = '不能同时指定应用名和预设门类';
  if (sawPresetFlag) {
    if (!preset) out.error = '--preset 后面要给门类名';
    else { out.mode = 'preset'; out.preset = preset; }
  } else if (out.names.length) {
    out.mode = 'apps';
  }
  return out;
}

/**
 * 把解析结果变成 matrix 需要的环境变量。
 * @param {ReturnType<typeof parseProbeArgs>} plan
 * @param {Array<{name:string, bundle:string, process:string}>} [resolved] mode=apps 时解析出来的条目
 */
export function probeEnv(plan, resolved = []) {
  const env = {};
  if (plan.mode === 'preset') env.MATRIX_PRESET = plan.preset;
  if (plan.mode === 'apps') env.MATRIX_APPS_JSON = JSON.stringify(resolved);
  if (plan.keep) env.MATRIX_QUIT = '0';
  return env;
}

/**
 * 按名字解析要探测的应用（纯函数，便于单测）。
 *
 * 三种写法都认：安装清单里的名字（英文显示名）、**预设里的显示名**（可能是中文，如「邮件」「日历」）、
 * bundle id / 进程名。命中预设时返回「预设显示名 + 实际 bundle/process」——因为中文系统里
 * CGWindowList 的窗口 owner 是本地化名，矩阵必须用中文显示名才匹配得到窗口；bundle/process 仍取实际值。
 *
 * @param {{names:string[], installed:Array<{name:string,bundle:string,process:string}>, presets:Array<{name:string,bundle:string,process:string}>}} input
 * @returns {{matched:Array<{name:string,bundle:string,process:string}>, missing:string[]}}
 */
export function resolveProbeNames(input = {}) {
  const names = Array.isArray(input.names) ? input.names : [];
  const installed = Array.isArray(input.installed) ? input.installed : [];
  const presets = Array.isArray(input.presets) ? input.presets : [];
  const norm = (v) => String(v == null ? '' : v).toLowerCase().replace(/[\s\-_.]+/g, '');

  const alias = new Map();
  for (const entry of presets) {
    if (!entry || !entry.bundle) continue;
    for (const key of [entry.name, entry.bundle, entry.process]) {
      const k = norm(key);
      if (k && !alias.has(k)) alias.set(k, entry);
    }
  }

  const matched = [];
  const missing = [];
  const seen = new Set();
  for (const raw of names) {
    const key = norm(raw);
    if (!key) continue;
    const preset = alias.get(key);
    if (preset) {
      const app = installed.find((a) => a && norm(a.bundle) === norm(preset.bundle));
      if (!app) { missing.push(raw); continue; }
      const name = preset.name || app.name;
      if (seen.has(name)) continue;
      seen.add(name);
      matched.push({ name, bundle: app.bundle || preset.bundle, process: preset.process || app.process });
      continue;
    }
    const app = installed.find((a) => a && (norm(a.name) === key || norm(a.bundle) === key || norm(a.process) === key));
    if (!app) { missing.push(raw); continue; }
    if (seen.has(app.name)) continue;
    seen.add(app.name);
    matched.push({ name: app.name, bundle: app.bundle, process: app.process });
  }
  return { matched, missing };
}
