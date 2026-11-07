'use strict';
// 锁屏判定有两份实现（core 与 overlay），必须行为一致且能正确处理 ioreg 各种输出
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { parseScreenLocked as coreParse } from '../core/platform.mjs';

const require = createRequire(import.meta.url);
const { parseScreenLocked: overlayParse } = require('../overlay/platform.js');

const CASES = [
  { name: 'ioreg 文本格式 Yes', input: '    "CGSSessionScreenIsLocked" = Yes\n', locked: true },
  { name: 'ioreg 文本格式 No', input: '    "CGSSessionScreenIsLocked" = No\n', locked: false },
  { name: 'plist 格式 true', input: '<key>CGSSessionScreenIsLocked</key>\n<true/>', locked: true },
  { name: 'plist 格式 false', input: '<key>CGSSessionScreenIsLocked</key>\n<false/>', locked: false },
  { name: '小写 yes', input: '"CGSSessionScreenIsLocked" = yes', locked: true },
  { name: '数字 1', input: '"CGSSessionScreenIsLocked" = 1', locked: true },
  { name: '数字 0', input: '"CGSSessionScreenIsLocked" = 0', locked: false },
  { name: '键不存在（未锁屏）', input: 'nothing here', locked: false },
  { name: '空输出', input: '', locked: false },
  { name: 'null', input: null, locked: false },
];

for (const c of CASES) {
  test('core 解析：' + c.name, () => {
    assert.equal(coreParse(c.input), c.locked);
  });
  test('overlay 解析：' + c.name, () => {
    assert.equal(overlayParse(c.input), c.locked);
  });
  test('两层一致：' + c.name, () => {
    assert.equal(coreParse(c.input), overlayParse(c.input));
  });
}
