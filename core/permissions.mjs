'use strict';
/** 权限检查与引导：靠 ocu doctor --json 的结论，不自己猜。 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { resolveOcu, isMac, isWindows } from './platform.mjs';

function runOcuDoctor(timeout = 15000) {
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

/** 返回 { ok, missing: [], platform } */
export async function checkPermissions() {
  if (isWindows) return { ok: true, missing: [], platform: 'windows', note: 'Windows 需登录桌面会话，无系统权限授权' };
  const r = await runOcuDoctor();
  if (!r) return { ok: false, missing: ['unknown'], platform: process.platform, error: '读不到权限状态（ocu doctor 失败）' };
  const missing = [];
  if (r.accessibilityTrusted === false) missing.push('accessibility');
  if (r.screenCaptureGranted === false) missing.push('screenCapture');
  return { ok: r.allGranted !== false && missing.length === 0, missing, platform: r.platform || process.platform };
}

export default { checkPermissions, openPermissionSettings };
