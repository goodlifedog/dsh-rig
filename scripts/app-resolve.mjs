#!/usr/bin/env node
import { overlayBase } from '../core/ports.mjs';
/**
 * 通道协商：控制某个应用之前，先看现在哪条通道真的能用、该按什么顺序降级。
 *
 *   npm run app:resolve -- Finder
 *   npm run app:resolve -- "Google Chrome" --json
 *   npm run app:resolve -- --all-user        # 把 /Applications 里的应用逐个协商一遍
 *
 * 只做只读探测：不启动应用、不发业务 Apple 事件、不点任何东西。
 */
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { scanDirs, matchAppByNames, userAppDirs, allAppDirs } from '../core/app-scan.mjs';
import { profileApp } from '../core/app-profile.mjs';
import { negotiateChannels, driverLabel } from '../core/driver-resolution.mjs';
import { isAppRunning, readSafe, windowCount, frontName, settleFront } from '../core/background.mjs';
import { probeDebugPort, debugPortFor } from '../core/cdp-driver.mjs';
import { checkAutomationPermission } from '../core/applescript-driver.mjs';
import { closeOcuMcp } from '../core/ocu-mcp.mjs';
import { localHeaders } from '../core/local-token.mjs';

const OVERLAY = overlayBase();

function appPid(app) {
  const candidates = [app.processName, app.appName].filter(Boolean);
  for (const name of candidates) {
    try {
      const out = String(execFileSync('/usr/bin/pgrep', ['-x', String(name)], { timeout: 2000 })).trim();
      const pid = Number.parseInt(out.split('\n')[0], 10);
      if (Number.isFinite(pid) && pid > 0) return pid;
    } catch {}
  }
  return 0;
}

/** 问 overlay 的系统窗口层：某个应用有几个窗口（AX 窗口数不可信时的补充证据，按 pid 匹配最可靠） */
async function overlayWindowCount(app) {
  try {
    const res = await fetch(OVERLAY + '/windows', { headers: localHeaders(), signal: AbortSignal.timeout(2000) });
    const data = await res.json();
    const windows = data.windows || [];
    const pid = appPid(app);
    if (pid) return windows.filter((w) => Number(w.pid) === pid).length;
    const name = String(app.appName || app.bundleId || '');
    const words = [name, String(app.bundleId || '').split('.').pop()].filter(Boolean);
    return windows.filter((w) => {
      const text = String(w.owner || '') + ' ' + String(w.title || '');
      return words.some((word) => word && text.toLowerCase().includes(word.toLowerCase()));
    }).length;
  } catch {
    return 0;
  }
}

const DIRS = allAppDirs();

async function resolveOne(app, profile) {
  const before = await frontName();
  const result = await negotiateChannels(
    { appName: app.name, bundleId: app.bundle, processName: app.process, appPath: app.appPath, runtime: profile.type },
    {
      deps: {
        isRunning: (check) => isAppRunning(check),
        readSafe: (name) => readSafe(name, { timeoutMs: 3000 }),
        windowCount: (name) => windowCount(name, { altNames: [app.process] }),
        probeCdp: (port) => probeDebugPort(port, { timeoutMs: 800 }),
        sdefCommands: async () => profile.applescript.commands,
        automationPermission: (target) => checkAutomationPermission(target),
        debugPortFor: (key) => debugPortFor(key),
        overlayWindows: (target) => overlayWindowCount(target),
      },
    },
  );
  const settled = await settleFront(before, { waitMs: 150, retries: 2 });
  result.frontStolen = settled.stolen;
  result.frontRestoredOk = settled.restored;
  result.profile = { type: profile.type, evidence: profile.evidence, commands: profile.applescript.commands };
  return result;
}

function printResult(r) {
  console.log('=== ' + r.app.appName + '（' + r.app.bundleId + '）');
  console.log('运行时：' + r.runtime + (r.profile.evidence && r.profile.evidence.length ? '（' + r.profile.evidence.join('；') + '）' : ''));
  console.log('脚本字典：' + (r.profile.commands ? r.profile.commands + ' 条命令' : '没有'));
  for (const c of r.channels) {
    console.log('  ' + (c.available ? '[可用] ' : '[不可用] ') + c.driver + '（' + c.label + '）：' + c.reason);
  }
  console.log('协商结果：' + (r.usable ? r.plan.map((d) => driverLabel(d)).join(' → ') : '没有可用通道 — ' + r.note));
}

async function main() {
  const args = process.argv.slice(2);
  const asJson = args.includes('--json');
  const allUser = args.includes('--all-user');
  const names = args.filter((a) => !a.startsWith('-'));

  const scanDirsList = allUser ? userAppDirs() : DIRS;
  if (!asJson) console.error('[resolve] 扫描安装的应用…');
  const installed = await scanDirs(scanDirsList);
  if (!asJson) console.error('[resolve] 扫到 ' + installed.length + ' 个应用');
  let targets = [];
  if (allUser) {
    targets = installed;
  } else {
    if (!names.length) {
      console.error('用法：npm run app:resolve -- <应用名> [--json] | --all-user [--json]');
      process.exit(1);
    }
    const { matched, missing } = matchAppByNames(installed, names);
    if (missing.length) {
      console.error('没找到：' + missing.join('、'));
      process.exit(1);
    }
    targets = matched;
  }

  const out = [];
  for (const app of targets) {
    if (!asJson) console.error('[resolve] 采集画像：' + app.name);
    const profile = await profileApp(app.appPath);
    if (!asJson) console.error('[resolve] 协商通道：' + app.name);
    const r = await resolveOne(app, profile);
    out.push(r);
    if (asJson) console.log(JSON.stringify(r));
    else if (allUser) console.log(app.name + ' | ' + r.runtime + ' | ' + (r.usable ? r.plan.join('>') : '无可用通道'));
    else printResult(r);
  }
  if (!asJson && allUser) {
    const usable = out.filter((r) => r.usable).length;
    console.log('\n' + usable + '/' + out.length + ' 个应用当前有可用通道');
  }
}

main()
  .then(async () => {
    await closeOcuMcp().catch(() => {});
    process.exit(0);
  })
  .catch(async (e) => {
    console.error('FAIL:', e.message);
    await closeOcuMcp().catch(() => {});
    process.exit(1);
  });
