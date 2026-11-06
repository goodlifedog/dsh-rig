'use strict';
/**
 * 拟人输入的真机实测（默认跳过，避免 npm test 去碰用户窗口）。
 *
 *   HUMANIZE_LIVE=1 npm test -- --test-name-pattern='TextEdit'
 *   或： HUMANIZE_LIVE=1 node --test test/humanize-live.test.mjs
 *
 * 做的事：
 *   1. 读 TextEdit 当前文本（原文）；
 *   2. 用 core/user-chrome.mjs 的 typeText 在后台敲一段中文（带随机停顿 + 5%→40% 打错字再退格纠正）；
 *   3. 读回 AX 文本，确认和「基线 + 原文句子」完全一致（说明纠错闭环成立）；
 *   4. 用 clickAt 在文本区里点一下，验证「轨迹 + 落点」这条路在真实应用里能走通；
 *   5. 全程比对 ocu list-apps 首行，确认前台应用没变；
 *   6. 无论成败都把 TextEdit 原文写回去。
 *
 * 注意：会短暂写入用户 TextEdit 里那个「未命名」文档，结束后用 AX set_value 精确还原。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { getOcuMcp, closeOcuMcp } from '../core/ocu-mcp.mjs';
import { typeText, clickAt, clickElement, readState, frontAppName } from '../core/user-chrome.mjs';
import { buildTrajectory, playTrajectory, makeRng } from '../core/humanize.mjs';

const LIVE = process.env.HUMANIZE_LIVE === '1';
const APP = process.env.HUMANIZE_APP || 'TextEdit';
const BASE = '拟人输入实测基线：';
const SENTENCE = '后台输入中文，全程不切前台，节奏带停顿与纠错。';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function textValue(stateText) {
  const mm = (stateText || '').match(/文本输入区.*?Value: ([\s\S]*?)(?=\n\t|\nThe focused)/);
  return mm ? mm[1] : null;
}

test('TextEdit 后台中文输入：写入成功、前台不变、节奏可测', {
  skip: LIVE ? false : '设置 HUMANIZE_LIVE=1 才会真打字（会短暂写入 TextEdit 并自动还原）',
  timeout: 240000,
}, async () => {
  const m = await getOcuMcp();
  const front = async () => ((await m.callTool('list_apps', {})).text || '').split('\n')[0];
  const valueNow = async () => textValue((await readState({ app: APP, maxNodes: 600, textLimit: 60 })).text);
  const setValue = async (v) => {
    await readState({ app: APP, maxNodes: 600, textLimit: 60 });
    await m.callTool('set_value', { app: APP, element_index: '2', value: v });
  };

  const frontBefore = await front();
  const original = await valueNow();
  assert.ok(original !== null, '读不到 TextEdit 文本内容，检查 TextEdit 是否开着文档');
  const evidence = { frontBefore, originalLen: original.length, sentence: SENTENCE };

  try {
    // --- 1. 拟人输入 ---
    await setValue(BASE);
    await sleep(300);
    assert.equal(await valueNow(), BASE, '基线写入失败');

    const rng = makeRng(2026);
    const t0 = Date.now();
    const typed = await typeText(SENTENCE, {
      app: APP,
      rng,
      typoChance: 0.4,       // 放大到 40% 以便这次实测一定覆盖纠错路径
      minDelay: 50,
      maxDelay: 150,
      pauseChance: 0.2,
      pauseMs: [180, 420],
    });
    const typedMs = Date.now() - t0;
    await sleep(250);
    const afterTyping = await valueNow();

    evidence.typing = {
      chars: typed.chars,
      chunks: typed.chunks,
      typos: typed.typos,
      elapsedMs: typed.elapsedMs,
      measuredMs: typedMs,
      msPerChar: Math.round((typedMs / typed.chars) * 10) / 10,
      resultLen: afterTyping ? afterTyping.length : null,
      expectLen: (BASE + SENTENCE).length,
    };
    assert.equal(afterTyping, BASE + SENTENCE, '输入内容与预期不一致（可能纠错没对齐）');

    // --- 2. 轨迹规划（同一套 planner，真实参数：400px 横移） ---
    const planned = buildTrajectory({ x: 120, y: 640 }, { x: 520, y: 500 }, { rng: makeRng(2026) });
    const waits = [];
    const played = await playTrajectory(planned, { sleepFn: async (ms) => { waits.push(Math.round(ms)); await sleep(ms); } });
    evidence.trajectory = {
      steps: played.steps,
      waitedMs: played.waitedMs,
      movedPx: played.movedPx,
      elapsedMs: played.elapsedMs,
      stepMs: { min: Math.min(...waits), max: Math.max(...waits), mid: waits[Math.floor(waits.length / 2)] },
      landing: played.end,
    };
    assert.ok(played.steps >= 6, '轨迹步数太少');
    assert.ok(played.waitedMs > 50, '轨迹没有真实等待');
    assert.deepEqual(played.end, { x: 520, y: 500 }, '轨迹末点不精确');

    // --- 3. 坐标点击政策：对用户 App 必须被拒绝（因为要截图、会置前） ---
    const refused = await clickAt(40, 140, { app: APP, rng: makeRng(99) });
    evidence.coordinateClick = {
      ok: refused.ok,
      disallowed: Boolean(refused.disallowed),
      error: refused.error || null,
    };
    assert.equal(refused.ok, false, '坐标点击本应被政策拒绝（禁止对用户 App 截图）');
    assert.equal(refused.disallowed, true, '坐标点击没有返回 disallowed 标记');

    // --- 4. element_index + accessibility 点击：不截图，走语义点击 ---
    const before = await valueNow();
    const q = await m.callTool('query', { app: APP, role: 'textarea', limit: 2, max_nodes: 1200 });
    const hit = (q.json && q.json.matches && q.json.matches[0]) || null;
    assert.ok(hit && hit.index != null, '没找到 TextEdit 文本区元素索引');
    const el = await clickElement(hit.index, { app: APP, rng: makeRng(7) });          // query 之后立刻点，索引不跨调用复用
    await sleep(250);
    const afterClick = await valueNow();
    evidence.elementClick = {
      index: String(hit.index),
      method: el.method,
      ok: el.ok,
      error: el.ok ? null : String(el.text || '').slice(0, 120),
      valueChanged: before !== afterClick,
      note: 'TextEdit 非前台时忽略后台点击；这里只验证 AX 语义点击不需要截图、不置前',
    };
    assert.equal(el.method, 'accessibility');

    // --- 5. 可点的元素：文本框没有 AXPress，但复选框有；点两下恢复原状，证明 element 点击真生效 ---
    const q2 = await m.callTool('query', { app: APP, role: 'checkbox', limit: 6, max_nodes: 1200 });
    const box = (q2.json && q2.json.matches && q2.json.matches[0]) || null;
    assert.ok(box && box.index != null, '没找到可点的复选框');
    const c1 = await clickElement(box.index, { app: APP, human: false });
    const c2 = await clickElement(box.index, { app: APP, human: false });
    evidence.checkboxClick = { index: String(box.index), firstOk: c1.ok, secondOk: c2.ok, note: '同一控件点两次，第一次切换、第二次恢复' };
    assert.equal(c1.ok, true, '复选框 element 点击失败: ' + String(c1.text || '').slice(0, 80));
    assert.equal(c2.ok, true, '复选框恢复点击失败');

    // --- 4. 前台全程不变 ---
    const frontAfter = await front();
    evidence.frontAfter = frontAfter;
    evidence.frontUnchanged = frontAppName(frontBefore) === frontAppName(frontAfter);
    assert.ok(evidence.frontUnchanged, '前台应用变了：' + frontBefore + ' → ' + frontAfter);
  } finally {
    await setValue(original);
    await sleep(300);
    const restored = await valueNow();
    evidence.restored = restored === original;
    await closeOcuMcp();
    console.log('\n[humanize-live 证据]\n' + JSON.stringify(evidence, null, 2) + '\n');
    assert.equal(restored, original, 'TextEdit 原文没有还原');
  }
});
