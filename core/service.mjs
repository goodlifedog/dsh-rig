'use strict';

/**
 * 跨平台常驻服务管理。
 * macOS：launchd（~/Library/LaunchAgents）
 * Windows：任务计划程序（schtasks，登录时启动）
 */
import { execFile } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMac, isWindows } from './platform.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const LABEL_DAEMON = 'com.desktop-agent.daemon';
const LABEL_OVERLAY = 'com.desktop-agent.overlay';

function run(cmd, args) {
  return new Promise((resolve) => execFile(cmd, args, { timeout: 30000 }, (err, stdout, stderr) =>
    resolve({ ok: !err, out: (stdout || '').trim(), err: (stderr || '').trim() })));
}

function nodeBin() { return process.execPath; }

async function macInstall() {
  const dir = path.join(os.homedir(), 'Library', 'LaunchAgents');
  await fsp.mkdir(dir, { recursive: true });
  const daemon = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0"><dict>',
    '<key>Label</key><string>' + LABEL_DAEMON + '</string>',
    '<key>ProgramArguments</key><array><string>' + nodeBin() + '</string><string>' + path.join(ROOT, 'core/daemon.mjs') + '</string></array>',
    '<key>WorkingDirectory</key><string>' + ROOT + '</string>',
    '<key>RunAtLoad</key><true/>',
    '<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>',
    '<key>EnvironmentVariables</key><dict>',
    '<key>HOME</key><string>' + os.homedir() + '</string>',
    // launchd 默认 PATH 不含 ~/.local/bin，而 ocu 是 #!/usr/bin/env node，缺了会报 env: node: No such file or directory
    '<key>PATH</key><string>' + os.homedir() + '/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>',
    '<key>OPEN_COMPUTER_USE_VISUAL_CURSOR</key><string>0</string>',
    '</dict>',
    '<key>StandardOutPath</key><string>' + path.join(ROOT, 'logs/launchd-daemon.out') + '</string>',
    '<key>StandardErrorPath</key><string>' + path.join(ROOT, 'logs/launchd-daemon.err') + '</string>',
    '</dict></plist>',
  ].join('\n');
  const overlay = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0"><dict>',
    '<key>Label</key><string>' + LABEL_OVERLAY + '</string>',
    '<key>ProgramArguments</key><array><string>/usr/bin/env</string><string>-u</string><string>ELECTRON_RUN_AS_NODE</string>',
    '<string>' + path.join(ROOT, 'overlay/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron') + '</string><string>.</string></array>',
    '<key>WorkingDirectory</key><string>' + path.join(ROOT, 'overlay') + '</string>',
    '<key>RunAtLoad</key><true/>',
    '<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>',
    '<key>EnvironmentVariables</key><dict>',
    '<key>HOME</key><string>' + os.homedir() + '</string>',
    '<key>PATH</key><string>' + os.homedir() + '/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>',
    '</dict>',
    '<key>StandardOutPath</key><string>' + path.join(ROOT, 'logs/launchd-overlay.out') + '</string>',
    '<key>StandardErrorPath</key><string>' + path.join(ROOT, 'logs/launchd-overlay.err') + '</string>',
    '</dict></plist>',
  ].join('\n');

  for (const [name, body] of [[LABEL_DAEMON, daemon], [LABEL_OVERLAY, overlay]]) {
    const file = path.join(dir, name + '.plist');
    await fsp.writeFile(file, body);
    const uid = String(process.getuid ? process.getuid() : 501);
    await run('launchctl', ['bootout', 'gui/' + uid, file]);
    const r = await run('launchctl', ['bootstrap', 'gui/' + uid, file]);
    console.log(r.ok ? '已加载 ' + name : '加载失败 ' + name + ': ' + r.err);
  }
}

async function winInstall() {
  const daemonCmd = '\"' + nodeBin() + '\" \"' + path.join(ROOT, 'core', 'daemon.mjs') + '\"';
  const overlayCmd = '\"' + path.join(ROOT, 'overlay', 'node_modules', 'electron', 'dist', 'electron.exe') + '\" \"' + path.join(ROOT, 'overlay') + '\"';
  for (const [name, cmd] of [['desktop-agent-daemon', daemonCmd], ['desktop-agent-overlay', overlayCmd]]) {
    await run('schtasks', ['/Delete', '/TN', name, '/F']);
    const r = await run('schtasks', ['/Create', '/TN', name, '/TR', cmd, '/SC', 'ONLOGON', '/RL', 'LIMITED', '/F']);
    console.log(r.ok ? '已创建计划任务 ' + name : '创建失败 ' + name + ': ' + r.err);
  }
}

async function install() {
  if (isMac) return macInstall();
  if (isWindows) return winInstall();
  throw new Error('不支持的平台: ' + process.platform);
}

async function uninstall() {
  if (isMac) {
    const dir = path.join(os.homedir(), 'Library', 'LaunchAgents');
    const uid = String(process.getuid ? process.getuid() : 501);
    for (const name of [LABEL_DAEMON, LABEL_OVERLAY]) {
      const file = path.join(dir, name + '.plist');
      await run('launchctl', ['bootout', 'gui/' + uid, file]);
      await fsp.rm(file, { force: true });
      console.log('已移除 ' + name);
    }
    return;
  }
  if (isWindows) {
    for (const name of ['desktop-agent-daemon', 'desktop-agent-overlay']) {
      const r = await run('schtasks', ['/Delete', '/TN', name, '/F']);
      console.log(r.ok ? '已删除 ' + name : '删除失败 ' + name);
    }
    return;
  }
  throw new Error('不支持的平台: ' + process.platform);
}

const cmd = process.argv[2] || 'install';
if (cmd === 'install') await install();
else if (cmd === 'uninstall') await uninstall();
else { console.log('用法: node core/service.mjs install|uninstall'); process.exit(1); }