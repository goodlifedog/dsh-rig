'use strict';
// P4 续：把「发 AppleEvent 前必须有自动化预检」做成常驻静态检查（flow/PERMISSIONS-AUDIT.md H2）。
//
// 规则实现在 core/safety-audit.mjs（auditSource 规则 6 / auditAppleEventPreflight）。
// 本文件覆盖：fixture 放行、fixture 报错、audit-ok 豁免、ObjC/JXA 不误报、
// 当前仓库全绿、规则非空转、白名单(结构性 + 已知缺口)没有腐烂。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  auditSource, auditAppleEventPreflight, findAppleEventSites, summarizeViolations,
  AUTOMATION_PREFLIGHT_RE, AUTOMATION_PREFLIGHT_FILE_ALLOWLIST, AUTOMATION_PREFLIGHT_KNOWN_GAPS,
  APPLEEVENT_PREFLIGHT_DIRS, APPLEEVENT_SCOPE_RE, AUDIT_OK_RE,
} from '../core/safety-audit.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const rulesOf = (file, source) => auditSource({ file, source }, { base: '', uiGuard: false })
  .filter((v) => v.rule === 'appleevent-without-preflight');

const SITE = "execFile('/usr/bin/osascript', ['-e', 'tell application \"System Events\" to count processes']);";

// ---------- fixture 1：有预检 → 放行 ----------

test('fixture：同文件有自动化预检 → 放行（5 个预检名都认）', () => {
  for (const gate of [
    'checkAutomationPermission',
    'createAppleEventPreflight',
    'preflightAppleEvent',
    'runAppleEventGuarded',
    'decideAutomationAllow',
  ]) {
    const source = 'const p = ' + gate + '(/* fake */);\n' + SITE;
    assert.deepEqual(rulesOf('core/tasks/fixture-gated.mjs', source), [], gate);
  }
  // 预检名只出现在注释里不算（避免注释骗过规则）
  const commentOnly = '// TODO: checkAutomationPermission 还没接\n' + SITE;
  assert.equal(rulesOf('core/tasks/fixture-comment-gate.mjs', commentOnly).length, 1);
});

// ---------- fixture 2：裸 tell System Events → 报错 ----------

test('fixture：裸 osascript tell System Events 没有预检 → 报 appleevent-without-preflight 并给行号', () => {
  const source = '// 没预检\n' + SITE;
  const violations = auditSource({ file: 'core/tasks/fixture-bare.mjs', source }, { base: '', uiGuard: false });
  const hits = violations.filter((v) => v.rule === 'appleevent-without-preflight');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].file, 'core/tasks/fixture-bare.mjs');
  assert.match(hits[0].detail, /L2/);
  assert.match(hits[0].detail, /audit-ok/);
  assert.match(hits[0].detail, /System Events/);
});

// ---------- fixture 3：audit-ok 豁免 ----------

test('fixture：// audit-ok: <理由> 生效（上一行/同一行），空理由不生效', () => {
  const source = [
    '// audit-ok: 只读探针，外层已做预检',
    SITE,
    SITE + ' // audit-ok: 同一行豁免',
    '// audit-ok:',
    SITE,
  ].join('\n');
  const hits = rulesOf('core/tasks/fixture-ok.mjs', source);
  assert.equal(hits.length, 1, '只有空理由那条应报错');
  assert.match(hits[0].detail, /L5/);
});

// ---------- fixture 4：ObjC/JXA 不误报 ----------

test('fixture：ObjC/JXA（不含 tell application）不算 AppleEvent，不误报', () => {
  const jxaObjc = "execFile('/usr/bin/osascript', ['-l', 'JavaScript', '-e', 'ObjC.import(\"CoreGraphics\"); JSON.stringify($.CGWindowListCopyWindowInfo(1, 0));']);";
  assert.deepEqual(findAppleEventSites(jxaObjc), []);
  assert.deepEqual(rulesOf('core/tasks/fixture-objc.mjs', jxaObjc), []);

  // JXA 的 Application('X') 虽然也是 AppleEvent，但本规则只认 tell application（按任务要求）
  const jxaApp = "execFile('/usr/bin/osascript', ['-l', 'JavaScript', '-e', \"const app = Application('System Events');\"]);";
  assert.deepEqual(findAppleEventSites(jxaApp), []);

  // 注释里的 tell application 不算
  assert.deepEqual(rulesOf('core/tasks/fixture-comment.mjs', '// tell application "System Events" 只是说明文字'), []);
});

test('fixture：exec/spawn 的多种写法与多行参数都能识别', () => {
  const spawnForm = "spawn('osascript', ['-e', 'tell application \"Finder\" to get name of home']);";
  assert.equal(findAppleEventSites(spawnForm).length, 1);

  const multiLine = [
    "execFile('/usr/bin/osascript', [",
    "  '-e',",
    "  'tell application \"System Events\" to get name of first process whose frontmost is true',",
    ']);',
  ].join('\n');
  assert.equal(findAppleEventSites(multiLine).length, 1);
});

test('规则只作用于 core/ scripts/ 作用域', () => {
  assert.equal(APPLEEVENT_SCOPE_RE.test('core/tasks/x.mjs'), true);
  assert.equal(APPLEEVENT_SCOPE_RE.test('core/safety-audit.mjs'), true);
  assert.equal(APPLEEVENT_SCOPE_RE.test('scripts/x.mjs'), true);
  assert.equal(APPLEEVENT_SCOPE_RE.test('test/x.test.mjs'), false);
  assert.equal(APPLEEVENT_SCOPE_RE.test('overlay/main.js'), false);
  assert.ok(AUDIT_OK_RE.test('// audit-ok: 有理由'));
});

// ---------- 当前仓库全绿回归 ----------

function collectEntries() {
  const entries = [];
  for (const dir of APPLEEVENT_PREFLIGHT_DIRS) {
    const abs = path.join(ROOT, dir);
    for (const name of fs.readdirSync(abs)) {
      if (!name.endsWith('.mjs')) continue;
      const full = path.join(abs, name);
      if (!fs.statSync(full).isFile()) continue;
      entries.push({ file: dir + '/' + name, source: fs.readFileSync(full, 'utf8') });
    }
  }
  return entries;
}

test('当前仓库：core/tasks、core/*.mjs、scripts 里所有 AppleEvent 调用点都有预检/白名单/豁免', () => {
  const entries = collectEntries();
  assert.ok(entries.length >= 60, '扫描文件数不对：' + entries.length);
  const violations = entries.flatMap((entry) => auditAppleEventPreflight(entry));
  assert.deepEqual(violations, [], summarizeViolations(violations));
});

test('规则不是空转：当前代码里确实能扫出 AppleEvent 调用点', () => {
  const entries = collectEntries();
  const totalHits = entries.reduce((n, entry) => n + findAppleEventSites(entry.source).length, 0);
  assert.ok(totalHits >= 40, '命中数异常少（' + totalHits + '），规则可能失效或扫描路径错了');
});

test('白名单没有腐烂：文件真实存在、理由非空；已知缺口必须明说"已知缺口"', () => {
  const entries = collectEntries();
  const byFile = new Map(entries.map((entry) => [entry.file, entry]));

  const structural = Object.keys(AUTOMATION_PREFLIGHT_FILE_ALLOWLIST);
  assert.ok(structural.length >= 8, '结构性白名单条目太少');
  let covered = 0;
  for (const file of structural) {
    const reason = String(AUTOMATION_PREFLIGHT_FILE_ALLOWLIST[file] || '').trim();
    assert.ok(reason.length >= 8, file + ' 的白名单理由太短/为空');
    const entry = byFile.get(file);
    assert.ok(entry, file + ' 在白名单里但仓库里找不到（路径写错了？）');
    if (findAppleEventSites(entry.source).length > 0) covered += 1;
  }
  assert.ok(covered >= 6, '结构性白名单里真正命中 AppleEvent 的条目太少（' + covered + '）');

  const gaps = Object.keys(AUTOMATION_PREFLIGHT_KNOWN_GAPS);
  // 下界只保证清单不被悄悄清空（防止「改规则绕过」）；条目是否真的仍欠债由下面逐条命中检查兜底。
  // 原先写死 >= 5 是 H2 收口期的快照；后续批次陆续补掉缺口后数量会自然变少，不能反过来逼着人保留过期条目。
  // 缺口清单允许为空（H2 清零后的正常状态）；为空时下面的逐条检查自然跳过，上限 <=10 仍然生效。
  // 缺口是「待还的债」不是「豁免」：数量必须有上限，新增缺口要 Lead 明确同意（改这个数字）
  assert.ok(gaps.length <= 10, '已知缺口超过 10 个：先把旧的补掉，别让清单变成永久豁免');
  for (const file of gaps) {
    const reason = String(AUTOMATION_PREFLIGHT_KNOWN_GAPS[file] || '').trim();
    assert.ok(reason.length >= 8, file + ' 的缺口理由太短/为空');
    assert.match(reason, /已知缺口/, file + ' 的理由必须明说「已知缺口」，不能伪装成结构性豁免');
    const entry = byFile.get(file);
    assert.ok(entry, file + ' 在缺口列表里但仓库里找不到');
    assert.ok(findAppleEventSites(entry.source).length > 0, file + ' 已经不再命中（缺口已补？请从列表删掉）');
  }
});
