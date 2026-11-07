#!/usr/bin/env node
/**
 * 一条命令探测一批应用：按名字或门类预设跑矩阵，跑完自动刷新清点。
 *
 *   npm run apps:probe -- GarageBand,UURemote
 *   npm run apps:probe -- --preset tools
 *   npm run apps:probe -- --preset tools --dry
 *   npm run apps:probe -- GarageBand --keep        # 探测完不关应用（排障用）
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseProbeArgs, probeEnv } from '../core/app-probe-plan.mjs';
import { scanDirs, matchAppByNames } from '../core/app-scan.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const USER_DIRS = ['/Applications', '/Applications/Utilities'];
const SYSTEM_DIRS = ['/System/Applications', '/System/Applications/Utilities'];

function runNode(scriptPath, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath], {
      cwd: ROOT,
      env: { ...process.env, ...env },
      stdio: 'inherit',
    });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(scriptPath + ' 退出码 ' + code))));
  });
}

async function resolveByName(names) {
  const installed = [...(await scanDirs(USER_DIRS)), ...(await scanDirs(SYSTEM_DIRS))];
  const { matched, missing } = matchAppByNames(installed, names);
  return { matched, missing, installed };
}

async function main() {
  const plan = parseProbeArgs(process.argv.slice(2));
  if (plan.error) {
    console.error('参数有问题：' + plan.error);
    console.error('用法：npm run apps:probe -- [应用名,应用名…] | --preset <门类> [--dry] [--keep] [--no-refresh]');
    process.exit(1);
  }

  let resolved = [];
  if (plan.mode === 'apps') {
    const result = await resolveByName(plan.names);
    if (result.missing.length) {
      console.error('没找到这些应用：' + result.missing.join('、'));
      console.error('已装的应用可以用 npm run apps:inventory 查看清单');
      process.exit(1);
    }
    resolved = result.matched.map(({ name, bundle, process }) => ({ name, bundle, process }));
  }

  const env = probeEnv(plan, resolved);
  const label = plan.mode === 'preset' ? ('预设 ' + plan.preset) : (plan.mode === 'apps' ? resolved.map((a) => a.name).join('、') : '默认列表');
  console.log('将要探测：' + label + (plan.keep ? '（探测完不关闭）' : ''));

  if (plan.dry) {
    console.log('环境变量：' + JSON.stringify(env));
    console.log('命令：node core/tasks/app-matrix.mjs');
    if (plan.refresh) console.log('之后：node scripts/app-inventory.mjs');
    return;
  }

  await runNode(path.join(ROOT, 'core/tasks/app-matrix.mjs'), env);
  if (plan.refresh) await runNode(path.join(ROOT, 'scripts/app-inventory.mjs'), {});
}

main().catch((e) => {
  console.error('FAIL:', e.message);
  process.exit(1);
});
