'use strict';
// 「操作中被应用抢到前台」是用户最在意的切屏问题：
// guard 检测到之后必须先把前台还给操作前的应用，再报错，不能把被抢的应用留在前台。
import test from 'node:test';
import assert from 'node:assert/strict';
import { guard, restoreFrontTo } from '../core/agentd.mjs';

function deps(seq, calls, noted) {
  return {
    frontmost: async () => seq.shift(),
    restoreFront: async (name) => { calls.push(name); return true; },
    log: async (text) => { calls.push('log:' + text); },
    noteRisk: (app) => { if (noted) noted.push(app); },
  };
}

test('目标被激活：先还原前台到操作前的应用，再抛错', async () => {
  const calls = [];
  const noted = [];
  const d = deps(['DeepSeek Harness', 'Google Chrome'], calls, noted);
  await assert.rejects(
    () => guard('Google Chrome', async () => 'ok', { label: '写入', deps: d }),
    /前台发生了变化.*已把前台还原到 DeepSeek Harness/,
  );
  assert.deepEqual(calls[0], 'DeepSeek Harness', '必须先调 restoreFront');
  assert.ok(calls.some((c) => typeof c === 'string' && c.startsWith('log:警告')), '要记一条警告日志');
  assert.deepEqual(noted, ['Google Chrome'], '被激活的应用要记进前台风险名单');
});

test('还原失败也要带上说明，不假装成功', async () => {
  const d = {
    frontmost: (() => { const s = ['DeepSeek Harness', 'Gemini']; return async () => s.shift(); })(),
    restoreFront: async () => false,
    log: async () => {},
    noteRisk: () => {},
  };
  await assert.rejects(() => guard('Gemini', async () => 'x', { deps: d }), /前台还原失败/);
});

test('前台没变：不调用还原，正常返回', async () => {
  const calls = [];
  const d = deps(['DeepSeek Harness', 'DeepSeek Harness'], calls);
  const r = await guard('备忘录', async () => 42, { label: '读取', deps: d });
  assert.equal(r.result, 42);
  assert.equal(r.before, 'DeepSeek Harness');
  assert.deepEqual(calls, ['log:读取（前台始终：DeepSeek Harness）'], '没被抢就不该记风险也不该还原');
});

test('目标本来就是前台：直接拒绝，不执行动作', async () => {
  let ran = 0;
  const d = deps(['Chrome'], []);
  await assert.rejects(() => guard('Chrome', async () => { ran += 1; }, { deps: d }), /当前就是前台/);
  assert.equal(ran, 0);
});

test('还原目标名字不可信时不执行 osascript（防注入）', async () => {
  assert.equal(await restoreFrontTo('a"b'), false);
  assert.equal(await restoreFrontTo('a\\b'), false);
  assert.equal(await restoreFrontTo('a\nb'), false);
  assert.equal(await restoreFrontTo(''), false);
  assert.equal(await restoreFrontTo('(unknown)'), false);
});