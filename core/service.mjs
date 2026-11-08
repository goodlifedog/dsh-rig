'use strict';

/**
 * 跨平台常驻服务管理。
 * macOS：launchd（~/Library/LaunchAgents）
 * Windows：任务计划程序（schtasks，登录时启动）
 */
import { execFile, execFileSync } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { isMac, isWindows } from './platform.mjs';
import { WATCH_FILES, checkFreshness, formatFreshness } from './deploy-freshness.mjs';
import { tokenPath } from './local-token.mjs';
import { parseListenerPid, diagnoseListener, parseLaunchdPid, deploymentDrift, isOurOverlayCommand } from './service-guard.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
// 0.8.0 改名 DSH Rig：launchd 标签换成 com.goodlifedog.dsh-rig.*
const LABEL_DAEMON = 'com.goodlifedog.dsh-rig.daemon';
const LABEL_OVERLAY = 'com.goodlifedog.dsh-rig.overlay';
// 旧版本的标签。升级时必须主动清掉：launchd 不会因为我们改了 plist 名字就停掉旧的，
// 新旧两套会同时跑、同时抢 7788/7789（用户看到的是「daemon 起不来 / 端口被占」）。
const LEGACY_LABELS = ['com.desktop-agent.daemon', 'com.desktop-agent.overlay'];
// Windows 计划任务名（同一个道理：新名前缀 dsh-rig-，旧的 desktop-agent- 要删）
const WIN_TASK_DAEMON = 'dsh-rig-daemon';
const WIN_TASK_OVERLAY = 'dsh-rig-overlay';
const LEGACY_WIN_TASKS = ['desktop-agent-daemon', 'desktop-agent-overlay'];

function run(cmd, args) {
  return new Promise((resolve) => execFile(cmd, args, { timeout: 30000 }, (err, stdout, stderr) =>
    resolve({ ok: !err, out: (stdout || '').trim(), err: (stderr || '').trim() })));
}

function nodeBin() { return process.execPath; }

function launchAgentsDir() {
  return path.join(os.homedir(), 'Library', 'LaunchAgents');
}

function uidString() {
  return String(process.getuid ? process.getuid() : 501);
}

/**
 * 清掉旧版本（Desktop Agent）留下的 launchd 服务 —— 升级到 DSH Rig 的关键一步。
 * 只动本项目那两个旧标签，不碰用户其它的 LaunchAgent。
 * 返回被清掉的标签列表（给状态/日志用）。
 */
async function cleanupLegacyLaunchAgents(dir) {
  const uid = uidString();
  const removed = [];
  for (const label of LEGACY_LABELS) {
    // 已加载时按 label bootout 最可靠；文件还在再按 plist 路径补一次
    await run('launchctl', ['bootout', 'gui/' + uid + '/' + label]);
    const file = path.join(dir, label + '.plist');
    if (fs.existsSync(file)) {
      await run('launchctl', ['bootout', 'gui/' + uid, file]);
      try { await fsp.rm(file, { force: true }); } catch {}
      removed.push(label);
    }
  }
  if (removed.length) {
    console.log('已清理旧版本服务（' + removed.join(', ') + '），避免新旧两套同时抢端口');
  }
  return removed;
}

async function macInstall() {
  const dir = launchAgentsDir();
  await fsp.mkdir(dir, { recursive: true });
  // 先清旧版本（com.desktop-agent.*），否则新旧两套同时跑会抢 7788/7789
  await cleanupLegacyLaunchAgents(dir);
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
  // 升级：先删旧任务名，再建新的（否则登录时会同时拉起两套）
  for (const name of LEGACY_WIN_TASKS) await run('schtasks', ['/Delete', '/TN', name, '/F']);
  for (const [name, cmd] of [[WIN_TASK_DAEMON, daemonCmd], [WIN_TASK_OVERLAY, overlayCmd]]) {
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
    // 卸载也要顺手清旧版本标签：用户可能直接跑 uninstall 来收拾升级残留
    await cleanupLegacyLaunchAgents(dir);
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
    for (const name of [WIN_TASK_DAEMON, WIN_TASK_OVERLAY, ...LEGACY_WIN_TASKS]) {
      const r = await run('schtasks', ['/Delete', '/TN', name, '/F']);
      if (r.ok) console.log('已删除 ' + name);
      else if (LEGACY_WIN_TASKS.includes(name)) continue;   // 旧任务本来就不存在，不算失败
      else console.log('删除失败 ' + name);
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


/** 进程启动时间（毫秒）。ps lstart 受 locale 影响，这里强制 C locale；解析失败返回 0 让调用方跳过。 */
function processStartMs(pid) {
  if (!pid) return 0;
  try {
    const out = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'lstart='], {
      encoding: 'utf8',
      env: Object.assign({}, process.env, { LC_ALL: 'C', LANG: 'C' }),
      timeout: 3000,
    }).trim();
    const ms = Date.parse(out);
    return Number.isFinite(ms) ? ms : 0;
  } catch { return 0; }
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
  // 升级检查：旧版本（Desktop Agent）的服务还在的话，端口冲突的根因就在这里，必须显式说出来，
  // 否则用户只看到「daemon 起不来」却不知道是两个 label 在抢同一个端口。
  const legacy = [];
  if (isMac) {
    for (const label of LEGACY_LABELS) {
      if (await launchdPid(label)) legacy.push(label + '（运行中）');
      else if (fs.existsSync(path.join(launchAgentsDir(), label + '.plist'))) legacy.push(label + '（残留 plist）');
    }
    if (legacy.length) {
      console.log('⚠ 检测到旧版本服务：' + legacy.join('、')
        + ' —— 跑 npm run service:install 会自动清理（或先 npm run service:uninstall）');
    }
  }
  // 代码新鲜度：改了直接依赖却没重启时，上面的「部署状态」照样是 ok，这里补一句提醒
  const daemonFresh = checkFreshness({ rootDir: ROOT, startedAtMs: processStartMs(listener.pid), files: WATCH_FILES.daemon });
  const overlayFresh = checkFreshness({ rootDir: ROOT, startedAtMs: processStartMs(overlayListener.pid), files: WATCH_FILES.overlay });
  console.log(formatFreshness('daemon', daemonFresh));
  console.log(formatFreshness('overlay', overlayFresh));
  return { listener, managed, verdict, drift, overlayListener, overlayManaged, overlayDrift, legacy };
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