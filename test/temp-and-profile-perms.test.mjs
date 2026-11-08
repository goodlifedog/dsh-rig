'use strict';
// 评审 L1/L2：/tmp 临时文件不可预测 + profile/数据目录权限收紧
//   L1 core/agentd.mjs 的 writeCallsTempFile（不再用 /tmp/ocu-calls-<pid>.json）
//   L2 core/browser.mjs 的 ensurePrivateDir + core/local-token.cjs 的 hardenDataDir
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

import { writeCallsTempFile, removeCallsTempDir } from '../core/agentd.mjs';
import { ensurePrivateDir } from '../core/browser.mjs';

const require = createRequire(import.meta.url);
const cjs = require('../core/local-token.cjs');

function modeOf(p) { return fs.statSync(p).mode & 0o777; }
function mkTmp(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }

// ---------- L1：ocu calls-file ----------

test('L1：ocu calls 临时目录是 0700 私有目录，文件名不可预测，用完能整目录删掉', async () => {
  const list = [{ name: 'list_apps', args: {} }, { name: 'snapshot', args: { app: 'Finder' } }];
  const { dir, file } = await writeCallsTempFile(list);
  try {
    assert.ok(dir.startsWith(path.join(os.tmpdir(), 'ocu-calls-')), '目录前缀对');
    // mkdtemp 会带 6 位随机后缀：不能是旧的 /tmp/ocu-calls-<pid>.json 那种可预测路径
    const suffix = path.basename(dir).slice('ocu-calls-'.length);
    assert.ok(suffix.length >= 6, '目录名要有随机后缀（实际：' + path.basename(dir) + '）');
    assert.equal(modeOf(dir), 0o700, '临时目录必须 0700');
    assert.equal(modeOf(file), 0o600, 'calls 文件必须 0600');
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), list, '内容就是传进去的调用列表');
  } finally {
    await removeCallsTempDir(dir);
  }
  assert.equal(fs.existsSync(dir), false, 'removeCallsTempDir 要整目录删掉');
});

test('L1：预先在旧的可预测路径放符号链接，写调用文件也不会写穿到目标文件', async () => {
  const victimDir = mkTmp('victim-');
  const victim = path.join(victimDir, 'victim.cfg');
  fs.writeFileSync(victim, 'ORIGINAL');
  // 旧实现会写这个固定路径；其他用户可以在 /tmp 预置同名符号链接
  const predictable = path.join(os.tmpdir(), 'ocu-calls-' + process.pid + '.json');
  let createdLink = false;
  try {
    try {
      fs.symlinkSync(victim, predictable);
      createdLink = true;
    } catch {
      // 同名文件已存在（别的实例/残留）就跳过这条回归断言，避免误删别人的文件
    }
    const { dir, file } = await writeCallsTempFile([{ name: 'x' }]);
    try {
      assert.equal(fs.readFileSync(victim, 'utf8'), 'ORIGINAL', '目标文件不能被临时调用文件覆盖');
      assert.notEqual(file, predictable, '不能再往可预测路径写');
    } finally {
      await removeCallsTempDir(dir);
    }
  } finally {
    if (createdLink) { try { fs.unlinkSync(predictable); } catch {} }
    fs.rmSync(victimDir, { recursive: true, force: true });
  }
});

// ---------- L2：浏览器 profile / 数据目录权限 ----------

test('L2：ensurePrivateDir 新建目录是 0700，已存在的 755 目录也会被纠正', async () => {
  const root = mkTmp('prof-');
  try {
    const fresh = path.join(root, 'new-profile');
    await ensurePrivateDir(fresh);
    assert.equal(modeOf(fresh), 0o700, '新建 profile 必须 0700');

    const existing = path.join(root, 'old-profile');
    fs.mkdirSync(existing, { recursive: true, mode: 0o755 });
    fs.chmodSync(existing, 0o755);
    await ensurePrivateDir(existing);
    assert.equal(modeOf(existing), 0o700, '已存在的 755 目录也要 chmod 回 0700');

    // 多级自定义路径（AGENT_CHROME_PROFILE 可能指向任意层级）也能建出来
    const deep = path.join(root, 'a', 'b', 'custom-profile');
    await ensurePrivateDir(deep);
    assert.equal(modeOf(deep), 0o700);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('L2：hardenDataDir 遍历所有子目录（含白名单外的自定义 profile）统一 700', () => {
  const baseDir = mkTmp('harden-all-');
  try {
    const names = ['chrome-profile', 'headless-profile', 'concurrent-profile', 'my-custom-profile'];
    for (const name of names) {
      const p = path.join(baseDir, name);
      fs.mkdirSync(p, { recursive: true });
      fs.chmodSync(p, 0o755);
    }
    fs.writeFileSync(path.join(baseDir, 'api-token'), cjs.newToken(), { mode: 0o644 });
    fs.chmodSync(baseDir, 0o755);

    cjs.hardenDataDir(baseDir);

    assert.equal(modeOf(baseDir), 0o700, '数据根目录 700');
    for (const name of names) {
      assert.equal(modeOf(path.join(baseDir, name)), 0o700, name + ' 也要 700（不能只靠白名单）');
    }
    assert.equal(modeOf(path.join(baseDir, 'api-token')), 0o600, 'token 文件 600');
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

test('L2：hardenDataDir 不跟符号链接（不会 chmod 到目录外）', () => {
  const baseDir = mkTmp('harden-link-');
  const outside = mkTmp('outside-');
  try {
    fs.chmodSync(outside, 0o755);
    const link = path.join(baseDir, 'link-to-outside');
    try {
      fs.symlinkSync(outside, link);
    } catch {
      return; // 无法建符号链接的环境直接跳过（不影响其它断言）
    }
    fs.chmodSync(baseDir, 0o755);
    cjs.hardenDataDir(baseDir);
    assert.equal(modeOf(baseDir), 0o700);
    assert.equal(modeOf(outside), 0o755, '符号链接指向的外部目录不能被顺手改权限');
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});
