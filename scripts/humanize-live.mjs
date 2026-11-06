#!/usr/bin/env node
// 拟人输入真机验证：往 TextEdit 后台打字（带停顿、打错纠正），验证不切前台，并保存证据。
//   npm run humanize:live
// 注意：会短暂写入 TextEdit 当前文档，测试结束用 AX set_value 还原。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const child = spawn(process.execPath, ['--test', path.join(ROOT, 'test', 'humanize-live.test.mjs')], {
  cwd: ROOT,
  env: { ...process.env, HUMANIZE_LIVE: '1' },
});

let out = '';
child.stdout.on('data', (b) => { out += b; process.stdout.write(b); });
child.stderr.on('data', (b) => { out += b; process.stderr.write(b); });

child.on('close', (code) => {
  // 从 TAP 注释里把证据 JSON 抠出来（每行以 "# " 开头）
  const start = out.indexOf('# {');
  const end = out.indexOf('# }', start);
  let evidence = null;
  if (start >= 0 && end > start) {
    const jsonText = out.slice(start + 2, end + 3)
      .split('\n')
      .map((line) => line.replace(/^#\s?/, ''))
      .join('\n');
    try { evidence = JSON.parse(jsonText); } catch {}
  }

  const dir = path.join(ROOT, 'reports');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'humanize-live-' + new Date().toISOString().replace(/[:.]/g, '-') + '.md');

  const lines = [
    '# 拟人输入真机验证',
    '',
    '- 时间：' + new Date().toISOString(),
    '- 结果：' + (code === 0 ? '通过' : '未通过'),
  ];
  if (evidence) {
    const t = evidence.typing || {};
    const tr = evidence.trajectory || {};
    lines.push(
      '',
      '| 指标 | 实测 |',
      '| --- | --- |',
      '| 输入内容 | ' + (evidence.sentence || '-') + ' |',
      '| 字符 / 分段 | ' + (t.chars || '-') + ' / ' + (t.chunks || '-') + ' |',
      '| 打错后纠正 | ' + (t.typos || 0) + ' 次 |',
      '| 输入耗时 | ' + (t.elapsedMs || '-') + 'ms（' + (t.msPerChar || '-') + 'ms/字） |',
      '| 段落长度校验 | 实际 ' + (t.resultLen || '-') + ' = 期望 ' + (t.expectLen || '-') + ' |',
      '| 鼠标轨迹 | ' + (tr.steps || '-') + ' 步 / ' + (tr.movedPx || '-') + 'px / ' + (tr.elapsedMs || '-') + 'ms |',
      '| 单步间隔 | ' + (tr.stepMs ? (tr.stepMs.min + '–' + tr.stepMs.max + 'ms') : '-') + ' |',
      '| 前台应用 | 操作前 ' + (evidence.frontBefore || '-') + '；操作后未变：' + (evidence.frontUnchanged ? '是' : '否') + ' |',
      '| TextEdit 内容还原 | ' + (evidence.restored ? '已还原' : '未还原') + ' |',
      '',
      '坐标点击（需要截图、会把窗口抬前）在该测试里被安全护栏拒绝，这是预期行为；',
      '语义点击/勾选框走了 accessibility 路径。',
    );
  }
  fs.writeFileSync(file, lines.join('\n') + '\n');
  console.log('\n证据：reports/' + path.basename(file));
  process.exit(code === null ? 1 : code);
});
