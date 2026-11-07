'use strict';
// ocu MCP 启动失败必须是「可读的 rejection」，不是主进程未捕获异常
// （未处理 'error' 事件会让整个任务进程直接崩，任务日志里只剩一行看不懂的堆栈）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OcuMcp } from '../core/ocu-mcp.mjs';

test('ocu 可执行文件不存在：start 报可读错误并收尾', async () => {
  const client = new OcuMcp({ bin: '/nonexistent/ocu-does-not-exist' });
  await assert.rejects(() => client.start(), /无法启动|未启动/);
  assert.equal(client.closed, true);
  await client.close();
});

test('ocu 文件没有执行权限：同样是可读错误，不崩进程', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocu-mcp-'));
  const file = path.join(dir, 'ocu');
  // 不带 shebang 的二进制形态（带了会被当成 node 脚本执行，测不到 spawn 失败）
  fs.writeFileSync(file, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00, 0x01]), { mode: 0o644 });
  try {
    const client = new OcuMcp({ bin: file });
    await assert.rejects(() => client.start(), /无法启动|未启动/);
    assert.equal(client.closed, true);
    await client.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
