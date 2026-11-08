'use strict';
/** 权限检查与引导：靠 ocu doctor --json 的结论，不自己猜。 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { resolveOcu, isMac, isWindows } from './platform.mjs';

// doctor 在闸门关键路径上：它挂住时任务启动要一起等，所以超时必须短。
// 为什么不是更短（比如 2s）：首次冷启动要查 TCC 数据库 + 弹窗状态，机器忙/锁屏时更慢，
// 太短会把「查得慢」误判成「读不到权限」（fail-closed 会让任务被环境跳过）；
// 5s 是「能查完」和「不拖住启动」的折中（老值 15000ms 在 doctor 挂起时白等 15s）。
// 保留注入：测试/特殊环境可传更小的值。
export const OCU_DOCTOR_TIMEOUT_MS = 5000;

function runOcuDoctor(timeout = OCU_DOCTOR_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const bin = resolveOcu();
    if (!bin) return resolve(null);
    let cmd = bin;
    let args = ['doctor', '--json'];
    // 随包 ocu 是 node 脚本，用当前 Node 运行时执行
    try {
      const fd = fs.openSync(bin, 'r');
      const head = Buffer.alloc(2);
      fs.readSync(fd, head, 0, 2, 0);
      fs.closeSync(fd);
      if (head.toString('utf8') === '#!') {
        cmd = process.execPath;
        args = [bin, 'doctor', '--json'];
      }
    } catch {}
    const env = { ...process.env, OPEN_COMPUTER_USE_VISUAL_CURSOR: '0' };
    if (cmd === process.execPath) env.ELECTRON_RUN_AS_NODE = '1';
    execFile(cmd, args, { timeout, env, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve(null);
      const line = String(stdout || '').trim().split('\n').filter((l) => l.trim().startsWith('{')).pop();
      if (!line) return resolve(null);
      try { resolve(JSON.parse(line)); } catch { resolve(null); }
    });
  });
}

const SETTINGS_URL = {
  accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
  screenCapture: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
};

export function openPermissionSettings(which) {
  if (!isMac) return false;
  const url = SETTINGS_URL[which] || SETTINGS_URL.accessibility;
  execFile('/usr/bin/open', [url], () => {});
  return true;
}

// ocu doctor --json 的权限字段 → 本模块（及闸门）用的短名。
// 只认 boolean：这些字段一旦缺失/变成字符串，旧逻辑会把「查不到」当成「已授权」（fail-open）。
const PERMISSION_FIELDS = Object.freeze([
  ['accessibilityTrusted', 'accessibility'],
  ['screenCaptureGranted', 'screenCapture'],
]);

/**
 * 校验 ocu doctor --json 的解析结果并转成 { ok, missing, platform }（纯函数，便于单测）。
 *
 * fail-closed 规则（M2 复核抓到过 fail-open）：
 *   1. 只有 boolean 才可信：字段缺失、字符串 "true"、null 一律算「读不到」，绝不当已授权；
 *   2. 两个具体字段有一个不可信 → missing 里补 'unknown'（调用方按「探测不出来」处理，不是「已授权」）；
 *   3. 单 key 不可信而另一个是 false → 具体缺项在前、'unknown' 在后，两项都报；
 *   4. allGranted === false 却指不出具体缺哪项 → 'unknown'（不猜，也别默认"都给了"）；
 *   5. allGranted 缺失时不单独判 unknown：两个具体字段才是事实来源（老版本 ocu 可能只给具体字段），
 *      但只要它出现了且不是 boolean，就按不可信处理。
 *
 * @param {unknown} report doctor 输出的解析结果（null = 启动失败/超时/非 0 退出/空输出）
 * @param {string} [platform] 回退平台名
 * @returns {{ok:boolean, missing:string[], platform:string, note?:string, error?:string}}
 */
export function judgeDoctorReport(report, platform = process.platform) {
  const fallback = platform || process.platform;
  if (!report || typeof report !== 'object' || Array.isArray(report)) {
    return { ok: false, missing: ['unknown'], platform: fallback, error: '读不到权限状态（ocu doctor 失败或输出为空）' };
  }
  const missing = [];
  const untrusted = [];
  for (const [field, key] of PERMISSION_FIELDS) {
    const value = report[field];
    if (typeof value !== 'boolean') {
      untrusted.push(field);
      continue;
    }
    if (value === false) missing.push(key);
  }
  const allGranted = report.allGranted;
  if (allGranted !== undefined && typeof allGranted !== 'boolean') {
    untrusted.push('allGranted');
  } else if (allGranted === false && missing.length === 0) {
    untrusted.push('allGranted');
  }
  if (untrusted.length) missing.push('unknown');
  const result = {
    ok: missing.length === 0,
    missing,
    platform: typeof report.platform === 'string' && report.platform ? report.platform : fallback,
  };
  if (untrusted.length) {
    result.note = 'ocu doctor 输出不可信（' + untrusted.join('、') + ' 缺失或不是 boolean），按未知处理，不当作已授权';
  }
  return result;
}

/**
 * 返回 { ok, missing: [], platform }（missing 里可能有 'unknown' = 读不到状态，不是已授权）
 * @param {{timeout?:number}} [options] timeout 可注入（单测/特殊环境用，默认 5000ms）
 */
export async function checkPermissions(options = {}) {
  if (isWindows) return { ok: true, missing: [], platform: 'windows', note: 'Windows 需登录桌面会话，无系统权限授权' };
  const opts = options && typeof options === 'object' ? options : {};
  const r = await runOcuDoctor(opts.timeout);
  return judgeDoctorReport(r);
}

export default { checkPermissions, openPermissionSettings, judgeDoctorReport, OCU_DOCTOR_TIMEOUT_MS };
