'use strict';
// P4 常驻静态检查：对具体应用调 ocu 之前必须有运行门禁（flow/OCU-CALL-AUDIT.md 第 1 节）。
//
// 规则实现在 core/safety-audit.mjs（auditSource 规则 5 / auditOcuAppCalls）。
// 本文件做三件事：
//   1) 两个 fixture：有门禁放行、没门禁报错（fixture 写在系统临时目录，不往仓库写固定文件）；
//   2) 一个 // audit-ok: 逐点豁免用例（上一行、同一行都认；空理由不认）；
//   3) 当前仓库全绿回归：扫 core/tasks、core/*.mjs、scripts（CLI 只扫前两个，core/*.mjs 由这里兜底），
//      并检查文件级白名单没有腐烂（理由非空、文件真实存在）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  auditSource, auditOcuAppCalls, findOcuAppCalls, summarizeViolations,
  PRESENCE_FILE_ALLOWLIST, OCU_PRESENCE_DIRS, AUDIT_OK_RE, OCU_APP_CALL_RE, OCU_PRESENCE_SCOPE_RE,
} from '../core/safety-audit.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** fixture 写到系统临时目录，只在审计时给一个"仓库内相对路径"当作用域标记 */
function withFixture(name, source, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'safety-audit-fixture-'));
  try {
    const file = path.join(dir, name);
    fs.writeFileSync(file, source);
    const read = fs.readFileSync(file, 'utf8');
    return fn({ repoPath: 'core/tasks/' + name, source: read });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const rulesOf = (file, source) => auditSource({ file, source }, { base: '', uiGuard: false }).map((v) => v.rule);

// ---------- fixture 1：有运行门禁 → 放行 ----------

test('fixture：先 isAppRunning 再 state/click → 放行', () => {
  withFixture('fixture-has-gate.mjs', [
    "const running = await isAppRunning({ appName: 'Calculator' });",
    "if (!running) return;",
    "const tree = await state('Calculator');",
    "await click('Calculator', 1);",
    '',
  ].join('\n'), ({ repoPath, source }) => {
    assert.ok(!rulesOf(repoPath, source).includes('raw-ocu-without-presence-gate'), '有运行门禁就不该报这条');
    // ensureAppRunning / requireAppRunning 也算门禁（ensureAppRunning 会另外触发「启动要收尾」规则，这里只看门禁规则）
    for (const gate of ['ensureAppRunning({ appName: "Calculator" })', 'requireAppRunning(APP, { isAppRunning })']) {
      const rules = rulesOf('core/tasks/fixture-gate-2.mjs', gate + "\nawait state('Calculator');");
      assert.ok(!rules.includes('raw-ocu-without-presence-gate'), gate + ' 应算运行门禁');
    }
  });
});

// ---------- fixture 2：没有运行门禁 → 报错（文件:行） ----------

test('fixture：直接 state/readSafe 且没有门禁 → 报 raw-ocu-without-presence-gate 并给出行号', () => {
  withFixture('fixture-no-gate.mjs', [
    '// 故意不写任何运行门禁，验证规则能抓出来',
    "const tree = await state('Calculator');",
    "const rd = await readSafe('Calculator');",
    '',
  ].join('\n'), ({ repoPath, source }) => {
    const violations = auditSource({ file: repoPath, source }, { base: '', uiGuard: false });
    assert.equal(violations.length, 2, '两处命中都应报出来');
    for (const v of violations) {
      assert.equal(v.rule, 'raw-ocu-without-presence-gate');
      assert.equal(v.file, repoPath);
    }
    assert.match(violations[0].detail, /L2/);
    assert.match(violations[1].detail, /L3/);
    assert.match(violations[0].detail, /audit-ok/);
  });
});

// ---------- fixture 3：// audit-ok: 逐点豁免 ----------

test('fixture：// audit-ok: <理由> 生效（上一行/同一行），空理由不生效', () => {
  withFixture('fixture-exempt.mjs', [
    "// audit-ok: 只读探针，外层任务已做运行门禁",
    "const a = await state('Calculator');",
    "const b = await state('Calculator'); // audit-ok: 同一行豁免",
    "// audit-ok:",
    "const c = await state('Calculator');",
    '',
  ].join('\n'), ({ repoPath, source }) => {
    const violations = auditSource({ file: repoPath, source }, { base: '', uiGuard: false });
    assert.equal(violations.length, 1, '只有空理由那一条应报错');
    assert.match(violations[0].detail, /L5/);
    assert.match(AUDIT_OK_RE.source, /audit-ok/);
  });
});

test('规则只作用于 core/ scripts/ 作用域，其它目录不误报', () => {
  assert.equal(OCU_PRESENCE_SCOPE_RE.test('core/tasks/x.mjs'), true);
  assert.equal(OCU_PRESENCE_SCOPE_RE.test('core/background.mjs'), true);
  assert.equal(OCU_PRESENCE_SCOPE_RE.test('scripts/x.mjs'), true);
  assert.equal(OCU_PRESENCE_SCOPE_RE.test('test/x.test.mjs'), false);
  assert.equal(OCU_PRESENCE_SCOPE_RE.test('overlay/main.js'), false);
  assert.equal(OCU_APP_CALL_RE.test("await readSafe('X')"), true);
  assert.equal(OCU_APP_CALL_RE.test("list.find((x) => x)"), false, '同名方法不能误报');
});

// ---------- 当前仓库全绿回归 ----------

function collectEntries() {
  const entries = [];
  for (const dir of OCU_PRESENCE_DIRS) {
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

test('当前仓库：core/tasks、core/*.mjs、scripts 全部满足运行门禁规则', () => {
  const entries = collectEntries();
  assert.ok(entries.length >= 60, '扫描文件数不对：' + entries.length);
  const violations = entries.flatMap((entry) => auditOcuAppCalls(entry));
  assert.deepEqual(violations, [], summarizeViolations(violations));
});

test('规则不是空转：当前代码里确实能命中大量调用点（规则/正则失效会掉到这里）', () => {
  const entries = collectEntries();
  const totalHits = entries.reduce((n, entry) => n + findOcuAppCalls(entry.source).length, 0);
  assert.ok(totalHits >= 50, '命中数异常少（' + totalHits + '），规则可能失效或扫描路径错了');
});

test('文件级白名单没有腐烂：每条都有理由、文件真实存在；命中类条目确实在挡规则', () => {
  const entries = collectEntries();
  const files = Object.keys(PRESENCE_FILE_ALLOWLIST);
  assert.ok(files.length >= 10, '白名单条目太少，可能在误删理由');
  let coveredHits = 0;
  for (const file of files) {
    const reason = PRESENCE_FILE_ALLOWLIST[file];
    assert.ok(String(reason || '').trim().length >= 8, file + ' 的白名单理由太短/为空');
    const entry = entries.find((e) => e.file === file);
    assert.ok(entry, file + ' 在白名单里但仓库里找不到（路径写错了？）');
    if (findOcuAppCalls(entry.source).length > 0) coveredHits += 1;
  }
  // 有些条目（通用通道/AppleScript 通道）是为"以后改这里"预留的，当前可能没命中；
  // 但大多数条目应当真的在挡规则，否则白名单就成了空壳。
  assert.ok(coveredHits >= 8, '白名单里真正命中规则的条目太少（' + coveredHits + '），检查是否失效');
});
