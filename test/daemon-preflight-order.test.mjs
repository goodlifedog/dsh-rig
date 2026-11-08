'use strict';
// 复核 H1/H2/M1 的静态回归：daemon 的权限预检必须"先占位再 await"，/stop 要认预检阶段，
// 失败轮次的环境跳过要按 run-classify 归类。这些是并发/取消语义，抢窗口很难在单测里稳定复现，
// 所以用源码顺序断言 + 集成测试（daemon-integration）双重兜底。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = fs.readFileSync(path.join(HERE, '..', 'core', 'daemon.mjs'), 'utf8');

test('H1：预检前先占住 state.current（stage=preflight），否则并发 /run 会起两个任务', () => {
  const placeholderAt = SOURCE.indexOf("stage: 'preflight'");
  const gateAt = SOURCE.indexOf('await taskPermissionGate(');
  assert.ok(placeholderAt > 0, '找不到 stage=preflight 占位');
  assert.ok(gateAt > 0, '找不到权限预检调用');
  assert.ok(placeholderAt < gateAt, '占位必须出现在 await 预检之前（否则 drain 会以为空闲）');
});

test('H2：/stop 认「预检中（pid=null）」，返回 preflight-cancelled 并让 runTask 不再 spawn', () => {
  const stopAt = SOURCE.indexOf("inPreflight");
  assert.ok(stopAt > 0, '/stop 必须区分预检阶段');
  assert.match(SOURCE, /preflight-cancelled/);
  assert.match(SOURCE, /cancelled-before-spawn/);
  // runTask 在 await 预检之后、spawn 之前检查 cancelled
  const gateAt = SOURCE.indexOf('await taskPermissionGate(');
  const cancelCheckAt = SOURCE.indexOf('if (state.cancelled === true)', gateAt);
  const spawnAt = SOURCE.indexOf('const child = spawn(', gateAt);
  assert.ok(cancelCheckAt > gateAt && cancelCheckAt < spawnAt, 'cancelled 检查要在预检之后、spawn 之前');
});

test('M1：失败轮次也归类环境跳过（不再只在 ok 时跑 envSkipReason）', () => {
  assert.match(SOURCE, /const skipReason = cancelled \? '' : envSkipReason\(tail\);/);
});

test('M2：自检对「读不到权限状态」标 unknown，不假装已授权也不硬说缺失', () => {
  assert.match(SOURCE, /unknown: !permKnown|unknown: permUnknown/);
});

