'use strict';
/**
 * 安全边界：这层专门管"我们能碰什么、不能碰什么"。
 *
 * 后台控制工具的致命风险往往不是功能 bug，而是：
 *   1. 把不可信的字符串拼进 AppleScript（注入）
 *   2. 连接一个"看起来像 CDP"的本地端口，其实是别的进程（本地端口劫持）
 *   3. 按 pid 杀进程时 pid 已被系统复用，误杀用户的别的程序
 *   4. 执行一个别人预先放好的"权限查询程序"（本地篡改）
 * 这里把这些判断抽成纯函数，方便单测，也方便在入口处统一拦截。
 */

/** 允许作为应用名/进程名的字符：字母、数字、空格、常见标点与中文括号；不允许引号/反斜杠/控制字符 */
const SAFE_IDENTIFIER_RE = /^[\p{L}\p{N} ._\-+&()[\]（）【】·:：,，、]{1,128}$/u;

/**
 * 应用名/进程名是否可以安全拼进 AppleScript（纯函数）。
 * @param {string} name
 * @returns {boolean}
 */
export function isSafeIdentifier(name) {
  if (typeof name !== 'string' || !name.trim()) return false;
  return SAFE_IDENTIFIER_RE.test(name);
}

/**
 * AppleScript 字符串字面量里，不允许出现能破坏语法的字符。
 * 比 isSafeIdentifier 更严：只做"要塞进字符串"的场景则已经由它兜住；
 * 这里再挡一次换行/回车，防止脚本被切成多行。
 * @param {string} text
 * @returns {boolean}
 */
export function isSafeScriptLiteral(text) {
  if (typeof text !== 'string') return false;
  if (/[\u0000-\u001f\u007f]/.test(text)) return false;
  if (text.includes('"') || text.includes('\\')) return false;
  return text.length <= 512;
}

/**
 * 解析 lsof 监听输出里的 pid（纯函数）。
 * 输入形如：`node    12345 tester   23u  IPv4 0x...  0t0  TCP 127.0.0.1:9333 (LISTEN)`
 * @param {string} output
 * @returns {number} pid，拿不到返回 0
 */
export function parseLsofPid(output) {
  for (const line of String(output || '').split('\n')) {
    const text = line.trim();
    if (!text || text.startsWith('COMMAND')) continue;
    const parts = text.split(/\s+/);
    if (parts.length < 2) continue;
    const pid = Number.parseInt(parts[1], 10);
    if (Number.isFinite(pid) && pid > 0) return pid;
  }
  return 0;
}

/**
 * 比较 ps 的 comm 输出和目标进程名（纯函数）。路径形式取 basename 再比。
 * @param {string} psComm
 * @param {string} processName
 * @returns {boolean}
 */
export function pidMatchesProcess(psComm, processName) {
  const comm = String(psComm || '').trim();
  const want = String(processName || '').trim();
  if (!comm || !want) return false;
  // 只认最后一段完全相等：不能用 startsWith 放宽，
  // 否则 "Google Chrome Helper" 会被当成 "Google Chrome"（外部评审实测指出的误判）。
  const base = comm.split('/').pop();
  return base === want;
}

/**
 * 判断调试端口的主人是不是我们以为的那个应用（纯函数）。
 * @param {{ownerPid:number, appPid:number}} input
 * @returns {'ok'|'no-listener'|'mismatch'|'unknown-app'}
 */
export function debugPortTrust({ ownerPid, appPid } = {}) {
  const owner = Number(ownerPid) || 0;
  const app = Number(appPid) || 0;
  if (!app) return 'unknown-app';
  if (!owner) return 'no-listener';
  return owner === app ? 'ok' : 'mismatch';
}

/**
 * 判断可执行文件是否可信（纯函数）：必须是当前用户所有，且不能被组/其他人写。
 * @param {{fileUid:number, uid:number, mode:number, exists?:boolean}} input mode 用 stat 的十进制 mode
 * @returns {'ok'|'missing'|'foreign-owner'|'writable-by-others'}
 */
export function executableTrust({ fileUid, uid, mode, exists = true } = {}) {
  if (!exists) return 'missing';
  if (Number(fileUid) !== Number(uid)) return 'foreign-owner';
  const m = Number(mode) || 0;
  // 0o022 = 组写 + 其他写
  if ((m & 0o022) !== 0) return 'writable-by-others';
  return 'ok';
}
