'use strict';
// 发布彩排脚本的单测：纯逻辑全覆盖；runRehearsal 用假 exec/假 fs，不真装包、不联网、不发布
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  REHEARSAL_STEPS,
  USAGE,
  parseArgs,
  buildPlan,
  buildCommands,
  buildEnv,
  validateTarball,
  classifyOutcome,
  classifySmoke,
  summarizeResults,
  parsePackJson,
  collectEnvChecks,
  runRehearsal,
  main,
} from '../scripts/release-rehearsal.mjs';

const ok = (stdout = '') => ({ code: 0, timedOut: false, stdout, stderr: '' });
const bad = (code = 1, stderr = 'boom') => ({ code, timedOut: false, stdout: '', stderr });

function okPackJson(filename = 'dsh-rig-0.8.0.tgz') {
  const files = [
    'package/package.json',
    'package/core/cli.mjs',
    'package/LICENSE',
    'package/README.md',
    'package/third_party/open-computer-use/LICENSE',
    'package/third_party/open-computer-use/NOTICE.md',
    'package/third_party/open-computer-use/THIRD_PARTY_NOTICES.md',
    'package/docs/USAGE.md',
  ].map((p) => ({ path: p }));
  return JSON.stringify([{ id: 'dsh-rig@0.8.0', filename, files }], null, 2);
}

const SMOKE_OK = [
  '平台自检（darwin）',
  '  ✅ 平台        darwin',
  '  ✅ 控制后端      ocu',
  '  ✅ ocu 可执行文件  /tmp/ocu',
  '  ✅ 数据目录可写    /tmp/home/.desktop-agent/smoke',
  '  ✅ overlay 在线   ok',
  '  ✅ 后台 daemon 7789 pid=1',
  '  ❌ 需要人工处理项  无',
].join('\n');

function makeFs(opts = {}) {
  const state = {
    mkdtempPrefix: '',
    removed: [],
    dirs: new Set(),
    missing: new Set(opts.missing || []),
    mkdtempDir: opts.mkdtempDir || path.join('/tmp', 'dsh-release-fake'),
  };
  const exists = (target) => {
    const t = String(target);
    if (state.missing.has(t)) return false;
    if (t.endsWith('package.json')) return true;
    if (t.endsWith('.tgz')) return true;
    if (t.includes(path.join('lib', 'node_modules', 'dsh-rig'))) return true;
    if (t.includes('node_modules' + path.sep + 'dsh-rig')) return true;
    return state.dirs.has(t);
  };
  return {
    state,
    mkdtemp: async (prefix) => { state.mkdtempPrefix = prefix; state.dirs.add(state.mkdtempDir); return state.mkdtempDir; },
    mkdir: async (dir) => { state.dirs.add(dir); },
    rm: async (dir) => { state.removed.push(dir); },
    chmod: async () => {},
    readFile: async () => '',
    exists,
  };
}

function makeExec(handlers) {
  const calls = [];
  const exec = async (file, args, options = {}) => {
    const key = [file].concat(args || []).join(' ');
    calls.push({ key, file, args: args || [], options });
    for (const [pattern, handler] of handlers) {
      if (pattern.test(key)) return typeof handler === 'function' ? handler(key, options) : handler;
    }
    return ok();
  };
  exec.calls = calls;
  return exec;
}

function happyHandlers(overrides = []) {
  const handlers = [
    [/^git archive/, ok()],
    [/^tar -xf/, ok()],
    [/^npm install --ignore-scripts/, ok()],
    [/^npm test$/, ok('tests 100 / pass 100 / fail 0')],
    [/^npm run check$/, ok('语法检查 全部通过')],
    [/^npm pack --json/, ok(okPackJson())],
    [/^npm install -g --prefix/, ok('added 1 package')],
    [/^dsh-rig tasks$/, ok('后台服务未运行')],
    [/platform-smoke\.mjs$/, ok(SMOKE_OK)],
    [/^npm publish --dry-run/, ok('+ dsh-rig@0.8.0')],
  ];
  for (const [pattern, handler] of overrides) {
    const index = handlers.findIndex(([re]) => re.source === pattern.source);
    if (index >= 0) handlers[index] = [pattern, handler];
    else handlers.unshift([pattern, handler]);
  }
  return handlers;
}

// ---------------------------------------------------------------------------
// 纯函数
// ---------------------------------------------------------------------------

test('parseArgs：默认/三个开关/--help/未知参数', () => {
  assert.deepEqual(parseArgs([]), { ok: true, opts: { dryRun: false, quick: false, keep: false, help: false } });
  assert.deepEqual(parseArgs(['--dry-run']).opts, { dryRun: true, quick: false, keep: false, help: false });
  assert.deepEqual(parseArgs(['--quick', '--keep']).opts, { dryRun: false, quick: true, keep: true, help: false });
  assert.equal(parseArgs(['--help']).opts.help, true);
  const unknown = parseArgs(['--wat']);
  assert.equal(unknown.ok, false);
  assert.match(unknown.error, /未知参数/);
  assert.ok(USAGE.includes('--dry-run'));
});

test('buildPlan：六个步骤、顺序固定、每步有说明与正超时', () => {
  const plan = buildPlan();
  assert.equal(plan.length, 6);
  assert.deepEqual(plan.map((s) => s.id), REHEARSAL_STEPS.map((s) => s.id));
  for (const step of plan) {
    assert.ok(step.detail.length > 0, step.id + ' 缺少说明');
    assert.ok(step.timeoutMs > 0, step.id + ' 缺超时');
  }
  const quick = buildPlan({ quick: true });
  assert.match(quick.find((s) => s.id === 'test').detail, /--quick/);
  assert.match(plan.find((s) => s.id === 'test').detail, /npm test/);
});

test('buildCommands：安装/测试/打包/全局安装/publish 的参数都正确', () => {
  const ctx = { workDir: '/w', tarPath: '/w/src.tar', tarballPath: '/w/pkg.tgz', globalPrefix: '/w/global', installedDir: '/w/global/lib/node_modules/dsh-rig', quick: false };
  const cmds = buildCommands(ctx);
  assert.equal(cmds.archive.file, 'git');
  assert.deepEqual(cmds.archive.args, ['archive', '--format=tar', 'HEAD', '-o', '/w/src.tar']);
  assert.deepEqual(cmds.extract.args, ['-xf', '/w/src.tar', '-C', '/w']);
  assert.ok(cmds.install.args.includes('--ignore-scripts'));
  assert.deepEqual(cmds.test.args, ['test']);
  assert.deepEqual(cmds.pack.args, ['pack', '--json']);
  assert.deepEqual(cmds.globalInstall.args, ['install', '-g', '--prefix', '/w/global', '/w/pkg.tgz']);
  assert.equal(cmds.cli.file, 'dsh-rig');
  assert.ok(cmds.smoke.args[0].endsWith(path.join('core', 'platform-smoke.mjs')));
  assert.deepEqual(cmds.publish.args, ['publish', '--dry-run', '--no-git-checks']);
  // --quick 时测试步骤换成 npm run check
  assert.deepEqual(buildCommands({ quick: true }).test.args, ['run', 'check']);
});

test('buildEnv：npm cache 指到临时目录并关掉审计/资助提示，不改入参', () => {
  const baseEnv = { PATH: '/bin', HOME: '/home/me', npm_config_audit: 'true' };
  const env = buildEnv(baseEnv, '/tmp/cache');
  assert.equal(env.npm_config_cache, '/tmp/cache');
  assert.equal(env.npm_config_audit, 'false');
  assert.equal(env.npm_config_fund, 'false');
  assert.equal(env.npm_config_update_notifier, 'false');
  assert.equal(env.NO_COLOR, '1');
  assert.equal(env.PATH, '/bin');
  assert.equal(env.HOME, '/home/me');
  assert.equal(baseEnv.npm_config_cache, undefined, '不能改调用方的 env');
});

test('validateTarball：齐全通过；缺许可/含台账与个人材料则不合格', () => {
  const good = okPackJson();
  const parsed = parsePackJson(good);
  assert.equal(parsed.ok, true);
  const check = validateTarball(parsed.files);
  assert.equal(check.ok, true, JSON.stringify(check));
  assert.equal(check.count, 8);

  const noLicense = validateTarball(['package/package.json', 'package/core/cli.mjs', 'package/LICENSE', 'package/README.md']);
  assert.equal(noLicense.ok, false);
  assert.ok(noLicense.missing.includes('third_party/open-computer-use/LICENSE'));
  assert.deepEqual(noLicense.forbidden, []);

  const dirty = validateTarball([
    'package/package.json', 'package/core/cli.mjs', 'package/LICENSE', 'package/README.md',
    'package/third_party/open-computer-use/LICENSE',
    'package/third_party/open-computer-use/NOTICE.md',
    'package/third_party/open-computer-use/THIRD_PARTY_NOTICES.md',
    'package/logs/runs/x.jsonl', 'package/reports/app-matrix.json', 'package/flow/INDEX.md',
    'package/node_modules/x/index.js', 'package/.git/config', 'package/docs/简历优化.md', 'package/docs/resume.pdf', 'package/.DS_Store',
  ]);
  assert.equal(dirty.ok, false);
  assert.equal(dirty.forbidden.length, 8, JSON.stringify(dirty.forbidden));
});

test('parsePackJson：能从 npm 噪声里取到 filename/files；空/坏输出给错误', () => {
  const noisy = 'npm notice creating a tarball\n' + okPackJson('pkg-1.0.0.tgz');
  const parsed = parsePackJson(noisy);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.filename, 'pkg-1.0.0.tgz');
  assert.equal(parsed.files.length, 8);
  assert.equal(parsePackJson('').ok, false);
  assert.equal(parsePackJson('not json').ok, false);
  assert.equal(parsePackJson('[]').ok, false);
});

test('classifyOutcome：成功/失败/超时/网络跳过/publish 认证跳过', () => {
  assert.deepEqual(classifyOutcome({ step: 'install', code: 0 }), { status: 'PASS', reason: '' });
  assert.equal(classifyOutcome({ step: 'install', code: 1, stderr: 'something broke' }).status, 'FAIL');
  assert.equal(classifyOutcome({ step: 'install', code: null, timedOut: true }).status, 'FAIL');
  const net = classifyOutcome({ step: 'install', code: 1, stderr: 'npm ERR! code ENOTFOUND\nnpm ERR! network request failed' });
  assert.equal(net.status, 'SKIP');
  assert.match(net.reason, /网络不可用/);
  const auth = classifyOutcome({ step: 'publish', code: 1, stderr: 'npm ERR! code ENEEDAUTH\nnpm ERR! need auth' });
  assert.equal(auth.status, 'SKIP');
  assert.match(auth.reason, /认证缺失/);
  // 只有 publish 步骤才把认证失败当环境跳过；其它步骤认证字样仍是 FAIL
  assert.equal(classifyOutcome({ step: 'install', code: 1, stderr: 'npm ERR! code ENEEDAUTH' }).status, 'FAIL');
});

test('classifySmoke：必需项全过算 PASS；只有本机服务未就绪则 PASS 并注明；必需项失败则 FAIL', () => {
  assert.equal(classifySmoke({ code: 0, stdout: SMOKE_OK }).status, 'PASS');
  const envOnly = SMOKE_OK.replace('✅ overlay 在线   ok', '❌ overlay 在线   未启动');
  const envVerdict = classifySmoke({ code: 1, stdout: envOnly });
  assert.equal(envVerdict.status, 'PASS');
  assert.match(envVerdict.reason, /overlay/);
  const requiredFail = SMOKE_OK.replace('✅ ocu 可执行文件  /tmp/ocu', '❌ ocu 可执行文件  not found');
  assert.equal(classifySmoke({ code: 1, stdout: requiredFail }).status, 'FAIL');
  assert.equal(classifySmoke({ code: 1, stdout: '没有任何行' }).status, 'FAIL');
});

test('summarizeResults：有 FAIL 即整体失败，只有 SKIP 算通过', () => {
  assert.deepEqual(summarizeResults([{ status: 'PASS' }, { status: 'PASS' }]), { total: 2, PASS: 2, SKIP: 0, FAIL: 0, ok: true });
  const withSkip = summarizeResults([{ status: 'PASS' }, { status: 'SKIP' }]);
  assert.equal(withSkip.ok, true);
  assert.equal(withSkip.SKIP, 1);
  assert.equal(summarizeResults([{ status: 'PASS' }, { status: 'FAIL' }]).ok, false);
  assert.equal(summarizeResults([]).total, 0);
});

test('collectEnvChecks：用注入的 exec 采集 node/npm/git/HEAD，不跑彩排步骤', async () => {
  const exec = makeExec([
    [/^npm -v$/, ok('10.8.2\n')],
    [/^git rev-parse --is-inside-work-tree$/, ok('true\n')],
    [/^git rev-parse --short HEAD$/, ok('abc1234\n')],
  ]);
  const checks = await collectEnvChecks({}, { exec });
  const byName = Object.fromEntries(checks.map((c) => [c.name, c]));
  assert.equal(byName.node.ok, true);
  assert.equal(byName.npm.detail, '10.8.2');
  assert.equal(byName['git 仓库'].ok, true);
  assert.equal(byName.HEAD.detail, 'abc1234');
  // 只发了版本/仓库探测这三个命令，没有彩排步骤
  assert.ok(exec.calls.every((call) => /^(npm -v|git rev-parse)/.test(call.key)));
});

// ---------------------------------------------------------------------------
// runRehearsal（假 exec + 假 fs）
// ---------------------------------------------------------------------------

test('彩排全流程（假 exec/假 fs）：六步全 PASS、临时目录被清理', async () => {
  const fsops = makeFs();
  const exec = makeExec(happyHandlers());
  const logs = [];
  const outcome = await runRehearsal({}, { exec, fs: fsops, env: { PATH: '/bin' }, tmpRoot: '/tmp', log: (line) => logs.push(line) });
  assert.equal(outcome.ok, true, JSON.stringify(outcome.results));
  assert.equal(outcome.summary.PASS, 6);
  assert.equal(outcome.summary.FAIL, 0);
  assert.deepEqual(outcome.results.map((r) => r.status), ['PASS', 'PASS', 'PASS', 'PASS', 'PASS', 'PASS']);
  assert.ok(fsops.state.removed.includes(fsops.state.mkdtempDir), 'finally 里要删临时目录');
  assert.equal(outcome.workDir, '');
  // 关键命令都真的构造出来了
  const keys = exec.calls.map((call) => call.key).join('\n');
  assert.match(keys, /git archive --format=tar HEAD -o .*src\.tar/);
  assert.match(keys, /npm install --ignore-scripts/);
  assert.match(keys, /npm test/);
  assert.match(keys, /npm pack --json/);
  assert.match(keys, /npm install -g --prefix .*dsh-rig-0\.8\.0\.tgz/);
  assert.match(keys, /dsh-rig tasks/);
  assert.match(keys, /platform-smoke\.mjs/);
  assert.match(keys, /npm publish --dry-run/);
  assert.match(logs.join('\n'), /彩排全部通过/);
});

test('--quick：测试步骤换成 npm run check，不跑全量 npm test', async () => {
  const exec = makeExec(happyHandlers());
  const outcome = await runRehearsal({ quick: true }, { exec, fs: makeFs(), env: {}, log: () => {} });
  assert.equal(outcome.ok, true);
  const keys = exec.calls.map((call) => call.key);
  assert.ok(keys.includes('npm run check'), '应跑 npm run check');
  assert.ok(!keys.includes('npm test'), '不应跑全量 npm test');
  assert.match(outcome.results.find((r) => r.id === 'test').reason, /--quick/);
});

test('--keep：保留临时目录并返回路径，不删', async () => {
  const fsops = makeFs();
  const outcome = await runRehearsal({ keep: true }, { exec: makeExec(happyHandlers()), fs: fsops, env: {}, log: () => {} });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.workDir, fsops.state.mkdtempDir);
  assert.deepEqual(fsops.state.removed, []);
});

test('网络不可用：安装步骤 SKIP（不假装通过），后续步骤标未执行，整体不算失败', async () => {
  const fsops = makeFs();
  const exec = makeExec(happyHandlers([
    [/^npm install --ignore-scripts/, { code: 1, timedOut: false, stdout: '', stderr: 'npm ERR! code ENOTFOUND\nnpm ERR! network request to registry.npmjs.org failed' }],
  ]));
  const outcome = await runRehearsal({}, { exec, fs: fsops, env: {}, log: () => {} });
  assert.equal(outcome.ok, true, JSON.stringify(outcome.summary));
  const install = outcome.results.find((r) => r.id === 'install');
  assert.equal(install.status, 'SKIP');
  assert.match(install.reason, /网络不可用/);
  for (const id of ['test', 'pack', 'global', 'publish']) {
    assert.equal(outcome.results.find((r) => r.id === id).status, 'SKIP', id + ' 应该是未执行');
  }
  assert.equal(outcome.summary.FAIL, 0);
  assert.ok(fsops.state.removed.includes(fsops.state.mkdtempDir));
});

test('安装真失败（非网络）：FAIL 并停，后续标未执行，整体失败', async () => {
  const exec = makeExec(happyHandlers([[/^npm install --ignore-scripts/, bad(1, 'gyp ERR! build error')]]));
  const outcome = await runRehearsal({}, { exec, fs: makeFs(), env: {}, log: () => {} });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.results.find((r) => r.id === 'install').status, 'FAIL');
  assert.equal(outcome.results.find((r) => r.id === 'test').status, 'SKIP');
  assert.match(outcome.results.find((r) => r.id === 'install').reason, /退出码 1/);
});

test('tarball 缺 ocu 许可：打包步骤 FAIL，不进入全局安装', async () => {
  const packJson = JSON.stringify([{ filename: 'x.tgz', files: ['package/package.json', 'package/core/cli.mjs', 'package/LICENSE', 'package/README.md'].map((p) => ({ path: p })) }]);
  const exec = makeExec(happyHandlers([[/^npm pack --json/, ok(packJson)]]));
  const outcome = await runRehearsal({}, { exec, fs: makeFs(), env: {}, log: () => {} });
  assert.equal(outcome.ok, false);
  const pack = outcome.results.find((r) => r.id === 'pack');
  assert.equal(pack.status, 'FAIL');
  assert.match(pack.reason, /tarball 内容不合格/);
  assert.ok(!exec.calls.some((call) => /npm install -g/.test(call.key)), '打包不合格就不该全局安装');
});

test('platform-smoke 必需项失败：全局安装步骤 FAIL', async () => {
  const smoke = SMOKE_OK.replace('✅ 控制后端      ocu', '❌ 控制后端      unsupported');
  const exec = makeExec(happyHandlers([[/platform-smoke\.mjs$/, ok(smoke)]]));
  const outcome = await runRehearsal({}, { exec, fs: makeFs(), env: {}, log: () => {} });
  assert.equal(outcome.ok, false);
  const global = outcome.results.find((r) => r.id === 'global');
  assert.equal(global.status, 'FAIL');
  assert.match(global.reason, /platform-smoke 必需项失败/);
});

test('publish 缺 registry 认证：最后一步 SKIP，整体仍算通过（有环境跳过）', async () => {
  const exec = makeExec(happyHandlers([[/^npm publish --dry-run/, { code: 1, timedOut: false, stdout: '', stderr: 'npm ERR! code ENEEDAUTH\nnpm ERR! need auth This command requires you to be logged in.' }]]));
  const outcome = await runRehearsal({}, { exec, fs: makeFs(), env: {}, log: () => {} });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.results.find((r) => r.id === 'publish').status, 'SKIP');
  assert.equal(outcome.summary.PASS, 5);
  assert.equal(outcome.summary.SKIP, 1);
});

test('main：--dry-run 只打印计划与环境检查，不创建临时目录、不跑六步', async () => {
  const exec = makeExec([
    [/^npm -v$/, ok('10.8.2')],
    [/^git rev-parse --is-inside-work-tree$/, ok('true')],
    [/^git rev-parse --short HEAD$/, ok('abc1234')],
  ]);
  const fsops = makeFs();
  const logs = [];
  const code = await main(['--dry-run'], { exec, fs: fsops, log: (line) => logs.push(line) });
  assert.equal(code, 0);
  const text = logs.join('\n');
  assert.match(text, /发布彩排计划/);
  assert.match(text, /六步/);
  ['1) 干净副本', '2) 安装依赖', '3) 副本内测试', '4) 打包', '5) 临时 prefix', '6) npm publish'].forEach((needle) => {
    assert.ok(text.includes(needle), '缺少步骤：' + needle);
  });
  assert.equal(fsops.state.mkdtempPrefix, '', 'dry-run 不能创建临时目录');
  assert.ok(!exec.calls.some((call) => /archive|pack|publish|install/.test(call.key)), 'dry-run 不能跑六步');
});

test('main：未知参数返回 2，--help 返回 0', async () => {
  const logs = [];
  assert.equal(await main(['--wat'], { log: (line) => logs.push(line) }), 2);
  assert.match(logs.join('\n'), /未知参数/);
  const helpLogs = [];
  assert.equal(await main(['--help'], { log: (line) => helpLogs.push(line) }), 0);
  assert.match(helpLogs.join('\n'), /用法/);
});

test('模块被 import 时零副作用：只导出函数与常量', () => {
  assert.equal(typeof main, 'function');
  assert.equal(typeof runRehearsal, 'function');
  assert.ok(Object.isFrozen(REHEARSAL_STEPS));
  assert.equal(REHEARSAL_STEPS.length, 6);
});
