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

import {
  isProjectChrome,
  findOrphanedChromes,
  findOrphans,
  userDataDirOf,
  readSingletonLockPid,
  chromeProfileInUse,
} from '../core/orphan-cleanup.mjs';

// 单测不碰真实文件系统：默认注入「没有 SingletonLock」（否则会去看本机真实 profile 目录）
const noLock = () => { throw Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' }); };

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
  assert.deepEqual(findOrphanedChromes(rows, { user: 'tester', selfPid: 303, profileRoot: PROFILE_ROOT, readlink: noLock }), [300]);
});

test('findOrphans：ocu 与残留 Chrome 合并去重', () => {
  const rows = [
    { pid: 400, ppid: 1, user: 'tester', command: '/x/OpenComputerUse' },
    { pid: 401, ppid: 1, user: 'tester', command: chromeCmd(PROFILE_ROOT + '/chrome-profile') },
    { pid: 401, ppid: 1, user: 'tester', command: chromeCmd(PROFILE_ROOT + '/chrome-profile') }, // 重复行
  ];
  assert.deepEqual(findOrphans(rows, { user: 'tester', profileRoot: PROFILE_ROOT, readlink: noLock }), [400, 401]);
});

// ---------- M-1b：SingletonLock 活跃实例守卫（别把别的会话正在用的离屏 Chrome 清掉） ----------
// open -g 拉起的 Chrome ppid 天然=1，所以只能靠 profile 目录里的 SingletonLock 判断真实占用。

const liveLock = (pid) => () => 'Test-MacBook-Pro.local-' + pid;

test('readSingletonLockPid：解析 <hostname>-<pid>，主机名带 "-" 也只取末尾数字', () => {
  assert.equal(readSingletonLockPid('/prof', { readlink: liveLock(48213) }), 48213);
  assert.equal(readSingletonLockPid('/prof', { readlink: noLock }), 0, '没有锁文件 → 0');
  assert.equal(readSingletonLockPid('/prof', { readlink: () => 'no-pid-here' }), 0, '解析不出 pid → 0');
  assert.equal(readSingletonLockPid('/prof', { readlink: () => '' }), 0);
  assert.equal(readSingletonLockPid('', { readlink: liveLock(1) }), 0, '没有 dir → 0');
});

test('readSingletonLockPid：Windows 风格/相对链接等解析失败一律按「没有活跃实例」处理且不抛', () => {
  for (const target of ['C:\\Users\\tester\\AppData\\Local\\Chrome', 'host-', '-0', 'host-abc', '../somewhere']) {
    assert.equal(readSingletonLockPid('/prof', { readlink: () => target }), 0, target + ' 应当解析为 0');
  }
});

test('chromeProfileInUse：锁里的 pid 活着才算占用，死了不算', () => {
  const dir = PROFILE_ROOT + '/chrome-profile';
  assert.equal(chromeProfileInUse(dir, { readlink: liveLock(4242), isAlive: (p) => p === 4242 }), 4242);
  assert.equal(chromeProfileInUse(dir, { readlink: liveLock(4242), isAlive: () => false }), 0);
  assert.equal(chromeProfileInUse(dir, { readlink: noLock, isAlive: () => true }), 0);
});

test('活跃实例守卫：SingletonLock 指向活着的 pid → 跳过，不杀', () => {
  const dir = PROFILE_ROOT + '/chrome-profile';
  const rows = [{ pid: 500, ppid: 1, user: 'tester', command: chromeCmd(dir) }];
  const killed = findOrphanedChromes(rows, {
    user: 'tester', profileRoot: PROFILE_ROOT,
    readlink: liveLock(4242), isAlive: (p) => p === 4242,
  });
  assert.deepEqual(killed, [], '另一个会话正在用的离屏 Chrome 绝对不能清');
});

test('活跃实例守卫：锁里的 pid 已死 → 仍按孤儿清理（不留未鉴权的 CDP 端口）', () => {
  const dir = PROFILE_ROOT + '/chrome-profile';
  const rows = [{ pid: 501, ppid: 1, user: 'tester', command: chromeCmd(dir) }];
  const killed = findOrphanedChromes(rows, {
    user: 'tester', profileRoot: PROFILE_ROOT,
    readlink: liveLock(4242), isAlive: () => false,   // 进程早没了，只剩陈旧的锁
  });
  assert.deepEqual(killed, [501]);
});

test('活跃实例守卫：没有锁文件 / 解析失败 → 按孤儿清理且不抛', () => {
  const dir = PROFILE_ROOT + '/chrome-profile';
  const rows = [{ pid: 502, ppid: 1, user: 'tester', command: chromeCmd(dir) }];
  for (const readlink of [noLock, () => 'garbage', () => { throw new Error('EACCES'); }]) {
    assert.deepEqual(
      findOrphanedChromes(rows, { user: 'tester', profileRoot: PROFILE_ROOT, readlink, isAlive: () => true }),
      [502],
    );
  }
});

test('活跃实例守卫：guardActive=false 可强制全清（排障用）', () => {
  const dir = PROFILE_ROOT + '/chrome-profile';
  const rows = [{ pid: 503, ppid: 1, user: 'tester', command: chromeCmd(dir) }];
  assert.deepEqual(
    findOrphanedChromes(rows, {
      user: 'tester', profileRoot: PROFILE_ROOT, guardActive: false,
      readlink: liveLock(4242), isAlive: () => true,
    }),
    [503],
  );
});

test('活跃实例守卫：只保护活跃 profile，另一个 profile 的残留照样清', () => {
  const busy = PROFILE_ROOT + '/chrome-profile';
  const stale = PROFILE_ROOT + '/chrome-profile-2';
  const rows = [
    { pid: 510, ppid: 1, user: 'tester', command: chromeCmd(busy) },
    { pid: 511, ppid: 1, user: 'tester', command: chromeCmd(stale) },
  ];
  const killed = findOrphanedChromes(rows, {
    user: 'tester', profileRoot: PROFILE_ROOT,
    readlink: (p) => {
      if (p === busy + '/SingletonLock') return 'host-4242';
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    },
    isAlive: (p) => p === 4242,
  });
  assert.deepEqual(killed, [511], '活跃的那个跳过，另一个照清');
});

test('活跃实例守卫：findOrphans 合并时同样生效', () => {
  const dir = PROFILE_ROOT + '/chrome-profile';
  const rows = [
    { pid: 520, ppid: 1, user: 'tester', command: '/x/OpenComputerUse' },
    { pid: 521, ppid: 1, user: 'tester', command: chromeCmd(dir) },
  ];
  assert.deepEqual(
    findOrphans(rows, {
      user: 'tester', profileRoot: PROFILE_ROOT,
      readlink: liveLock(4242), isAlive: (p) => p === 4242,
    }),
    [520],
    'ocu 孤儿照清；活跃的离屏 Chrome 保留',
  );
});
