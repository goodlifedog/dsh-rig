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
import { parseProbeArgs, probeEnv, resolveProbeNames } from '../core/app-probe-plan.mjs';
import { scanDirs, userAppDirs, SYSTEM_APP_DIRS } from '../core/app-scan.mjs';
import { loadRisk, partitionRisky } from '../core/front-risk.mjs';
import { PRESETS, presetApps } from '../core/app-presets.mjs';

/** 全部门类预设拍平：apps:probe 按名字探测时用来把「邮件」这种预设显示名映射回 bundle */
const ALL_PRESET_APPS = Object.values(PRESETS).flat();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const USER_DIRS = userAppDirs();
const SYSTEM_DIRS = SYSTEM_APP_DIRS;

// 当前正在跑的探测子进程：本脚本被 Ctrl-C / 上层杀掉时连它一起杀，避免孤儿继续动屏幕
let activeChild = null;

function killGroup(child, signal) {
  if (!child || !child.pid) return;
  try { process.kill(-child.pid, signal); } catch {}
  try { child.kill(signal); } catch {}
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    killGroup(activeChild, signal === 'SIGINT' ? 'SIGINT' : 'SIGTERM');
    setTimeout(() => killGroup(activeChild, 'SIGKILL'), 3000);
    setTimeout(() => process.exit(signal === 'SIGINT' ? 130 : 143), 3200);
  });
}

function runNode(scriptPath, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath], {
      cwd: ROOT,
      env: { ...process.env, ...env },
      stdio: 'inherit',
      detached: true,
    });
    activeChild = child;
    child.on('error', (error) => { activeChild = null; reject(error); });
    child.on('exit', (code) => {
      activeChild = null;
      if (code === 0) resolve();
      else reject(new Error(scriptPath + ' 退出码 ' + code));
    });
  });
}

async function resolveByName(names) {
  const installed = [...(await scanDirs(USER_DIRS)), ...(await scanDirs(SYSTEM_DIRS))];
  // 预设显示名（中文）→ 实际 bundle/process：中文系统里窗口 owner 是本地化名，矩阵要用中文名才匹配得到窗口
  const { matched, missing } = resolveProbeNames({ names, installed, presets: ALL_PRESET_APPS });
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
      console.error('提示：可以写安装清单里的英文名、预设显示名（如 邮件/日历/预览）、bundle id 或进程名；全部清单：npm run apps:inventory');
      process.exit(1);
    }
    resolved = result.matched.map(({ name, bundle, process }) => ({ name, bundle, process }));
  }

  // 前台风险名单：这些应用探测一次就会闪一次，直接跳过并提示怎么清
  const risk = loadRisk();
  if (plan.mode === 'apps') {
    const { safe, risky } = partitionRisky(resolved, risk);
    if (risky.length) {
      console.log('跳过（前台风险名单，读取会抢前台）：' + risky.map((a) => a.name).join('、'));
      console.log('确认修好后：npm run front:risk -- --clear "应用名"，再探测');
      resolved = safe;
      if (!resolved.length) {
        console.log('没有可探测的应用了。');
        return;
      }
    }
  } else if (plan.mode === 'preset') {
    const { risky } = partitionRisky(presetApps(plan.preset), risk);
    if (risky.length) console.log('提示：预设里有 ' + risky.length + ' 个应用在风险名单里（' + risky.map((a) => a.name).join('、') + '），矩阵会自动跳过读取');
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
