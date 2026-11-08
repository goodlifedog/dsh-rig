'use strict';
// repo:check 的隐私/个人材料规则（纯函数单测；不跑 CLI、不读仓库文件）
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PRIVACY,
  findMaterialFileName,
  checkPrivacyText,
  checkPrivacyFile,
  stripAllowLiterals,
  isContentExempt,
  personalTokens,
  main,
} from '../scripts/repo-check.mjs';

const kinds = (findings) => findings.map((f) => f.kind);

test('个人材料文件名命中：简历 / resume / cv（不区分大小写，含目录名）', () => {
  for (const file of [
    'docs/在线简历优化.md',
    'resume.pdf',
    'CV.md',
    'docs/Resume-2027.docx',
    'a/简历/notes.md',
    'cv/README.md',
  ]) {
    assert.ok(findMaterialFileName(file), file + ' 应命中文名规则');
  }
});

test('普通文件名不误报', () => {
  for (const file of [
    'core/cdp.mjs',
    'test/repo-check-privacy.test.mjs',
    'docs/coverage.md',
    'scripts/recover.mjs',
    'test/cvss.test.mjs',
    'core/tasks/multi-app.mjs',
  ]) {
    assert.equal(findMaterialFileName(file), '', file + ' 不该命中');
  }
});

test('个人材料内容：强特征单条即红', () => {
  for (const text of ['## 个人优势', '项目经历：xxx', '求职意向：后台开发', '教育经历 2019-2023', '身份证号 110101...', '期望薪资 15-20K']) {
    const findings = checkPrivacyText(text, { file: 'docs/whatever.md' });
    assert.ok(kinds(findings).includes('personal-material'), text + ' 应判红：' + JSON.stringify(findings));
  }
});

test('个人材料内容：弱特征单条不红、两条才红（避免误伤正常文档）', () => {
  assert.deepEqual(checkPrivacyText('个人简历模板说明', { file: 'docs/x.md' }), []);
  assert.deepEqual(checkPrivacyText('期望职位：后台开发', { file: 'docs/x.md' }), []);
  const both = checkPrivacyText('个人简历：期望职位 后台开发', { file: 'docs/x.md' });
  assert.ok(kinds(both).includes('personal-material'), JSON.stringify(both));
});

test('真实姓名 / 本机用户名命中（大小写不敏感）', () => {
  const findings = checkPrivacyText('作者：zhangsan 的机器', { file: 'docs/x.md', tokens: ['zhangsan'] });
  assert.ok(kinds(findings).includes('machine-token'), JSON.stringify(findings));
  const upper = checkPrivacyText('ZHANGSAN', { file: 'docs/x.md', tokens: ['zhangsan'] });
  assert.ok(kinds(upper).includes('machine-token'));
  // 太短的 token（<3 字符）不参与匹配，避免误报
  assert.deepEqual(checkPrivacyText('a b c', { file: 'docs/x.md', tokens: ['a'] }), []);
});

test('白名单放行：npm scope / appId / bundle id / 测试占位符 / GitHub 身份', () => {
  const text = [
    '"author": "goodlifedog <goodlifedog@users.noreply.github.com>"',
    '"appId": "com.goodlifedog.dsh-desktop-agent"',
    'npm 包占位符 @goodlifedog/dsh-rig',
    "HOST_BUNDLE_ID = 'com.local.ocuformhost'",
    'hostname: Test-MacBook-Pro.local',
    '/Users/tester/Applications',
    'const liveLock = (pid) => () => \'Test-MacBook-Pro.local-\' + pid;',
  ].join('\n');
  const tokens = ['goodlifedog', 'ocuformhost', 'tester', 'Test-MacBook-Pro'];
  assert.deepEqual(checkPrivacyText(text, { file: 'package.json', tokens }), []);
  assert.deepEqual(checkPrivacyText(text, { file: 'test/fixture.mjs', tokens }), []);
});

test('白名单放行：GitHub noreply / example 邮箱', () => {
  for (const text of [
    '联系 goodlifedog@users.noreply.github.com',
    '邮箱 dev@example.com 与 ops@example.org',
  ]) {
    assert.deepEqual(checkPrivacyText(text, { file: 'docs/x.md' }), [], text);
  }
  // 真邮箱仍然抓
  const real = checkPrivacyText('邮箱 someone@corp-mail.net', { file: 'docs/x.md' });
  assert.ok(kinds(real).includes('email'), JSON.stringify(real));
});

test('白名单放行：文档保留网段 203.0.113.x / 198.51.100.x 与 loopback', () => {
  assert.deepEqual(checkPrivacyText('示例 https://203.0.113.7 与 198.51.100.9，监听 127.0.0.1:7789 / localhost', { file: 'docs/x.md' }), []);
  const priv = checkPrivacyText('内网 192.168.1.9 和 10.0.0.5', { file: 'docs/x.md' });
  assert.ok(kinds(priv).includes('intranet-ip'), JSON.stringify(priv));
});

test('仍能抓到绝对用户路径 / 手机号 / 密钥 / 内网 IP', () => {
  assert.ok(kinds(checkPrivacyText('/Users/someone/Desktop/secret.md', { file: 'docs/x.md' })).includes('absolute-path'));
  assert.ok(kinds(checkPrivacyText('电话 13800138000', { file: 'docs/x.md' })).includes('phone'));
  assert.ok(kinds(checkPrivacyText('token ghp_abcdefghijklmnop', { file: 'docs/x.md' })).includes('secret'));
  assert.ok(kinds(checkPrivacyText('-----BEGIN RSA PRIVATE KEY-----', { file: 'docs/x.md' })).includes('secret'));
});

test('规则本体与过程文档不会被自己的关键词误伤（内容豁免）', () => {
  assert.equal(isContentExempt('scripts/repo-check.mjs'), true);
  assert.equal(isContentExempt('test/repo-check-privacy.test.mjs'), true);
  assert.equal(isContentExempt('docs/REVIEW.md'), true);
  assert.equal(isContentExempt('flow/TASK-EXTERNALIZE.md'), true);
  assert.equal(isContentExempt('docs/guide.md'), false);
  // 同样的关键词：规则本体/过程文档放行，普通文档照样红
  assert.deepEqual(checkPrivacyText('个人优势 项目经历 求职意向', { file: 'scripts/repo-check.mjs' }), []);
  assert.deepEqual(checkPrivacyText('个人简历 期望职位', { file: 'flow/TASK-EXTERNALIZE.md' }), []);
  assert.ok(kinds(checkPrivacyText('个人优势', { file: 'docs/guide.md' })).includes('personal-material'));
});

test('stripAllowLiterals 只剔白名单字面量，不碰其它内容', () => {
  const out = stripAllowLiterals('@goodlifedog/cli com.local.ocuformhost tester 13800138000');
  assert.ok(!/goodlifedog|ocuformhost|tester/.test(out));
  assert.match(out, /13800138000/);
});

test('checkPrivacyFile：文件名与内容一起检查，文件名命中优先', () => {
  const findings = checkPrivacyFile({ file: 'docs/在线简历优化.md', text: '个人优势：能加班', tokens: [] });
  assert.deepEqual(kinds(findings).slice(0, 1), ['personal-material-filename']);
  assert.ok(kinds(findings).includes('personal-material'));
  // 干净文件没有任何 finding
  assert.deepEqual(checkPrivacyFile({ file: 'core/cdp.mjs', text: 'const a = 1;', tokens: [] }), []);
});

test('被 import 时零副作用：只导出纯函数与 main，规则常量冻结', () => {
  assert.equal(typeof main, 'function');
  assert.equal(typeof checkPrivacyText, 'function');
  assert.equal(typeof findMaterialFileName, 'function');
  assert.ok(Object.isFrozen(PRIVACY));
  assert.ok(Object.isFrozen(PRIVACY.STRONG_KEYWORDS));
  assert.deepEqual([...PRIVACY.STRONG_KEYWORDS], ['个人优势', '项目经历', '求职意向', '教育经历', '身份证', '期望薪资']);
});

test('本机 token 由运行时动态取，不把真实姓名写进代码', () => {
  const tokens = personalTokens();
  assert.ok(Array.isArray(tokens));
  for (const t of tokens) {
    assert.equal(typeof t, 'string');
    assert.ok(t.length >= 3);
    // 通用占位符不该被当成隐私 token
    assert.notEqual(t.toLowerCase(), 'tester');
    assert.notEqual(t.toLowerCase(), 'localhost');
  }
});
