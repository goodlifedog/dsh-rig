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

// ---------- M-1：本项目 Chrome 残留（带无鉴权 CDP 端口）也要纳入孤儿清理 ----------

import { isProjectChrome, findOrphanedChromes, findOrphans, userDataDirOf } from '../core/orphan-cleanup.mjs';

const PROFILE_ROOT = '/Users/tester/.desktop-agent';
const CHROME_BIN = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const chromeCmd = (dir, extra = '--remote-debugging-port=0') =>
  CHROME_BIN + ' ' + extra + ' --user-data-dir=' + dir + ' --no-first-run';

test('isProjectChrome：本项目 profile + 调试端口 → 命中', () => {
  assert.equal(isProjectChrome(chromeCmd(PROFILE_ROOT + '/chrome-profile'), { profileRoot: PROFILE_ROOT }), true);
  assert.equal(isProjectChrome(chromeCmd(PROFILE_ROOT), { profileRoot: PROFILE_ROOT }), true);
  // 带引号的写法（Chrome 自己包参数时会这样）
  assert.equal(isProjectChrome(CHROME_BIN + ' --remote-debugging-port=9222 --user-data-dir="' + PROFILE_ROOT + '/chrome-profile"', { profileRoot: PROFILE_ROOT }), true);
});

test('isProjectChrome：没开调试端口 / profile 不在本项目下 / 不是 Chrome 本体 → 都不碰', () => {
  // 没调试端口：没有 CDP 暴露面，不归这条规则管
  assert.equal(isProjectChrome(chromeCmd(PROFILE_ROOT + '/chrome-profile', '--no-sandbox'), { profileRoot: PROFILE_ROOT }), false);
  // 别人的 profile（实测本机就有 chrome-devtools-mcp 自己的）
  assert.equal(isProjectChrome(chromeCmd('/Users/tester/.cache/chrome-devtools-mcp/chrome-profile'), { profileRoot: PROFILE_ROOT }), false);
  // 用户自己日常的 Chrome：没有 --user-data-dir，默认 profile 不在 ~/.desktop-agent 下
  assert.equal(isProjectChrome(CHROME_BIN + ' --restart', { profileRoot: PROFILE_ROOT }), false);
  // Helper/renderer 子进程不是本体
  assert.equal(isProjectChrome('/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Helpers/Google Chrome Helper (Renderer).app/Contents/MacOS/Google Chrome Helper (Renderer) --remote-debugging-port=0 --user-data-dir=' + PROFILE_ROOT + '/chrome-profile', { profileRoot: PROFILE_ROOT }), false);
  // 前缀相近但不是同一层目录
  assert.equal(isProjectChrome(chromeCmd(PROFILE_ROOT + '-backup/chrome-profile'), { profileRoot: PROFILE_ROOT }), false);
  assert.equal(isProjectChrome('', { profileRoot: PROFILE_ROOT }), false);
});

test('userDataDirOf：带引号/不带引号都能取到', () => {
  assert.equal(userDataDirOf('x --user-data-dir=/tmp/a/b'), '/tmp/a/b');
  assert.equal(userDataDirOf('x --user-data-dir="/tmp/a b"'), '/tmp/a b');
  assert.equal(userDataDirOf('x --user-data-dir=/tmp/a/b/'), '/tmp/a/b');
  assert.equal(userDataDirOf('no args here'), '');
});

test('findOrphanedChromes：只清 ppid=1、当前用户、非自己的残留 Chrome', () => {
  const cmd = chromeCmd(PROFILE_ROOT + '/chrome-profile');
  const rows = [
    { pid: 300, ppid: 1, user: 'tester', command: cmd },                  // 孤儿 → 清
    { pid: 301, ppid: 490, user: 'tester', command: cmd },                // 还有父进程 → 不动
    { pid: 302, ppid: 1, user: 'someone', command: cmd },                 // 别人 → 不动
    { pid: 303, ppid: 1, user: 'tester', command: cmd },                  // 自己 → 不动
    { pid: 304, ppid: 1, user: 'tester', command: 'node core/daemon.mjs' }, // 无关 → 不动
    { pid: 305, ppid: 1, user: 'tester', command: chromeCmd('/Users/tester/.cache/chrome-devtools-mcp/chrome-profile') }, // 别人的 profile → 不动
  ];
  assert.deepEqual(findOrphanedChromes(rows, { user: 'tester', selfPid: 303, profileRoot: PROFILE_ROOT }), [300]);
});

test('findOrphans：ocu 与残留 Chrome 合并去重', () => {
  const rows = [
    { pid: 400, ppid: 1, user: 'tester', command: '/x/OpenComputerUse' },
    { pid: 401, ppid: 1, user: 'tester', command: chromeCmd(PROFILE_ROOT + '/chrome-profile') },
    { pid: 401, ppid: 1, user: 'tester', command: chromeCmd(PROFILE_ROOT + '/chrome-profile') }, // 重复行
  ];
  assert.deepEqual(findOrphans(rows, { user: 'tester', profileRoot: PROFILE_ROOT }), [400, 401]);
});
