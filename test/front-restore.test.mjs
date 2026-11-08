'use strict';
// 前台还原决策：归一化后精确相等才算「我们动过的应用」（P1/task-39：不再做双向包含）
import test from 'node:test';
import assert from 'node:assert/strict';
import { decideRestore, normalizeFrontName } from '../core/front-restore.mjs';

test('大小写不敏感：Calculator vs calculator 不再误判 leave-user', () => {
  assert.equal(decideRestore({ current: 'Calculator', before: 'DeepSeek Harness', touched: ['计算器', 'calculator'] }), 'restore');
  assert.equal(decideRestore({ current: 'calculator', before: 'DeepSeek Harness', touched: ['计算器', 'Calculator'] }), 'restore');
  assert.equal(decideRestore({ current: 'Notes', before: 'DeepSeek Harness', touched: ['备忘录', 'notes'] }), 'restore');
});

test('候选别名：归一化后完全相等才算（不再做包含匹配）', () => {
  assert.equal(decideRestore({ current: 'Calculator', before: 'DeepSeek Harness', touched: ['Calculator'] }), 'restore');
  // P1：'calc' 只是前缀，不能算同一个应用
  assert.equal(decideRestore({ current: 'Calculator', before: 'DeepSeek Harness', touched: ['calc'] }), 'leave-user');
  assert.equal(decideRestore({ current: 'Clash Verge', before: 'DeepSeek Harness', touched: ['clash-verge'] }), 'restore');
  assert.equal(decideRestore({ current: 'WPS Office', before: 'DeepSeek Harness', touched: ['wpsoffice'] }), 'restore');
});

test('宿主名大小写不同也算已还原（noop）', () => {
  assert.equal(decideRestore({ current: 'deepseek harness', before: 'DeepSeek Harness', touched: ['Notes'] }), 'noop');
});

test('用户切到无关应用：大小写不敏感也不能误伤', () => {
  assert.equal(decideRestore({ current: 'Google Chrome', before: 'DeepSeek Harness', touched: ['计算器', 'calculator'] }), 'leave-user');
  assert.equal(decideRestore({ current: 'Ghostty', before: 'DeepSeek Harness', touched: ['计算器', 'calculator'] }), 'leave-user');
});

test('前台读不到 / 不知道宿主：不动（noop）', () => {
  assert.equal(decideRestore({ current: '', before: 'DeepSeek Harness', touched: ['Calculator'] }), 'noop');
  assert.equal(decideRestore({ current: 'Notes', before: '', touched: ['Notes'] }), 'noop');
});

test('M-2 证据场景：touched 只有本地化名+英文小写，前台是进程名 Calculator', () => {
  // reports/app-matrix-2026-11-08T08-09-42-935Z.json：frontStart=DeepSeek Harness、frontEnd=Calculator
  const touchedAll = ['计算器', 'calculator', 'FastZip', 'cn.better365.FastZip'.split('.').pop()];
  assert.equal(decideRestore({ current: 'Calculator', before: 'DeepSeek Harness', touched: touchedAll }), 'restore');
});

test('normalizeFrontName：小写 + 去首尾空白 + 去分隔符', () => {
  assert.equal(normalizeFrontName('  Calculator '), 'calculator');
  assert.equal(normalizeFrontName('Clash Verge'), 'clashverge');
  assert.equal(normalizeFrontName('clash-verge'), 'clashverge');
  assert.equal(normalizeFrontName('WPS Office'), 'wpsoffice');
  assert.equal(normalizeFrontName(null), '');
});

// ---------- P1 边界：修复前双向包含会误伤的地方，现在必须 leave-user ----------

test('P1 边界：主应用与 Helper/子进程必须互不匹配', () => {
  // 用户正在用 Chrome，而矩阵只碰过 Chrome Helper：不能把用户的前台拽回宿主
  assert.equal(
    decideRestore({ current: 'Google Chrome', before: 'DeepSeek Harness', touched: ['Google Chrome Helper'] }),
    'leave-user',
  );
  // 反向同理：只碰过 Chrome 时，用户切到 Helper 也不抢
  assert.equal(
    decideRestore({ current: 'Google Chrome Helper', before: 'DeepSeek Harness', touched: ['Google Chrome'] }),
    'leave-user',
  );
});

test('P1 边界：短别名/前缀不得误伤同前缀应用', () => {
  assert.equal(decideRestore({ current: 'Notepad', before: 'DeepSeek Harness', touched: ['note'] }), 'leave-user');
  assert.equal(decideRestore({ current: 'Notes', before: 'DeepSeek Harness', touched: ['note'] }), 'leave-user');
  assert.equal(decideRestore({ current: 'Visual Studio Code Insiders', before: 'DeepSeek Harness', touched: ['Visual Studio Code'] }), 'leave-user');
});

// ---------- 边界：空输入 / 脏输入 ----------

test('touched 为空 / 为 null / 只有空白：一律 leave-user，不能因为「空串 includes 恒真」而抢前台', () => {
  assert.equal(decideRestore({ current: 'Calculator', before: 'DeepSeek Harness', touched: [] }), 'leave-user');
  assert.equal(decideRestore({ current: 'Calculator', before: 'DeepSeek Harness', touched: null }), 'leave-user');
  assert.equal(decideRestore({ current: 'Calculator', before: 'DeepSeek Harness', touched: ['', '   '] }), 'leave-user');
});

test('touched 里混入 null / 数字 / 空白：不崩，也不影响真实别名匹配', () => {
  assert.equal(
    decideRestore({ current: 'Calculator', before: 'DeepSeek Harness', touched: [null, 42, '  ', 'calculator'] }),
    'restore',
  );
  assert.equal(
    decideRestore({ current: 'Safari', before: 'DeepSeek Harness', touched: [null, 42, '  '] }),
    'leave-user',
  );
});

test('无参 / before 只有空白：不动（noop）', () => {
  assert.equal(decideRestore(), 'noop');
  assert.equal(decideRestore({}), 'noop');
  assert.equal(decideRestore({ current: 'Calculator', before: '   ' }), 'noop');
});

test('已在前台（归一化后相等）优先判 noop，即使 touched 里有别人', () => {
  assert.equal(decideRestore({ current: 'Calculator', before: 'Calculator', touched: ['Notes'] }), 'noop');
  assert.equal(decideRestore({ current: 'Calculator', before: 'calculator', touched: ['Notes'] }), 'noop');
});

// ---------- 别名形态：bundle 末段 / 分隔符 / 本地化名 ----------

test('bundle 末段作别名：calculator 能匹配 Calculator；整个 bundle 串不直接匹配', () => {
  assert.equal(decideRestore({ current: 'Calculator', before: 'DeepSeek Harness', touched: ['calculator'] }), 'restore');
  // 调用方（collectTouchedAliases）只取 bundle 末段；整串不归一化相等，不能算匹配
  assert.equal(
    decideRestore({ current: 'Calculator', before: 'DeepSeek Harness', touched: ['com.apple.calculator'] }),
    'leave-user',
    '整个 bundle 串不是别名，应由调用方拆出末段',
  );
});

test('分隔符不敏感：Visual Studio Code / iTerm 2 / WPS Office 各种写法按归一化后相等匹配', () => {
  assert.equal(decideRestore({ current: 'Visual Studio Code', before: 'DeepSeek Harness', touched: ['visualstudiocode'] }), 'restore');
  assert.equal(decideRestore({ current: 'Visual Studio Code', before: 'DeepSeek Harness', touched: ['visual-studio-code'] }), 'restore');
  assert.equal(decideRestore({ current: 'iTerm2', before: 'DeepSeek Harness', touched: ['iTerm 2'] }), 'restore');
  assert.equal(decideRestore({ current: 'WPS Office', before: 'DeepSeek Harness', touched: ['wps.office'] }), 'restore');
});

test('中文名与英文进程名互不认：必须靠 collectTouchedAliases 把两个名字都收进来', () => {
  // 单看中文名对不上（这是设计取舍：跨语言没法靠字符串相似度猜）
  assert.equal(decideRestore({ current: 'Calculator', before: 'DeepSeek Harness', touched: ['计算器'] }), 'leave-user');
  // 别名收集把进程名也带上之后就能还原
  assert.equal(
    decideRestore({ current: 'Calculator', before: 'DeepSeek Harness', touched: ['计算器', 'Calculator'] }),
    'restore',
  );
  // 反向：前台是本地化名，touched 里是中文名
  assert.equal(decideRestore({ current: '计算器', before: 'DeepSeek Harness', touched: ['计算器'] }), 'restore');
});
