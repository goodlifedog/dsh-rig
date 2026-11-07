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
import fs from 'node:fs';
import { isMac, isWindows } from './platform.mjs';
import { tokenPath } from './local-token.mjs';
import { parseListenerPid, diagnoseListener, parseLaunchdPid, deploymentDrift, isOurOverlayCommand } from './service-guard.mjs';

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
    '<key>ThrottleInterval</key><integer>10</integer>',
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
    '<key>ThrottleInterval</key><integer>10</integer>',
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
    // 清掉占着端口的游离实例（只杀确认属于本项目的），否则会一直占着 7788/7789
    for (const port of [PORT, 7788]) {
      const info = await listenerInfo(port);
      if (!info.pid) continue;
      const ours = port === PORT
        ? diagnoseListener({ listenerPid: info.pid, listenerCommand: info.command, rootDir: ROOT }) === 'ok'
        : isOurOverlayCommand(info.command, { rootDir: ROOT });
      if (!ours) {
        console.log('端口 ' + port + ' 被别的程序占用（pid ' + info.pid + '），不动它');
        continue;
      }
      console.log('结束占用 ' + port + ' 的本项目进程 pid ' + info.pid);
      try { process.kill(info.pid, 'SIGTERM'); } catch {}
      for (let i = 0; i < 20; i += 1) {
        await new Promise((r) => setTimeout(r, 250));
        if (!(await listenerInfo(port)).pid) break;
      }
    }
    // token 也一起清掉（下次安装会重新生成）
    try {
      fs.rmSync(tokenPath(), { force: true });
      console.log('已清理控制面 token');
    } catch {}
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


const PORT = Number(process.env.AGENTD_PORT || 7789);

async function listenerInfo(port) {
  const lsof = await run('/usr/sbin/lsof', ['-nP', '-iTCP:' + port, '-sTCP:LISTEN', '-t']);
  const pid = parseListenerPid(lsof.out);
  let command = '';
  if (pid) {
    const ps = await run('/bin/ps', ['-p', String(pid), '-o', 'command=']);
    command = ps.out;
  }
  return { pid, command };
}

async function launchdPid(label) {
  const uid = String(process.getuid ? process.getuid() : 501);
  const r = await run('launchctl', ['print', 'gui/' + uid + '/' + label]);
  return r.ok ? parseLaunchdPid(r.out) : 0;
}

async function status() {
  const listener = await listenerInfo(PORT);
  const managed = isMac ? await launchdPid(LABEL_DAEMON) : 0;
  // overlay 也有同样的"手工实例占端口、launchd 拉不起来"风险，一起看
  const overlayListener = await listenerInfo(7788);
  const overlayManaged = isMac ? await launchdPid(LABEL_OVERLAY) : 0;
  const verdict = diagnoseListener({ listenerPid: listener.pid, listenerCommand: listener.command, rootDir: ROOT });
  const drift = deploymentDrift({ listenerPid: listener.pid, managedPid: managed });
  console.log('端口 ' + PORT + ' 监听者：' + (listener.pid || '无') + (listener.command ? '（' + listener.command.slice(0, 80) + '）' : ''));
  console.log('launchd 受管 pid：' + (managed || '无'));
  console.log('监听者身份：' + verdict);
  console.log('部署状态：' + drift + (drift === 'stray' ? ' —— 端口被不受管进程占着，launchd 拉不起来，先跑 npm run service:restart' : ''));
  const overlayDrift = deploymentDrift({ listenerPid: overlayListener.pid, managedPid: overlayManaged });
  console.log('overlay 7788 监听者：' + (overlayListener.pid || '无') + '，launchd 受管 pid：' + (overlayManaged || '无') + '，部署状态：' + overlayDrift);
  return { listener, managed, verdict, drift, overlayListener, overlayManaged, overlayDrift };
}

async function restartDaemon() {
  if (!isMac) { console.log('目前只实现 macOS 的 restart'); process.exit(1); }
  const before = await listenerInfo(PORT);
  const verdict = diagnoseListener({ listenerPid: before.pid, listenerCommand: before.command, rootDir: ROOT });
  if (verdict === 'foreign-process') {
    console.error('端口 ' + PORT + ' 被别的程序占用（pid ' + before.pid + '）：' + before.command.slice(0, 120));
    console.error('这不是本项目的守护进程，不杀。请先确认它是什么再处理。');
    process.exit(1);
  }
  if (before.pid) {
    console.log('结束旧实例 pid ' + before.pid);
    try { process.kill(before.pid, 'SIGTERM'); } catch {}
    for (let i = 0; i < 20; i += 1) {
      await new Promise((r) => setTimeout(r, 250));
      const now = await listenerInfo(PORT);
      if (!now.pid) break;
    }
  }
  // overlay 同样处理：手工实例占着 7788 时 launchd 拉不起来
  const overlayBefore = await listenerInfo(7788);
  if (overlayBefore.pid) {
    if (!isOurOverlayCommand(overlayBefore.command, { rootDir: ROOT })) {
      console.error('7788 被别的程序占用（pid ' + overlayBefore.pid + '）：' + overlayBefore.command.slice(0, 120) + '，不杀');
    } else {
      console.log('结束旧 overlay 实例 pid ' + overlayBefore.pid);
      try { process.kill(overlayBefore.pid, 'SIGTERM'); } catch {}
      for (let i = 0; i < 20; i += 1) {
        await new Promise((r) => setTimeout(r, 250));
        if (!(await listenerInfo(7788)).pid) break;
      }
    }
  }
  const uid = String(process.getuid ? process.getuid() : 501);
  const kickOverlay = await run('launchctl', ['kickstart', '-k', 'gui/' + uid + '/' + LABEL_OVERLAY]);
  if (!kickOverlay.ok) console.error('overlay kickstart 失败：' + kickOverlay.err);
  const kick = await run('launchctl', ['kickstart', '-k', 'gui/' + uid + '/' + LABEL_DAEMON]);
  if (!kick.ok) console.error('kickstart 失败：' + kick.err);
  for (let i = 0; i < 40; i += 1) {
    await new Promise((r) => setTimeout(r, 250));
    const now = await listenerInfo(PORT);
    if (!now.pid) continue;
    const managed = await launchdPid(LABEL_DAEMON);
    if (managed && now.pid === managed) {
      console.log('已由 launchd 拉起新实例：pid ' + now.pid);
      return;
    }
  }
  const final = await status();
  console.error('重启后没有确认到受管实例（监听者=' + final.listener.pid + '，受管=' + final.managed + '）');
  process.exit(1);
}

const cmd = process.argv[2] || 'install';
if (cmd === 'install') await install();
else if (cmd === 'uninstall') await uninstall();
else if (cmd === 'restart') await restartDaemon();
else if (cmd === 'status') await status();
else { console.log('用法: node core/service.mjs install|uninstall|restart|status'); process.exit(1); }