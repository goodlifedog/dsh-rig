'use strict';
// 真实并发测试：两个独立进程在同一时刻（用屏障对齐）抢同一把锁，只有一个能成功。
// 同进程里顺序调用两次验不到 link(2) 的 EEXIST 原子性，所以这里真的起两个进程。
//
// 注意：拿到锁的那个子进程必须先停一会儿再退出。否则「抢到就退出」的窗口里，
// 另一个进程重试时会把已退出的持有者判成死锁并回收——那是正确行为，但会让这个测试偶发失败。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOCK_MODULE = path.join(HERE, '..', 'core', 'acceptance-lock.mjs');
const HOLD_MS = 1200;

function childScript() {
  return [
    'import { acquireLock } from ' + JSON.stringify('file://' + LOCK_MODULE) + ';',
    'const file = process.argv[1];',
    'const startAt = Number(process.argv[2]);',
    'const holdMs = Number(process.argv[3]);',
    // 屏障：两个子进程都等到同一个时间点再抢，避免被进程启动先后顺序决定结果
    'while (Date.now() < startAt) {}',
    'const r = acquireLock(file);',
    'console.log(JSON.stringify({ ok: r.ok === true, reason: r.reason || null, pid: process.pid }));',
    // 拿到锁的继续占住，别让另一个进程把它当残留回收掉
    'setTimeout(() => {}, holdMs);',
  ].join('\n');
}

function runChild(file, startAt) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', childScript(), file, String(startAt), String(HOLD_MS)], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err += c; });
    child.on('close', () => {
      try { resolve(JSON.parse(out.trim().split('\n').pop())); } catch { resolve({ ok: null, raw: out + err }); }
    });
  });
}

test('真实并发：两个进程在同一时刻抢锁，恰好一个成功', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lock-race-'));
  const file = path.join(dir, 'lock');
  try {
    const startAt = Date.now() + 400; // 给两个进程留出启动时间，再一起动手
    const [a, b] = await Promise.all([runChild(file, startAt), runChild(file, startAt)]);
    const winners = [a, b].filter((r) => r && r.ok === true);
    assert.equal(winners.length, 1, '应恰好一个进程拿到锁，实际：' + JSON.stringify([a, b]));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('真实并发：抢输的进程不会删掉赢家的锁', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lock-race-'));
  const file = path.join(dir, 'lock');
  try {
    const startAt = Date.now() + 400;
    const [a, b] = await Promise.all([runChild(file, startAt), runChild(file, startAt)]);
    const winners = [a, b].filter((r) => r && r.ok === true);
    assert.equal(winners.length, 1);
    // 两个子进程都已退出：锁文件还在，内容和赢家的 pid 一致——抢输的进程没把它删掉或接管
    assert.equal(fs.existsSync(file), true, '赢家写的锁不该被抢输的进程删掉');
    assert.equal(Number(String(fs.readFileSync(file, 'utf8')).trim().split(' ')[0]), winners[0].pid);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
