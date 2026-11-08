'use strict';
// 安全边界静态自查：规则本身要能抓出危险写法，而且当前仓库必须一直是干净的。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditSource, auditTree, summarizeViolations, UI_GUARD_ALLOWLIST } from '../core/safety-audit.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function rules(file, source, options = {}) {
  return auditSource({ file, source }, { base: '', ...options }).map((v) => v.rule);
}

test('启动应用不收尾 → 抓出来', () => {
  assert.deepEqual(rules('core/tasks/x.mjs', 'await ensureAppRunning({ appName: "Calculator" });'), ['launch-no-cleanup']);
});

test('启动后自己收掉 → 放行', () => {
  assert.deepEqual(rules('core/tasks/x.mjs', 'await ensureAppRunning({}); await quitApp({});'), []);
});

test('强杀进程 → 抓出来（-9 / killall）', () => {
  assert.ok(rules('core/tasks/x.mjs', 'exec("/usr/bin/pkill", ["-x", "Notes"]);').length === 0);
  assert.ok(rules('core/tasks/x.mjs', 'exec("/usr/bin/pkill", ["-9", "Notes"]);').includes('force-kill'));
  assert.ok(rules('core/tasks/x.mjs', 'exec("killall", ["Notes"]);').includes('force-kill'));
});

test('open 不带 -g → 抓出来（会激活应用、切屏）', () => {
  assert.ok(rules('core/tasks/x.mjs', 'exec("/usr/bin/open", ["-a", "Calculator"]);').includes('open-without-background'));
  assert.deepEqual(rules('core/tasks/x.mjs', 'exec("/usr/bin/open", ["-g", "-a", "Calculator"]);'), []);
});

test('界面操作没有锁屏/前台/互斥护栏 → 抓出来', () => {
  assert.deepEqual(rules('core/tasks/x.mjs', 'const s = await app.getAXState();'), ['ui-without-guard']);
  assert.deepEqual(rules('core/tasks/x.mjs', 'if (await isScreenLocked()) return; const s = await app.getAXState();'), []);
  assert.deepEqual(rules('core/tasks/x.mjs', 'if (risk.shouldSkip(app)) return; const s = await app.getAXState();'), []);
});

test('显式允许的内层脚本不要求护栏；脚本目录可关掉这条规则', () => {
  assert.ok(UI_GUARD_ALLOWLIST.includes('greet-inner.mjs'));
  assert.deepEqual(rules('core/tasks/greet-inner.mjs', 'await app.getAXState();'), []);
  assert.deepEqual(rules('scripts/x.mjs', 'await app.getAXState();', { uiGuard: false }), []);
});

test('汇总：干净时说清楚；有问题时按规则计数并给出文件', () => {
  assert.match(summarizeViolations([]), /通过/);
  const text = summarizeViolations([
    { rule: 'force-kill', file: 'a.mjs', detail: 'pkill -9' },
    { rule: 'force-kill', file: 'b.mjs', detail: 'killall' },
  ]);
  assert.match(text, /发现 2 处问题/);
  assert.match(text, /force-kill × 2/);
  assert.match(text, /b\.mjs/);
});

test('当前仓库 core/tasks 全部干净（改坏就会被这条测试拦住）', () => {
  const dir = path.join(ROOT, 'core/tasks');
  const entries = fs.readdirSync(dir).filter((f) => f.endsWith('.mjs')).map((f) => ({
    file: 'core/tasks/' + f,
    source: fs.readFileSync(path.join(dir, f), 'utf8'),
  }));
  const violations = auditTree(entries, { base: '', uiGuard: true });
  assert.deepEqual(violations, [], summarizeViolations(violations));
  assert.ok(entries.length >= 20, '任务文件数不对，可能扫描路径错了');
});
