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
  [/改成了指定关键词|已恢复原值/, '目标页面结构已变'],
  [/读不到 .*界面树|没有辅助功能权限/, '目标应用没运行或缺辅助功能权限'],
  [/没有 BOSS 职位页标签|无法切回 BOSS 职位页|"attempts":\["no-tab"\]/, '用户 Chrome 里没开 BOSS 职位页'],
  [/锁屏/, '锁屏'],
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
export function envSkipReason(text) {
  const raw = String(text || '');
  // 「未送达」是明确失败：即使日志里同时出现「已联系」也不能判成环境跳过
  if (/未送达/.test(raw)) return '';
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
  const reason = envSkipReason(raw);
  return reason
    ? { failed: true, envSkip: true, reason }
    : { failed: true, envSkip: false, reason: '真实失败' };
}

export { ENV_RULES };
