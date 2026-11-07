'use strict';
// 部署守卫：端口监听者身份 / launchd 漂移，防"改了代码但跑的还是旧进程"
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseListenerPid,
  isOurDaemonCommand,
  diagnoseListener,
  parseLaunchdPid,
  deploymentDrift,
} from '../core/service-guard.mjs';

test('解析 lsof -t 的 pid', () => {
  assert.equal(parseListenerPid('40329\n'), 40329);
  assert.equal(parseListenerPid('\n\n123\n456'), 123);
  assert.equal(parseListenerPid(''), 0);
  assert.equal(parseListenerPid('not-a-pid'), 0);
});

test('只认本项目的 daemon 命令行，别的一概不当自己人', () => {
  const root = '/repo/desktop-agent';
  assert.equal(isOurDaemonCommand(root + '/core/daemon.mjs', { rootDir: root }), true);
  assert.equal(isOurDaemonCommand('/usr/local/bin/node /x/desktop-agent/core/daemon.mjs'), true);
  assert.equal(isOurDaemonCommand('/usr/bin/python3 -m http.server 7789'), false);
  assert.equal(isOurDaemonCommand('/Applications/Foo.app/Contents/MacOS/Foo'), false);
  assert.equal(isOurDaemonCommand('', { rootDir: root }), false);
});

test('监听者诊断：没监听 / 自己人 / 外人', () => {
  const root = '/repo/desktop-agent';
  assert.equal(diagnoseListener({ listenerPid: 0 }), 'no-listener');
  assert.equal(diagnoseListener({ listenerPid: 100, listenerCommand: root + '/core/daemon.mjs', rootDir: root }), 'ok');
  assert.equal(diagnoseListener({ listenerPid: 100, listenerCommand: '/usr/bin/python3 -m http.server', rootDir: root }), 'foreign-process');
});

test('解析 launchctl print 里的 pid', () => {
  assert.equal(parseLaunchdPid('state = running\n\tpid = 49698\n\tpath = /x'), 49698);
  assert.equal(parseLaunchdPid('pid = 0'), 0);
  assert.equal(parseLaunchdPid(''), 0);
});

test('部署漂移：监听者与受管进程不一致就是 stray', () => {
  assert.equal(deploymentDrift({ listenerPid: 49698, managedPid: 49698 }), 'ok');
  assert.equal(deploymentDrift({ listenerPid: 40329, managedPid: 49698 }), 'stray');
  assert.equal(deploymentDrift({ listenerPid: 0, managedPid: 49698 }), 'no-listener');
  assert.equal(deploymentDrift({ listenerPid: 40329, managedPid: 0 }), 'no-managed');
});
