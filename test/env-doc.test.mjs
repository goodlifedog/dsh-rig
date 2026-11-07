'use strict';
// 环境变量清单：代码里读到的都得能被列出来，默认值尽量带上。
import test from 'node:test';
import assert from 'node:assert/strict';
import { collectEnvVars, buildEnvDoc } from '../scripts/env-doc.mjs';

test('收集 process.env 用法，忽略系统变量', () => {
  const found = collectEnvVars([
    { file: 'a.mjs', source: 'const p = process.env.AGENTD_PORT || 7789; const h = process.env.HOME;' },
  ]);
  assert.ok(found.has('AGENTD_PORT'));
  assert.equal(found.has('HOME'), false);
  assert.deepEqual(Array.from(found.get('AGENTD_PORT').files), ['a.mjs']);
});

test('默认值字面量会被记下来', () => {
  const found = collectEnvVars([
    { file: 'a.mjs', source: "process.env.AGENTD_PORT || 7789; process.env.AGENT_SESSION || 'default';" },
  ]);
  assert.deepEqual(Array.from(found.get('AGENTD_PORT').defaults), ['7789']);
  assert.deepEqual(Array.from(found.get('AGENT_SESSION').defaults), ['default']);
});

test('布尔开关的默认值显示成人话', () => {
  const found = collectEnvVars([{ file: 'b.mjs', source: "process.env.ACCEPT_FORCE === '1'" }]);
  assert.match(Array.from(found.get('ACCEPT_FORCE').defaults)[0], /设 1 开启/);
});

test('文档按变量名排序，且带出现位置', () => {
  const doc = buildEnvDoc(collectEnvVars([
    { file: 'z.mjs', source: 'process.env.ZZZ_FLAG; process.env.AAA_FLAG;' },
  ]));
  assert.ok(doc.indexOf('`AAA_FLAG`') < doc.indexOf('`ZZZ_FLAG`'));
  assert.match(doc, /\.mjs/);
});
