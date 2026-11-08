'use strict';
// acceptance 的 AppleEvent 入口：预检授权后行为不变 / 未授权跳过 / unknown 仍尝试。
// 全部注入假 exec 与假 preflight，**不 spawn osascript、不发真实 AppleEvent**。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createAppleEventOps,
  noteAppleEventWarning,
  appleEventWarnings,
  appleEventWarningSection,
  summarizeCleanupRun,
  finalFrontWarning,
} from '../core/acceptance.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const OLD = {
  activateHost: 'tell application "System Events" to set frontmost of first process whose bundle identifier is "com.deepseek.dsh" to true',
  restoreBundle: (bundle) => 'tell application "System Events" to set frontmost of first process whose bundle identifier is ' + JSON.stringify(bundle) + ' to true',
  frontmostApp: 'tell application "System Events" to get name of first process whose frontmost is true',
  frontmostBundle: 'tell application "System Events" to get bundle identifier of first process whose frontmost is true',
  restoreUserFront: (name) => 'tell application "System Events" to set frontmost of first process whose name is ' + JSON.stringify(name) + ' to true',
};

const granted = async () => ({ allowed: true, status: 'granted' });
const denied = async () => ({ allowed: false, status: 'denied', warning: '自动化未授权（denied），已跳过该 AppleEvent' });
const unknown = async () => ({ allowed: true, status: 'unknown' });
const pickyExec = () => {
  const calls = [];
  const exec = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const script = args.join(' ');
    if (script.includes('get name of first process whose frontmost')) return 'Calculator\n';
    if (script.includes('get bundle identifier of first process whose frontmost')) return 'com.apple.calculator\n';
    return '';
  };
  return { calls, exec };
};

test('已授权：五个 AppleEvent 入口的 osascript 参数/超时与旧实现逐字一致', async () => {
  const { calls, exec } = pickyExec();
  const warnings = [];
  const ops = createAppleEventOps({ exec, platform: 'darwin', preflight: granted, onWarning: (w) => warnings.push(w) });

  assert.equal(await ops.activateHost(), true);
  assert.deepEqual(calls[0], { cmd: '/usr/bin/osascript', args: ['-e', OLD.activateHost], opts: { timeout: 5000 } });

  assert.equal(await ops.restoreBundle('com.apple.Safari'), undefined);
  assert.deepEqual(calls[1], { cmd: '/usr/bin/osascript', args: ['-e', OLD.restoreBundle('com.apple.Safari')], opts: { timeout: 5000 } });

  assert.equal(await ops.frontmostApp(), 'Calculator');
  assert.deepEqual(calls[2], { cmd: '/usr/bin/osascript', args: ['-e', OLD.frontmostApp], opts: { encoding: 'utf8', timeout: 4000 } });

  assert.equal(await ops.frontmostBundle(), 'com.apple.calculator');
  assert.deepEqual(calls[3], { cmd: '/usr/bin/osascript', args: ['-e', OLD.frontmostBundle], opts: { encoding: 'utf8', timeout: 3000 } });

  assert.equal(await ops.restoreUserFront('DeepSeek Harness'), true);
  assert.deepEqual(calls[4], { cmd: '/usr/bin/osascript', args: ['-e', OLD.frontmostApp], opts: { encoding: 'utf8', timeout: 4000 } });
  assert.deepEqual(calls[5], { cmd: '/usr/bin/osascript', args: ['-e', OLD.restoreUserFront('DeepSeek Harness')], opts: { timeout: 5000 } });
  assert.deepEqual(warnings, [], '已授权时不应产生任何 warning');
});

test('未授权：五个入口都跳过 AppleEvent，返回安全兜底并记 warning', async () => {
  const { calls, exec } = pickyExec();
  const warnings = [];
  const ops = createAppleEventOps({ exec, platform: 'darwin', preflight: denied, onWarning: (w) => warnings.push(w) });

  assert.equal(await ops.activateHost(), false);
  assert.equal(await ops.restoreBundle('com.apple.Safari'), undefined);
  assert.equal(await ops.frontmostApp(), '');
  assert.equal(await ops.frontmostBundle(), null);
  assert.equal(await ops.restoreUserFront('DeepSeek Harness'), false);
  assert.equal(calls.length, 0, '未授权时一条 osascript 都不许发');
  assert.ok(warnings.length >= 1);
  assert.ok(warnings.every((w) => /未授权/.test(w)));
});

test('预检 unknown / 抛错：仍然发 AppleEvent（探测抖动不能让还原失效）', async () => {
  const { calls, exec } = pickyExec();
  const opsUnknown = createAppleEventOps({ exec, platform: 'darwin', preflight: unknown });
  assert.equal(await opsUnknown.activateHost(), true);
  assert.equal(calls.length, 1);

  const { calls: calls2, exec: exec2 } = pickyExec();
  const opsThrow = createAppleEventOps({
    exec: exec2,
    platform: 'darwin',
    preflight: async () => { throw new Error('probe boom'); },
  });
  assert.equal(await opsThrow.activateHost(), true);
  assert.equal(calls2.length, 1, '预检自己抛错也要继续尝试');
});

test('非 macOS：Linux 平台不发 AppleEvent，返回原兜底', async () => {
  const { calls, exec } = pickyExec();
  const ops = createAppleEventOps({ exec, platform: 'linux', preflight: granted });
  assert.equal(await ops.activateHost(), false);
  assert.equal(await ops.restoreBundle('com.apple.Safari'), undefined);
  assert.equal(await ops.frontmostBundle(), null);
  assert.equal(calls.length, 0);
});

test('未授权 warning 会写进验收报告小节（去重）', () => {
  const before = appleEventWarnings().length;
  noteAppleEventWarning('激活宿主：自动化未授权（denied），已跳过该 AppleEvent');
  noteAppleEventWarning('激活宿主：自动化未授权（denied），已跳过该 AppleEvent');
  const warnings = appleEventWarnings();
  assert.equal(warnings.length, before + 1, '同一条 warning 只记一次');
  const section = appleEventWarningSection();
  assert.ok(section.includes('## 自动化授权告警'));
  assert.ok(section.some((line) => /未授权/.test(line)));
});
// ---------- M2 / M5 / L8：收尾报告与调用点 ----------

test('M2：解析 cleanup-test-data JSON，envSkip/deleted 摘要进清理说明', () => {
  const payload = {
    dryRun: false,
    skipped: true,
    envSkip: true,
    skippedKinds: ['note-skipped', 'chrome-skipped'],
    deleted: { notes: 0, textEdit: 1, chrome: 0 },
    report: [],
  };
  const notes = summarizeCleanupRun({ code: 0, stdout: 'before json\n' + JSON.stringify(payload) + '\n', stderr: '' });
  assert.equal(notes.length, 1);
  assert.match(notes[0], /环境跳过/);
  assert.match(notes[0], /note-skipped\/chrome-skipped/);
  assert.match(notes[0], /notes=0 textEdit=1 chrome=0/);
});

test('M2：清理脚本非 0 退出码、stdout 非 JSON 都要记一条（不静默）', () => {
  const payload = { skipped: false, envSkip: false, deleted: { notes: 2, textEdit: 0, chrome: 0 } };
  const notes = summarizeCleanupRun({ code: 1, stdout: JSON.stringify(payload), stderr: 'boom' });
  assert.ok(notes.some((n) => /退出码 1/.test(n)));
  assert.ok(notes.some((n) => /deleted notes=2/.test(n)), '正常删除也要有摘要');

  const broken = summarizeCleanupRun({ code: 0, stdout: 'not json', stderr: '' });
  assert.equal(broken.length, 1);
  assert.match(broken[0], /解析清理脚本 JSON 失败/);
});

test('M5：仅当「有 AppleEvent 告警 + 前后前台不同」时写环境说明（不判失败）', () => {
  const warnings = ['激活宿主：自动化未授权（denied）'];
  assert.equal(finalFrontWarning({ frontAtStart: 'DeepSeek Harness', finalFront: 'Calculator', appleEventWarnings: [] }), '', '没有告警时不该归因于授权');
  assert.equal(finalFrontWarning({ frontAtStart: 'DeepSeek Harness', finalFront: 'DeepSeek Harness', appleEventWarnings: warnings }), '');
  assert.equal(finalFrontWarning({ frontAtStart: '', finalFront: 'Calculator', appleEventWarnings: warnings }), '');
  const note = finalFrontWarning({ frontAtStart: 'DeepSeek Harness', finalFront: 'Calculator', appleEventWarnings: warnings });
  assert.match(note, /起始 DeepSeek Harness.*结束 Calculator/);
  assert.match(note, /不判验收失败/);
});

test('L8 静态回归：acceptance 里五个 AppleEvent helper 的调用点都带 await', () => {
  const src = fs.readFileSync(path.join(HERE, '..', 'core', 'acceptance.mjs'), 'utf8');
  const names = ['frontmostBundle', 'activateHost', 'restoreBundle', 'frontmostApp', 'restoreUserFront'];
  const missing = [];
  src.split('\n').forEach((line, index) => {
    const code = line.trim();
    if (!code || code.startsWith('//') || code.startsWith('*')) return;
    for (const name of names) {
      if (line.includes('defaultAppleEventOps.' + name)) continue; // 包装函数内部的 Promise 透传
      if (/async function\s+/.test(line) && line.includes(name + '(')) continue; // 函数声明
      if (!new RegExp('\\b' + name + '\\s*\\(').test(line)) continue;
      if (!new RegExp('await\\s+' + name + '\\s*\\(').test(line)) {
        missing.push((index + 1) + ': ' + code);
      }
    }
  });
  assert.deepEqual(missing, [], '这些调用点必须 await，否则会静默不同步：' + missing.join(' | '));
});
