'use strict';
// form-fill 的页面脚本安全边界：中途异常也必须把用户输入框恢复原值，
// 而且模板拼接后必须是合法 JS（这类字符串脚本最容易拼坏而运行期才暴露）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildFill, buildRestore } from '../core/tasks/form-fill.mjs';

function checkSyntax(source, name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'formfill-'));
  try {
    const file = path.join(dir, name + '.mjs');
    fs.writeFileSync(file, source);
    assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', file], { stdio: 'ignore' }),
      name + ' 生成的脚本语法不合法');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('写入脚本：页内异常时也会走恢复原值', () => {
  const script = buildFill();
  assert.ok(script.includes('restore-after-error'), 'catch 分支里要尝试恢复原值');
  assert.ok(script.includes('valueAfterRestore'), '要记录恢复后的值');
});

test('兜底恢复脚本：只做恢复，失败也给结构化结果', () => {
  const script = buildRestore('原始内容');
  assert.ok(script.includes('RESTORE_JSON='));
  assert.ok(script.includes('原始内容'), '原值要作为参数带进去');
  assert.ok(script.includes('ok: false'), '失败路径要返回 ok:false 而不是抛出去');
});

test('两个脚本拼接后都是合法 JS（模板里塞代码最容易拼坏）', () => {
  checkSyntax(buildFill(), 'fill');
  checkSyntax(buildRestore('原始关键词'), 'restore');
});
