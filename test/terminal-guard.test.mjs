'use strict';
// 终端写入判定：绝不能把 echo 拼到用户没写完的命令上（回车会提前执行）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { decideTerminalType, lastNonEmptyLine, looksLikeEmptyPrompt } from '../core/terminal-guard.mjs';

test('最后一行取非空行，并去掉行尾空白', () => {
  assert.equal(lastNonEmptyLine('a\nb\n\n  '), 'b');
  assert.equal(lastNonEmptyLine(''), '');
  assert.equal(lastNonEmptyLine('单行  '), '单行');
});

test('空提示符识别：常见 shell 结尾符号', () => {
  for (const line of ['tester@Mac ~ %', 'user@host:~$', 'root@host:/#', '~/proj ❯', '➜  myrepo git:(main)']) {
    assert.equal(looksLikeEmptyPrompt(line), true, line);
  }
});

test('已有半截命令 → 不像空提示符', () => {
  for (const line of ['% rm -rf build', '$ git commit -m "wip"', '❯ npm run build', '']) {
    assert.equal(looksLikeEmptyPrompt(line), false, line);
  }
});

test('正常情况（不在前台、键鼠空闲、空提示符）→ 允许敲', () => {
  const r = decideTerminalType({ app: 'Ghostty', frontApp: 'DeepSeek Harness', hidIdleMs: 600_000, lastLine: 'tester@Mac ~ %' });
  assert.equal(r.ok, true);
});

test('终端就在前台（用户正在里面操作）→ 跳过', () => {
  const r = decideTerminalType({ app: 'Ghostty', frontApp: 'Ghostty', hidIdleMs: 600_000, lastLine: '%' });
  assert.equal(r.ok, false);
  assert.match(r.reason, /就是前台/);
});

test('键鼠刚动过 → 跳过（可能正在打字）', () => {
  const r = decideTerminalType({ app: 'Ghostty', frontApp: 'DeepSeek Harness', hidIdleMs: 300, lastLine: '%' });
  assert.equal(r.ok, false);
  assert.match(r.reason, /刚动过/);
});

test('读不到缓冲区 → 跳过（无法确认没有半截命令）', () => {
  const r = decideTerminalType({ app: 'Ghostty', frontApp: 'DeepSeek Harness', hidIdleMs: 600_000, lastLine: '' });
  assert.equal(r.ok, false);
  assert.match(r.reason, /读不到终端缓冲区/);
});

test('最后一行是半截命令 → 跳过，并在原因里带上下文', () => {
  const r = decideTerminalType({ app: 'Ghostty', frontApp: 'DeepSeek Harness', hidIdleMs: 600_000, lastLine: '% rm -rf build' });
  assert.equal(r.ok, false);
  assert.match(r.reason, /半截命令/);
  assert.match(r.reason, /rm -rf build/);
});

test('风险名单里的终端 → 直接不碰', () => {
  const r = decideTerminalType({ app: 'Ghostty', riskSkip: true });
  assert.equal(r.ok, false);
  assert.match(r.reason, /风险名单/);
});
