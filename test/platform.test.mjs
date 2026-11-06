'use strict';
import test from 'node:test';
import assert from 'node:assert/strict';
import { platform, isMac, isWindows, controlBackend, dataDir } from '../core/platform.mjs';

test('平台标识正确', () => {
  assert.equal(platform, process.platform);
  assert.equal(isMac, process.platform === 'darwin');
  assert.equal(isWindows, process.platform === 'win32');
});

test('控制后端按平台选择', () => {
  const b = controlBackend();
  assert.ok(['ocu', 'uia', 'unsupported'].includes(b));
  if (isMac) assert.equal(b, 'ocu');
  if (isWindows) assert.equal(b, 'uia');
});

test('数据目录随平台变化', () => {
  const dir = dataDir('smoke');
  assert.ok(dir.endsWith('smoke'));
  assert.ok(dir.includes('desktop-agent'));
});
