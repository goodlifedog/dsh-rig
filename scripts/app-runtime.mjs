#!/usr/bin/env node
/**
 * 应用运行时画像：不启动应用，只看包结构和链接框架，判断它属于哪类运行时、该走哪条通道。
 *
 *   npm run app:runtime -- Steam
 *   npm run app:runtime -- --all          # 把本机装的应用按运行时归类一遍
 *   npm run app:runtime -- --all --user   # 只看 /Applications 里自己装的
 *   npm run app:runtime -- Safari --json
 */
import { scanDirs, matchAppByNames } from '../core/app-scan.mjs';
import { profileApp } from '../core/app-profile.mjs';
import { chooseDriverChain, describeProfile } from '../core/app-runtime.mjs';

const USER_DIRS = ['/Applications', '/Applications/Utilities'];
const DIRS = [
  ...USER_DIRS,
  '/System/Applications', '/System/Applications/Utilities',
  // Finder 在这里（还有些系统级 app），不扫就查不到
  '/System/Library/CoreServices',
];

async function profileOf(app) {
  const collected = await profileApp(app.appPath);
  const profile = {
    ...app,
    type: collected.type,
    evidence: collected.evidence,
    applescript: { available: collected.applescript.available, commands: collected.applescript.commands },
  };
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
    console.error('用法：npm run app:runtime -- <应用名> [--json] | --all [--user]');
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
