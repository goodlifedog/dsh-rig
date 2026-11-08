/**
 * 失败归类（纯函数）：把「真的是代码/逻辑失败」和「环境不具备」分开。
 * 验收脚本、健康面板、巡检共用这一份，避免两套正则各说各话。
 */

// 每条规则：命中的日志片段 → 环境原因。顺序无关，取第一条命中的说明。
const ENV_RULES = [
  // 任务自己已经判定为环境跳过时，日志里会明确写出来，优先信它
  [/环境跳过/, '任务自报环境跳过'],
  [/当前就是前台|不打扰用户|跳过扫描/, '用户正在使用目标应用'],
  [/cgWindowNotFound|宿主窗口/, 'Electron 宿主被占用或窗口读不到'],
  [/读不到 .*界面树|没有辅助功能权限/, '目标应用没运行或缺辅助功能权限'],
  [/没有 BOSS 职位页标签|无法切回 BOSS 职位页|"attempts":\["no-tab"\]/, '用户 Chrome 里没开 BOSS 职位页'],
  // 只认"屏幕已锁"这类结论；不能匹配「锁屏状态 未锁屏」这种健康检查行，
  // 否则健康检查会被整步误判成环境跳过（verify:safe 实测踩过）。
  [/屏幕已锁|屏幕已锁定|锁屏中|锁屏导致/, '锁屏'],
  [/还有 null 个窗口|屏幕无窗口验收未过/, '读不到窗口数（缺辅助功能权限）'],
  // 只认"环境里没有 node"这一种；不能把任意 ENOENT 都当环境问题——
  // 否则脚本路径写错、依赖缺失这种真失败会被当成环境跳过，验收就假通过了。
  [/env: node: No such file/, '环境缺少可执行文件'],
  // 「已联系」是业务状态（目标岗位之前联系过），不是失败；
  // 「未送达」是真失败，绝不能算环境跳过。
  [/已联系/, '目标岗位已联系过'],
];

/** 运行日志里是否记录为失败（runner 的 jsonl 结束行 code 非 0） */
export function isFailedRun(text) {
  return /"event":"end","code":[1-9]/.test(String(text || ''));
}

/**
 * 归类一次运行：
 *   { failed, envSkip, reason }
 * failed=false 表示没失败；failed=true 且 envSkip=true 表示环境跳过。
 */
/**
 * 真失败的硬信号：命中任意一条就不许再判环境跳过。
 *
 * 为什么要有 FAIL 这一条：有些任务（form-fill / browser-demo / boss-scan）用 PASS/FAIL
 * 两套前缀，不用 ❌。以前只挡 ❌，于是「FAIL 改成了指定关键词」这种断言失败会被
 * 「页面结构已变」的环境规则豁免掉，验收显示 PASS——假绿，评审已经复现过。
 *
 * 「结果: 存在失败项」是这些任务自己的总结论，也必须当硬失败。
 */
const HARD_FAIL = /❌|未送达|存在失败项|(^|\n)[ \t]*FAIL\b/;

// 权限类环境跳过（H4）：只在「明确是权限/授权缺失」时命中，中英文 + AppleScript 状态码。
// 顺序：屏幕录制 → 辅助功能 → 自动化；同一条文本可能同时含多个词，取第一条命中的更具体的。
const PERMISSION_RULES = [
  [/screen ?recording|屏幕录制|录屏权限|CGRequestScreenCaptureAccess|unable to capture (?:the )?screen|could not create image/i, '缺少屏幕录制权限'],
  [/辅助功能权限|辅助功能[^。\n]{0,10}(?:未授权|未开启|被拒|缺失)|accessibility permission|accessibility (?:is )?not (?:trusted|enabled|granted)|not trusted for accessibility/i, '缺少辅助功能权限'],
  [/not authorized to send apple events|apple ?events?.*not authorized|自动化权限|automation permission|-174[34]\b|errAEEventNotPermitted/i, '缺少自动化（Apple 事件）权限'],
];

/**
 * H4 纯函数：把「权限/授权缺失」文本归类成环境跳过原因；不是权限问题返回 ''。
 * 注意：调用方必须先过真失败优先（HARD_FAIL）——这里也再挡一次，避免同一份日志里
 * 既有真实断言失败、又有权限字样时被误判成环境跳过。
 * @param {string} text
 * @returns {string} 环境原因；'' 表示不是权限类问题
 */
// 「健康状态行」豁免：健康检查会输出「辅助功能 + 屏幕录制均已授权」这类行，
// 不能因为里面出现权限名词就判成缺权限（verify:safe 的健康面板整步误报踩过）。
// 只有同时没有否定词（未授权/没有/not/false…）时才算健康行。
const GRANTED_SIGNAL = /已授权|已授予|均已授权|授权正常|权限正常|allGranted|\bgranted\b|\btrusted\b|\benabled\b/i;
const NEGATED_SIGNAL = /未授权|未授予|未启用|未开启|缺失|缺少|没有|被拒绝|denied|\bnot\s|n't\b|\bfalse\b/i;

export function classifyPermissionText(text) {
  const raw = String(text || '');
  if (!raw.trim()) return '';
  if (HARD_FAIL.test(raw)) return '';
  const lines = raw.split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;
    // 健康状态行（例如「屏幕录制均已授权」）直接跳过，不当作缺权限
    if (GRANTED_SIGNAL.test(line) && !NEGATED_SIGNAL.test(line)) continue;
    for (const [re, reason] of PERMISSION_RULES) {
      if (re.test(line)) return reason;
    }
  }
  return '';
}

export function envSkipReason(text) {
  const raw = String(text || '');
  // 真失败优先：即使同一份日志里既有失败项又有环境字样，也不能整轮豁免
  if (HARD_FAIL.test(raw)) return '';
  // 任务自报「环境跳过」最可信，优先于按文案推断的权限原因
  if (/环境跳过/.test(raw)) return '任务自报环境跳过';
  const permission = classifyPermissionText(raw);
  if (permission) return permission;
  for (const [re, reason] of ENV_RULES) {
    if (re.test(raw)) return reason;
  }
  return '';
}

export function classifyRun(text) {
  const raw = String(text || '');
  if (!isFailedRun(raw)) return { failed: false, envSkip: false, reason: '' };
  // 任务自己用 ❌ 标记了某一项检查失败：这轮就是真失败。
  // 否则「部分项环境跳过 + 部分项真失败」会被整轮吞成跳过（实测踩过：
  // background-control 里有 ❌ 后台点击计算器按钮，但因为同一份日志还有「环境跳过」，被判成环境跳过）。
  if (/❌/.test(raw)) return { failed: true, envSkip: false, reason: '真实失败（任务标了 ❌）' };
  if (HARD_FAIL.test(raw)) return { failed: true, envSkip: false, reason: '真实失败（任务标了 FAIL/存在失败项）' };
  const reason = envSkipReason(raw);
  return reason
    ? { failed: true, envSkip: true, reason }
    : { failed: true, envSkip: false, reason: '真实失败' };
}

// H5：后台自检三项（辅助功能 / 自动化 / 屏幕录制）的展示名与设置页提示。
// 纯数据 + 纯函数，daemon 的 selfTest 与单测共用，避免提示指错设置页
// （老实现只有一个 osascript System Events 探针=自动化权限，却叫 axOk、提示去辅助功能页）。
const SELF_TEST_ITEMS = [
  {
    key: 'accessibility',
    name: '辅助功能',
    hint: '缺少辅助功能权限：系统设置 → 隐私与安全性 → 辅助功能，把 <exe> 加进去',
  },
  {
    key: 'automation',
    name: '自动化',
    hint: '缺少自动化权限：系统设置 → 隐私与安全性 → 自动化，允许 <exe> 控制「系统事件」',
  },
  {
    key: 'screenCapture',
    name: '屏幕录制',
    hint: '缺少屏幕录制权限：系统设置 → 隐私与安全性 → 屏幕录制，把 <exe> 加进去',
  },
];

/**
 * H5 纯函数：整理三项自检结果。
 * @param {{accessibility?:boolean, automation?:boolean, screenCapture?:boolean, executable?:string}} input
 * @returns {{ok:boolean, allOk:boolean, checks:object, names:object, hints:object, missing:string[], hint:string}}
 *   checks[key] = { ok, name, hint }；hint 在 ok 时为空串；整体 hint 是失败项提示的合并。
 */
function classifySelfTest(input = {}) {
  const exe = String((input && input.executable) || '后台服务进程');
  const checks = {};
  const names = {};
  const hints = {};
  const missing = [];
  for (const item of SELF_TEST_ITEMS) {
    const ok = (input && input[item.key]) === true;
    names[item.key] = item.name;
    const hint = ok ? '' : item.hint.replace('<exe>', exe);
    hints[item.key] = hint;
    if (!ok) missing.push(item.key);
    checks[item.key] = { ok, name: item.name, hint };
  }
  return {
    ok: missing.length === 0,
    allOk: missing.length === 0,
    checks,
    names,
    hints,
    missing,
    hint: missing.map((key) => hints[key]).join('；'),
  };
}

export { ENV_RULES, PERMISSION_RULES, SELF_TEST_ITEMS, classifySelfTest };
