'use strict';
// 孤儿进程清理：只清"父进程已死的本用户依赖进程"，别的都不许碰
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseProcessTable, findOrphanedAgents, DEFAULT_AGENT_PATTERN } from '../core/orphan-cleanup.mjs';

test('解析 ps 表', () => {
  const rows = parseProcessTable('34619 1 tester /x/OpenComputerUse\nabc 2 3\n\n48216 490 tester node /y/ocu');
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { pid: 34619, ppid: 1, user: 'tester', command: '/x/OpenComputerUse' });
  assert.equal(rows[1].pid, 48216);
});

test('只清 ppid=1 的孤儿', () => {
  const rows = [
    { pid: 10, ppid: 1, user: 'tester', command: '/x/OpenComputerUse' },
    { pid: 11, ppid: 490, user: 'tester', command: '/x/OpenComputerUse' },
  ];
  assert.deepEqual(findOrphanedAgents(rows, { user: 'tester' }), [10]);
});

test('别人的进程、自己的进程、无关进程都不清', () => {
  const rows = [
    { pid: 20, ppid: 1, user: 'someone', command: '/x/OpenComputerUse' },
    { pid: 21, ppid: 1, user: 'tester', command: '/Applications/Safari.app/Contents/MacOS/Safari' },
    { pid: 22, ppid: 1, user: 'tester', command: '/x/OpenComputerUse' },
  ];
  assert.deepEqual(findOrphanedAgents(rows, { user: 'tester', selfPid: 22 }), []);
});

test('命令特征覆盖 ocu / Open Computer Use', () => {
  assert.ok(DEFAULT_AGENT_PATTERN.test('/Applications/Open Computer Use.app/Contents/MacOS/OpenComputerUse'));
  assert.ok(DEFAULT_AGENT_PATTERN.test('node /x/node_modules/open-computer-use/ocu'));
  assert.ok(!DEFAULT_AGENT_PATTERN.test('node core/daemon.mjs'));
  assert.ok(!DEFAULT_AGENT_PATTERN.test('/usr/bin/python3 -m http.server'));
});
