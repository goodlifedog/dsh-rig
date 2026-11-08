'use strict';
/**
 * 发布彩排：在「干净副本」上把发布路径完整走一遍，六步任一失败即停并给原因。
 *
 *   node scripts/release-rehearsal.mjs --dry-run   # 只打印六步计划与环境检查，不执行
 *   node scripts/release-rehearsal.mjs             # 完整彩排（推荐）
 *   node scripts/release-rehearsal.mjs --quick     # 跳过全量单测，只跑 npm run check
 *   node scripts/release-rehearsal.mjs --keep      # 保留临时目录并打印路径（排障用）
 *
 * 六步（对应「别人克隆下来能不能用」）：
 *   1) 干净副本：git archive HEAD 解到 mkdtemp(0700)，只含 tracked 文件（无日志/报告/node_modules）
 *   2) 安装：副本里 npm install --ignore-scripts（npm cache 指到临时目录，不污染本机）
 *   3) 测试：副本里 npm test（--quick 时只跑 npm run check）
 *   4) 打包：npm pack + 校验 tarball 含 ocu 三份许可、不含 logs/reports/flow/node_modules/个人材料
 *   5) 全局安装：临时 prefix 装 tgz → 临时 PATH 里跑 dsh-rig CLI → platform-smoke（HOME 隔离）
 *   6) publish --dry-run：不真发；缺 registry 认证按「环境跳过」处理
 *
 * 安全边界：不启停本机服务、不碰 launchd、不写用户数据（平台自检用隔离 HOME）、不真发布、
 * 不全局安装到本机 prefix（--prefix 指到临时目录）。所有临时目录在 finally 里删掉（--keep 除外）。
 *
 * 纯逻辑（计划/命令/校验/分类/汇总）都抽成导出函数；runRehearsal 的 exec 与 fs 可注入，
 * 单测用假实现，不真装包、不联网。
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDirectRun } from '../core/direct-run.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

// ---------------------------------------------------------------------------
// 计划 / 参数 / 命令构造
// ---------------------------------------------------------------------------

/** 六步定义：id 用于命令构造与分类，timeoutMs 是单步上限 */
export const REHEARSAL_STEPS = Object.freeze([
  { id: 'archive', title: '干净副本（git archive HEAD → 临时目录）', timeoutMs: 120000 },
  { id: 'install', title: '安装依赖（npm install --ignore-scripts）', timeoutMs: 600000 },
  { id: 'test', title: '副本内测试（npm test / --quick 只跑 check）', timeoutMs: 600000 },
  { id: 'pack', title: '打包并校验 tarball 内容（npm pack）', timeoutMs: 180000 },
  { id: 'global', title: '临时 prefix 全局安装 + CLI + platform-smoke', timeoutMs: 420000 },
  { id: 'publish', title: 'npm publish --dry-run（不真发）', timeoutMs: 180000 },
]);

export const USAGE = [
  '用法：node scripts/release-rehearsal.mjs [--dry-run] [--quick] [--keep]',
  '  --dry-run  只打印六步计划与环境检查，不执行任何步骤',
  '  --quick    跳过全量 npm test，只跑 npm run check',
  '  --keep     保留临时目录并打印路径（排障用）',
].join('\n');

/**
 * 解析 CLI 参数（纯函数）。
 * @param {string[]} argv 不含 node/脚本名的参数
 * @returns {{ok:boolean, opts?:object, error?:string}}
 */
export function parseArgs(argv = []) {
  const opts = { dryRun: false, quick: false, keep: false, help: false };
  for (const raw of argv) {
    const arg = String(raw);
    if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--quick') opts.quick = true;
    else if (arg === '--keep') opts.keep = true;
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else return { ok: false, error: '未知参数：' + arg, opts };
  }
  return { ok: true, opts };
}

/**
 * 构造六步计划（纯函数）：给 --dry-run 打印，也给人看每一步到底做什么。
 * @param {{quick?:boolean}} [options]
 * @returns {Array<{id:string, title:string, detail:string, timeoutMs:number}>}
 */
export function buildPlan(options = {}) {
  const quick = Boolean(options.quick);
  const details = {
    archive: 'git archive HEAD | tar -x 到 mkdtemp(0700) 副本：只含 tracked 文件，不带本机日志/报告/node_modules',
    install: 'npm install --ignore-scripts：npm cache 指向临时目录，不写本机 ~/.npm',
    test: quick ? '--quick：只跑 npm run check（跳过全量 npm test）' : 'npm test：副本里的全量单测（不依赖本机服务）',
    pack: 'npm pack --json：校验含 ocu 三份许可、不含 logs/reports/flow/node_modules/个人材料',
    global: '临时 prefix 安装 tgz → 临时 PATH 跑 dsh-rig CLI → node core/platform-smoke.mjs（HOME 隔离，不写用户数据）',
    publish: 'npm publish --dry-run --no-git-checks：不真发；缺 registry 认证按环境跳过',
  };
  return REHEARSAL_STEPS.map((step) => ({
    id: step.id,
    title: step.title,
    detail: details[step.id] || '',
    timeoutMs: step.timeoutMs,
  }));
}

/**
 * 构造每一步要跑的命令（纯函数；dry-run 也用它打印）。
 * @param {{workDir?:string, tarPath?:string, tarballPath?:string, globalPrefix?:string,
 *          installedDir?:string, quick?:boolean, npmBin?:string, nodeBin?:string, sourceDir?:string}} [ctx]
 */
export function buildCommands(ctx = {}) {
  const c = ctx || {};
  const workDir = c.workDir || '<work>';
  const npm = c.npmBin || 'npm';
  const nodeBin = c.nodeBin || process.execPath;
  const installedDir = c.installedDir || '<installed>';
  return {
    archive: { file: 'git', args: ['archive', '--format=tar', 'HEAD', '-o', c.tarPath || '<tar>'], cwd: c.sourceDir || ROOT },
    extract: { file: 'tar', args: ['-xf', c.tarPath || '<tar>', '-C', workDir], cwd: c.sourceDir || ROOT },
    install: { file: npm, args: ['install', '--ignore-scripts', '--no-audit', '--no-fund'], cwd: workDir },
    test: c.quick
      ? { file: npm, args: ['run', 'check'], cwd: workDir }
      : { file: npm, args: ['test'], cwd: workDir },
    pack: { file: npm, args: ['pack', '--json'], cwd: workDir },
    globalInstall: { file: npm, args: ['install', '-g', '--prefix', c.globalPrefix || '<prefix>', c.tarballPath || '<tgz>'], cwd: workDir },
    cli: {
      file: 'dsh-rig',
      args: ['tasks'],
      cwd: c.globalPrefix || '<prefix>',
      pathPrefix: c.globalPrefix ? path.join(c.globalPrefix, 'bin') : '<prefix>/bin',
    },
    smoke: {
      file: nodeBin,
      args: [path.join(installedDir, 'core', 'platform-smoke.mjs')],
      cwd: installedDir,
    },
    publish: { file: npm, args: ['publish', '--dry-run', '--no-git-checks'], cwd: workDir },
  };
}

/** 子进程环境（纯函数）：npm cache/审计/资助提示都关掉并指到临时目录，避免污染本机 */
export function buildEnv(baseEnv = {}, cacheDir = '') {
  const env = Object.assign({}, baseEnv || {});
  env.npm_config_cache = cacheDir;
  env.npm_config_audit = 'false';
  env.npm_config_fund = 'false';
  env.npm_config_update_notifier = 'false';
  env.NO_COLOR = '1';
  return env;
}

// ---------------------------------------------------------------------------
// tarball 校验 / 结果分类（纯函数）
// ---------------------------------------------------------------------------

/** tarball 必须包含的文件（发布后别人 npm i 能不能用，全靠这些） */
export const TARBALL_REQUIRED = Object.freeze([
  'package.json',
  'core/cli.mjs',
  'LICENSE',
  'README.md',
  'third_party/open-computer-use/LICENSE',
  'third_party/open-computer-use/NOTICE.md',
  'third_party/open-computer-use/THIRD_PARTY_NOTICES.md',
]);

/** 不许进 tarball 的路径：本机台账、依赖、git、个人材料 */
export const TARBALL_FORBIDDEN = Object.freeze([
  /^logs\//,
  /^reports\//,
  /^flow\//,
  /(^|\/)node_modules\//,
  /^\.git\//,
  /(^|\/)[^/]*简历[^/]*$/,
  /(^|\/)(?:resume|resumes|cv)(?:\.[^/]*)?$/i,
  /(^|\/)\.DS_Store$/,
]);

/**
 * 校验 npm pack 的产物清单（纯函数）。
 * @param {string[]} files npm pack --json 里的 files[].path（可能带 package/ 前缀）
 * @returns {{ok:boolean, missing:string[], forbidden:string[], count:number}}
 */
export function validateTarball(files) {
  const list = (Array.isArray(files) ? files : [])
    .map((f) => String(f || '').replace(/^package\//, '').replace(/^\.\//, ''))
    .filter(Boolean);
  const missing = TARBALL_REQUIRED.filter((need) => !list.includes(need));
  const forbidden = list.filter((entry) => TARBALL_FORBIDDEN.some((re) => re.test(entry)));
  return { ok: missing.length === 0 && forbidden.length === 0, missing, forbidden, count: list.length };
}

const NETWORK_ERROR_RE = /ENOTFOUND|EAI_AGAIN|ENETUNREACH|ECONNREFUSED|ECONNRESET|ETIMEDOUT|getaddrinfo|network (?:error|unreachable|timeout)|registry[^ \n]*(?:timed? ?out|unreachable)/i;
const AUTH_ERROR_RE = /ENEEDAUTH|E401|E403|EOTP|one-time pass|not authenticated|no auth token|must be logged in|401 Unauthorized|403 Forbidden/i;

function firstLine(text, max = 160) {
  const line = String(text || '').split('\n').map((l) => l.trim()).filter(Boolean)[0] || '';
  return line.length > max ? line.slice(0, max) + '…' : line;
}

/**
 * 把一次命令结果分类成 PASS / SKIP / FAIL（纯函数）。
 * SKIP 只用于「环境不具备」：网络不可用、publish 缺 registry 认证——绝不假装通过。
 * @param {{step?:string, code?:number|null, timedOut?:boolean, stdout?:string, stderr?:string}} [input]
 * @returns {{status:'PASS'|'SKIP'|'FAIL', reason:string}}
 */
export function classifyOutcome(input = {}) {
  const step = String((input && input.step) || '');
  const code = input && input.code;
  const text = String((input && input.stdout) || '') + '\n' + String((input && input.stderr) || '');
  if (input && input.timedOut) return { status: 'FAIL', reason: '超时（' + step + '）' };
  if (code === 0) return { status: 'PASS', reason: '' };
  if (NETWORK_ERROR_RE.test(text)) return { status: 'SKIP', reason: '环境跳过：网络不可用（' + firstLine(text) + '）' };
  if (step === 'publish' && AUTH_ERROR_RE.test(text)) {
    return { status: 'SKIP', reason: '环境跳过：npm registry 认证缺失（' + firstLine(text) + '）' };
  }
  return { status: 'FAIL', reason: '退出码 ' + code + '：' + firstLine(text) };
}

/** platform-smoke 里「必需」的行：这几项不过说明装机/环境有问题，不能算通过 */
const SMOKE_REQUIRED = ['平台', '控制后端', 'ocu 可执行文件', '数据目录可写'];
/** 只是因为本机没起服务/没授权才红的行：不影响「包本身能用」的结论 */
const SMOKE_ENV_ONLY = ['overlay', '后台 daemon', 'UIA 自检'];

/**
 * 分类 platform-smoke 的输出（纯函数）：必需项全过就算 PASS；只有服务类行红则 PASS 但注明。
 * @param {{code?:number|null, stdout?:string}} [input]
 * @returns {{status:'PASS'|'FAIL', reason:string}}
 */
export function classifySmoke(input = {}) {
  const stdout = String((input && input.stdout) || '');
  const lines = stdout.split('\n').filter((line) => /✅|❌/.test(line));
  const row = (name) => lines.find((line) => line.includes(name));
  const okOf = (line) => Boolean(line) && line.includes('✅');
  const missing = SMOKE_REQUIRED.filter((name) => !row(name));
  if (missing.length) {
    return { status: 'FAIL', reason: 'platform-smoke 缺少必需项输出：' + missing.join('、') };
  }
  const badRequired = SMOKE_REQUIRED.filter((name) => !okOf(row(name)));
  if (badRequired.length) {
    return { status: 'FAIL', reason: 'platform-smoke 必需项失败：' + badRequired.join('、') };
  }
  const envBad = SMOKE_ENV_ONLY.filter((name) => row(name) && !okOf(row(name)));
  if (envBad.length) {
    return { status: 'PASS', reason: '通过（本机服务/授权未就绪：' + envBad.join('、') + '，与包本身无关）' };
  }
  return { status: 'PASS', reason: '' };
}

/**
 * 汇总六步结果（纯函数）：有 FAIL 即整体失败；只有 SKIP 算「通过但有环境跳过」。
 * @param {Array<{status:string}>} results
 * @returns {{total:number, PASS:number, SKIP:number, FAIL:number, ok:boolean}}
 */
export function summarizeResults(results = []) {
  const counts = { PASS: 0, SKIP: 0, FAIL: 0 };
  for (const result of Array.isArray(results) ? results : []) {
    const status = result && result.status;
    if (Object.prototype.hasOwnProperty.call(counts, status)) counts[status] += 1;
  }
  return { total: (results || []).length, PASS: counts.PASS, SKIP: counts.SKIP, FAIL: counts.FAIL, ok: counts.FAIL === 0 };
}

// ---------------------------------------------------------------------------
// 真实实现（可注入，单测用假 exec/假 fs）
// ---------------------------------------------------------------------------

/** 真实 exec：execFile 包一层，返回值统一成 { code, timedOut, stdout, stderr }（永不 reject） */
export function realExec() {
  return (file, args, options = {}) => new Promise((resolve) => {
    execFile(
      file,
      args || [],
      {
        cwd: options.cwd,
        env: options.env,
        timeout: options.timeout || 0,
        maxBuffer: 32 * 1024 * 1024,
        encoding: 'utf8',
      },
      (error, stdout, stderr) => {
        const timedOut = Boolean(error && error.killed && error.signal);
        resolve({
          code: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
          timedOut,
          stdout: String(stdout || ''),
          stderr: String(stderr || '') + (error && typeof error.code === 'string' ? '\n' + error.code : ''),
        });
      },
    );
  });
}

/** 真实 fs 适配器：runRehearsal 只用到这几个能力 */
export function realFs() {
  return {
    mkdtemp: (prefix) => fsp.mkdtemp(prefix),
    mkdir: (dir, options) => fsp.mkdir(dir, options),
    rm: (dir, options) => fsp.rm(dir, options),
    chmod: (dir, mode) => fsp.chmod(dir, mode).catch(() => {}),
    readFile: (file) => fsp.readFile(file, 'utf8'),
    exists: (target) => { try { return fs.existsSync(target); } catch { return false; } },
  };
}

/**
 * 环境检查（--dry-run 用；只跑 node/npm/git 版本这类无副作用命令）。
 * @param {object} [ctx]
 * @param {{exec?:Function, env?:object}} [deps]
 */
export async function collectEnvChecks(ctx = {}, deps = {}) {
  const exec = deps.exec || realExec();
  const sourceDir = (ctx && ctx.sourceDir) || ROOT;
  const npmBin = (ctx && ctx.npmBin) || 'npm';
  const checks = [
    { name: 'node', ok: true, detail: process.version },
    { name: '平台', ok: true, detail: process.platform + ' / ' + process.arch },
    { name: '临时目录', ok: true, detail: os.tmpdir() },
  ];
  const npm = await exec(npmBin, ['-v'], { timeout: 30000 });
  checks.push({ name: 'npm', ok: npm.code === 0, detail: npm.code === 0 ? npm.stdout.trim() : firstLine(npm.stderr) });
  const gitRepo = await exec('git', ['rev-parse', '--is-inside-work-tree'], { cwd: sourceDir, timeout: 30000 });
  checks.push({ name: 'git 仓库', ok: gitRepo.code === 0 && gitRepo.stdout.trim() === 'true', detail: gitRepo.code === 0 ? gitRepo.stdout.trim() : firstLine(gitRepo.stderr) });
  const head = await exec('git', ['rev-parse', '--short', 'HEAD'], { cwd: sourceDir, timeout: 30000 });
  checks.push({ name: 'HEAD', ok: head.code === 0, detail: head.code === 0 ? head.stdout.trim() : firstLine(head.stderr) });
  return checks;
}

function printPlan(plan, envChecks, log) {
  log('');
  log('发布彩排计划（--dry-run：不执行任何步骤）');
  log('');
  log('环境检查：');
  for (const check of envChecks) {
    log('  ' + (check.ok ? '✅' : '❌') + ' ' + check.name.padEnd(10) + check.detail);
  }
  log('');
  log('六步：');
  plan.forEach((step, index) => {
    log('  ' + (index + 1) + ') ' + step.title + '（上限 ' + Math.round(step.timeoutMs / 1000) + 's）');
    log('     ' + step.detail);
  });
  log('');
  log('提示：直接运行 node scripts/release-rehearsal.mjs 开始彩排；--quick 跳过全量单测；--keep 保留临时目录。');
  log('');
}

function printResults(results, summary, keptDir, log) {
  log('');
  log('发布彩排结果：');
  for (const result of results) {
    const icon = result.status === 'PASS' ? '✅' : (result.status === 'SKIP' ? '⏭️ ' : '❌');
    log('  ' + icon + ' ' + String(result.id).padEnd(8) + result.status.padEnd(5) + (result.reason || ''));
    if (result.status !== 'PASS' && result.detail) log('       ' + String(result.detail).split('\n').slice(0, 6).join('\n       '));
  }
  log('');
  log('汇总：' + summary.PASS + ' PASS / ' + summary.SKIP + ' SKIP / ' + summary.FAIL + ' FAIL'
    + (summary.ok ? (summary.SKIP ? ' → 彩排通过（有环境跳过）' : ' → 彩排全部通过') : ' → 彩排未通过'));
  if (keptDir) log('临时目录（--keep 保留）：' + keptDir);
  log('');
}

/**
 * 跑一次彩排（exec/fs 可注入）。
 * @param {{quick?:boolean, keep?:boolean}} [options]
 * @param {{exec?:Function, fs?:object, log?:Function, env?:object, sourceDir?:string,
 *          npmBin?:string, nodeBin?:string, tmpRoot?:string, ocuBin?:string}} [deps]
 */
export async function runRehearsal(options = {}, deps = {}) {
  const opts = Object.assign({ quick: false, keep: false }, options || {});
  const exec = deps.exec || realExec();
  const fsops = deps.fs || realFs();
  const log = deps.log || ((line) => console.log(line));
  const env = deps.env || process.env;
  const sourceDir = deps.sourceDir || ROOT;
  const tmpRoot = deps.tmpRoot || os.tmpdir();
  const npmBin = deps.npmBin || 'npm';
  const nodeBin = deps.nodeBin || process.execPath;

  const plan = buildPlan(opts);
  const results = [];
  let workDir = '';
  let keptDir = '';

  const finish = () => {
    // --keep 时先把临时目录记下来：finally 在 return 之后才跑，不能等它设
    if (opts.keep && workDir) keptDir = workDir;
    // 没跑到的步骤记为 SKIP，别让人误以为是 PASS
    const done = new Set(results.map((result) => result.id));
    for (const step of plan) {
      if (!done.has(step.id)) results.push({ id: step.id, status: 'SKIP', reason: '未执行：前一步未通过（失败即停）' });
    }
    const summary = summarizeResults(results);
    printResults(results, summary, keptDir, log);
    return { ok: summary.ok, results, summary, workDir: keptDir };
  };

  const record = (id, status, reason, extra = {}) => {
    results.push(Object.assign({ id, status, reason: reason || '' }, extra));
  };

  try {
    workDir = await fsops.mkdtemp(path.join(tmpRoot, 'dsh-release-'));
    await fsops.chmod(workDir, 0o700);
    const cacheDir = path.join(workDir, '.npm-cache');
    const homeDir = path.join(workDir, '.home');
    const tarPath = path.join(workDir, 'src.tar');
    const globalPrefix = path.join(workDir, 'global');
    await fsops.mkdir(cacheDir, { recursive: true });
    await fsops.mkdir(homeDir, { recursive: true });
    const isolatedEnv = buildEnv(env, cacheDir);
    const isolatedHomeEnv = buildEnv(Object.assign({}, env, { HOME: homeDir, USERPROFILE: homeDir }), cacheDir);
    const cmds = buildCommands({ workDir, tarPath, globalPrefix, quick: opts.quick, npmBin, nodeBin, sourceDir });
    const timeoutOf = (id) => (plan.find((step) => step.id === id) || {}).timeoutMs || 120000;
    const run = (step, id, extraEnv) => exec(step.file, step.args, {
      cwd: step.cwd,
      env: extraEnv || isolatedEnv,
      timeout: timeoutOf(id),
    });

    log('');
    log('发布彩排开始（六步，失败即停）');

    // 1) 干净副本
    const archiveStart = Date.now();
    let stepOut = await run(cmds.archive, 'archive');
    if (stepOut.code === 0) stepOut = await run(cmds.extract, 'archive');
    let verdict = classifyOutcome({ step: 'archive', code: stepOut.code, timedOut: stepOut.timedOut, stdout: stepOut.stdout, stderr: stepOut.stderr });
    if (verdict.status !== 'PASS') {
      record('archive', verdict.status, verdict.reason, { detail: stepOut.stderr });
      return finish();
    }
    if (!fsops.exists(path.join(workDir, 'package.json'))) {
      record('archive', 'FAIL', '副本里没有 package.json（git archive/解压异常）');
      return finish();
    }
    record('archive', 'PASS', '', { durationMs: Date.now() - archiveStart });

    // 2) 安装依赖
    const installStart = Date.now();
    stepOut = await run(cmds.install, 'install');
    verdict = classifyOutcome({ step: 'install', code: stepOut.code, timedOut: stepOut.timedOut, stdout: stepOut.stdout, stderr: stepOut.stderr });
    if (verdict.status !== 'PASS') {
      record('install', verdict.status, verdict.reason, { detail: stepOut.stderr || stepOut.stdout });
      return finish();
    }
    record('install', 'PASS', '', { durationMs: Date.now() - installStart });

    // 3) 测试（--quick 只跑语法/静态检查）
    const testStart = Date.now();
    stepOut = await run(cmds.test, 'test');
    verdict = classifyOutcome({ step: 'test', code: stepOut.code, timedOut: stepOut.timedOut, stdout: stepOut.stdout, stderr: stepOut.stderr });
    if (verdict.status !== 'PASS') {
      record('test', verdict.status, verdict.reason, { detail: (stepOut.stdout + '\n' + stepOut.stderr).trim() });
      return finish();
    }
    record('test', 'PASS', opts.quick ? '--quick：只跑了 npm run check' : '', { durationMs: Date.now() - testStart });

    // 4) 打包 + tarball 校验
    const packStart = Date.now();
    stepOut = await run(cmds.pack, 'pack');
    verdict = classifyOutcome({ step: 'pack', code: stepOut.code, timedOut: stepOut.timedOut, stdout: stepOut.stdout, stderr: stepOut.stderr });
    if (verdict.status !== 'PASS') {
      record('pack', verdict.status, verdict.reason, { detail: stepOut.stderr || stepOut.stdout });
      return finish();
    }
    const packed = parsePackJson(stepOut.stdout);
    if (!packed.ok) {
      record('pack', 'FAIL', packed.error, { detail: stepOut.stdout.slice(0, 800) });
      return finish();
    }
    const check = validateTarball(packed.files);
    if (!check.ok) {
      record('pack', 'FAIL', 'tarball 内容不合格（缺 ' + (check.missing.join(', ') || '无') + '；多了 ' + (check.forbidden.join(', ') || '无') + '）', {
        detail: '共 ' + check.count + ' 个文件',
      });
      return finish();
    }
    const tarballPath = path.join(workDir, packed.filename);
    if (!fsops.exists(tarballPath)) {
      record('pack', 'FAIL', 'npm pack 说生成了 ' + packed.filename + '，但文件不存在');
      return finish();
    }
    record('pack', 'PASS', 'tarball ' + packed.filename + '：' + check.count + ' 个文件，三份 ocu 许可齐全且无台账', { durationMs: Date.now() - packStart });

    // 5) 临时 prefix 全局安装 + CLI + platform-smoke
    const globalStart = Date.now();
    const installCmd = buildCommands({ workDir, tarballPath, globalPrefix }).globalInstall;
    stepOut = await run(installCmd, 'global');
    verdict = classifyOutcome({ step: 'global', code: stepOut.code, timedOut: stepOut.timedOut, stdout: stepOut.stdout, stderr: stepOut.stderr });
    if (verdict.status !== 'PASS') {
      record('global', verdict.status, verdict.reason, { detail: stepOut.stderr || stepOut.stdout });
      return finish();
    }
    const installedDir = [
      path.join(globalPrefix, 'lib', 'node_modules', 'dsh-rig'),
      path.join(globalPrefix, 'node_modules', 'dsh-rig'),
    ].find((dir) => fsops.exists(dir)) || '';
    if (!installedDir) {
      record('global', 'FAIL', '全局安装后在临时 prefix 里找不到 dsh-rig 包目录');
      return finish();
    }
    const cliCmd = buildCommands({ globalPrefix }).cli;
    const pathEnv = Object.assign({}, isolatedEnv, {
      PATH: path.join(globalPrefix, 'bin') + path.delimiter + path.dirname(nodeBin) + path.delimiter + String(isolatedEnv.PATH || ''),
    });
    const cliOut = await exec(cliCmd.file, cliCmd.args, { cwd: cliCmd.cwd, env: pathEnv, timeout: timeoutOf('global') });
    if (cliOut.code !== 0) {
      record('global', 'FAIL', 'CLI（dsh-rig tasks）跑不通：' + firstLine(cliOut.stderr || cliOut.stdout), { detail: cliOut.stderr || cliOut.stdout });
      return finish();
    }
    const smokeCmd = buildCommands({ installedDir, nodeBin }).smoke;
    const smokeEnv = Object.assign({}, isolatedHomeEnv);
    const ocuBin = deps.ocuBin || env.OCU_BIN || path.join(os.homedir(), '.local', 'bin', 'ocu');
    if (fsops.exists(ocuBin)) smokeEnv.OCU_BIN = ocuBin;
    const smokeOut = await exec(smokeCmd.file, smokeCmd.args, { cwd: smokeCmd.cwd, env: smokeEnv, timeout: timeoutOf('global') });
    const smoke = classifySmoke({ code: smokeOut.code, stdout: smokeOut.stdout + '\n' + smokeOut.stderr });
    record('global', smoke.status, smoke.reason ? 'CLI ok；platform-smoke ' + smoke.reason : 'CLI ok；platform-smoke 全部通过', {
      durationMs: Date.now() - globalStart,
      detail: smoke.status === 'FAIL' ? (smokeOut.stdout || smokeOut.stderr) : '',
    });
    if (smoke.status !== 'PASS') return finish();

    // 6) publish --dry-run（不真发）
    const publishStart = Date.now();
    const publishEnv = Object.assign({}, env, {
      npm_config_cache: cacheDir,
      npm_config_audit: 'false',
      npm_config_fund: 'false',
      npm_config_update_notifier: 'false',
      NO_COLOR: '1',
    });
    stepOut = await run(cmds.publish, 'publish', publishEnv);
    verdict = classifyOutcome({ step: 'publish', code: stepOut.code, timedOut: stepOut.timedOut, stdout: stepOut.stdout, stderr: stepOut.stderr });
    record('publish', verdict.status, verdict.reason || 'npm publish --dry-run 通过（没有真的发布）', {
      durationMs: Date.now() - publishStart,
      detail: verdict.status === 'FAIL' ? (stepOut.stderr || stepOut.stdout) : '',
    });
    return finish();
  } finally {
    if (workDir && !opts.keep) {
      try { await fsops.rm(workDir, { recursive: true, force: true }); } catch {}
    } else if (workDir) {
      keptDir = workDir;
    }
  }
}

/**
 * 解析 npm pack --json 的输出（纯函数）：取最后一个 JSON 数组里的 {filename, files[]}。
 * @param {string} stdout
 * @returns {{ok:boolean, filename?:string, files?:string[], error?:string}}
 */
export function parsePackJson(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return { ok: false, error: 'npm pack 没有输出' };
  const candidates = [];
  for (let i = text.indexOf('['); i !== -1; i = text.indexOf('[', i + 1)) candidates.push(i);
  for (let i = candidates.length - 1; i >= 0; i -= 1) {
    try {
      const parsed = JSON.parse(text.slice(candidates[i]));
      if (Array.isArray(parsed) && parsed.length) {
        const last = parsed[parsed.length - 1];
        if (last && last.filename) {
          const files = (last.files || []).map((entry) => (typeof entry === 'string' ? entry : entry && entry.path)).filter(Boolean);
          return { ok: true, filename: last.filename, files };
        }
      }
    } catch {}
  }
  return { ok: false, error: 'npm pack --json 输出解析失败（找不到 filename/files）' };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export async function main(argv = process.argv.slice(2), deps = {}) {
  const parsed = parseArgs(argv);
  const log = deps.log || ((line) => console.log(line));
  if (!parsed.ok) {
    log(parsed.error);
    log(USAGE);
    return 2;
  }
  const opts = parsed.opts;
  if (opts.help) {
    log(USAGE);
    return 0;
  }
  const plan = buildPlan(opts);
  if (opts.dryRun) {
    const checks = await collectEnvChecks({}, deps);
    printPlan(plan, checks, log);
    return 0;
  }
  log('发布彩排：六步全部在临时目录里跑，不启停本机服务、不写用户数据、不真发布。');
  const outcome = await runRehearsal(opts, deps);
  return outcome.ok ? 0 : 1;
}

if (isDirectRun(import.meta.url)) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error('发布彩排失败：' + (error && error.message ? error.message : error));
      process.exit(1);
    });
}
