#!/usr/bin/env node
/**
 * 应用运行时画像：不启动应用，只看包结构和链接框架，判断它属于哪类运行时、该走哪条通道。
 *
 *   npm run app:runtime -- Steam
 *   npm run app:runtime -- --all          # 把本机装的应用按运行时归类一遍
 *   npm run app:runtime -- --all --user   # 只看 /Applications 里自己装的
 *   npm run app:runtime -- Safari --json
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { scanDirs, matchAppByNames } from '../core/app-scan.mjs';
import { classifyRuntime, chooseDriverChain, countSdefCommands, describeProfile } from '../core/app-runtime.mjs';

const exec = promisify(execFile);
const USER_DIRS = ['/Applications', '/Applications/Utilities'];
const DIRS = [
  ...USER_DIRS,
  '/System/Applications', '/System/Applications/Utilities',
  // Finder 在这里（还有些系统级 app），不扫就查不到
  '/System/Library/CoreServices',
];

async function listFrameworks(appPath) {
  const out = [];
  try {
    const frames = await fs.promises.readdir(path.join(appPath, 'Contents', 'Frameworks'), { withFileTypes: true });
    for (const f of frames) out.push(f.name);
  } catch {}
  try {
    const libs = await fs.promises.readdir(path.join(appPath, 'Contents', 'Frameworks'), { withFileTypes: true });
    for (const f of libs) if (f.name.endsWith('.dylib')) out.push(f.name);
  } catch {}
  return out;
}

async function hasAsar(appPath) {
  try {
    await fs.promises.access(path.join(appPath, 'Contents', 'Resources', 'app.asar'));
    return true;
  } catch {
    return false;
  }
}

async function hasJvm(appPath) {
  const candidates = ['Contents/PlugIns', 'Contents/Java', 'Contents/Resources'];
  for (const rel of candidates) {
    const dir = path.join(appPath, rel);
    let entries = [];
    try {
      entries = await fs.promises.readdir(dir, { recursive: true, maxDepth: 3 });
    } catch {
      continue;
    }
    if (entries.some((e) => /libjvm|jdk|jre/i.test(String(e)))) return true;
  }
  return false;
}

async function linkedFrameworks(appPath) {
  const plist = path.join(appPath, 'Contents', 'Info.plist');
  let exe = '';
  try {
    const { stdout } = await exec('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleExecutable', plist], { timeout: 4000 });
    exe = String(stdout).trim();
  } catch {}
  if (!exe) return [];
  const bin = path.join(appPath, 'Contents', 'MacOS', exe);
  try {
    const { stdout } = await exec('/usr/bin/otool', ['-L', bin], { timeout: 8000 });
    return String(stdout).split('\n').map((l) => l.trim().split(' (')[0]).filter(Boolean).slice(1);
  } catch {
    return [];
  }
}

async function applescriptInfo(appPath) {
  // 本机只装了 Command Line Tools，`sdef` 命令用不了（要求完整 Xcode）；
  // 直接读包内的 .sdef 文件，效果一样且不依赖开发工具。
  try {
    const resDir = path.join(appPath, 'Contents', 'Resources');
    const entries = await fs.promises.readdir(resDir);
    const sdefs = entries.filter((f) => /\.sdef$/i.test(f));
    let commands = 0;
    for (const f of sdefs) {
      try {
        const xml = await fs.promises.readFile(path.join(resDir, f), 'utf8');
        commands += countSdefCommands(xml);
      } catch {}
    }
    return { available: commands > 0, commands };
  } catch {
    return { available: false, commands: 0 };
  }
}

async function profileOf(app) {
  const frameworks = [...(await listFrameworks(app.appPath)), ...(await linkedFrameworks(app.appPath))];
  const runtime = classifyRuntime(frameworks, {
    hasJvmRuntime: await hasJvm(app.appPath),
    hasAsar: await hasAsar(app.appPath),
  });
  const profile = { ...app, type: runtime.type, evidence: runtime.evidence, applescript: await applescriptInfo(app.appPath) };
  profile.chain = chooseDriverChain(profile);
  return profile;
}

async function main() {
  const args = process.argv.slice(2).filter((a) => a !== '--json');
  const asJson = process.argv.includes('--json');
  const all = args.includes('--all');
  const userOnly = args.includes('--user');
  const names = args.filter((a) => !a.startsWith('-'));

  const installed = await scanDirs(userOnly ? USER_DIRS : DIRS);
  if (all) {
    const rows = [];
    for (const app of installed) {
      const profile = await profileOf(app);
      rows.push({ name: app.name, type: profile.type, commands: profile.applescript.commands, chain: profile.chain.map((c) => c.driver) });
      console.log(app.name + ' | ' + profile.type + ' | AppleScript ' + profile.applescript.commands + ' 条 | ' + profile.chain.map((c) => c.driver).join('>'));
    }
    if (asJson) console.log(JSON.stringify(rows));
    return;
  }
  if (!names.length) {
    console.error('用法：npm run app:runtime -- <应用名> [--json] | --all');
    process.exit(1);
  }
  const { matched, missing } = matchAppByNames(installed, names);
  if (missing.length) {
    console.error('没找到：' + missing.join('、'));
    process.exit(1);
  }
  for (const app of matched) {
    const profile = await profileOf(app);
    if (asJson) {
      console.log(JSON.stringify(profile, null, 2));
      continue;
    }
    console.log('=== ' + app.name + '（' + app.bundle + '）');
    console.log(describeProfile(profile));
  }
}

main().catch((e) => {
  console.error('FAIL:', e.message);
  process.exit(1);
});
