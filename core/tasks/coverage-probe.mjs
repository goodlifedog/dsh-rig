import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { resolveOcu } from '../platform.mjs';

import { isMac } from '../platform.mjs';
if (!isMac) {
  console.error('此任务依赖 macOS 的 ocu/osascript，Windows 版待移植；跨平台通路验证请跑 platform-demo');
  process.exit(2);
}
const OCU = resolveOcu() || path.join(os.homedir(), '.local/bin/ocu');
const NODES = Number(process.env.COVERAGE_NODES || 6000);
const OUT_JSON = process.env.COVERAGE_JSON || '/tmp/coverage-latest.json';
const RAW_DIR = process.env.COVERAGE_RAW_DIR || '/tmp/coverage-raw';

// 探测目标：中文名 / bundle id。用 bundle id 绑定，避免中文名和本地化名对不上（appNotFound）。
const TARGETS = [
  { name: '微信', bundle: 'com.tencent.xinWeChat' },
  { name: '系统设置', bundle: 'com.apple.systempreferences' },
  { name: 'App Store', bundle: 'com.apple.AppStore' },
  { name: '备忘录', bundle: 'com.apple.Notes' },
  { name: '访达', bundle: 'com.apple.finder' },
  { name: 'Safari', bundle: 'com.apple.Safari' },
  { name: '终端', bundle: 'com.apple.Terminal' },
  { name: 'iTerm2', bundle: 'com.googlecode.iterm2' },
  { name: 'Google Chrome', bundle: 'com.google.Chrome' },
  { name: 'DeepSeek Harness', bundle: 'com.deepseek.dsh' },
  { name: '计算器', bundle: 'com.apple.calculator' },
  { name: 'Clash Verge', bundle: 'io.github.clash-verge-rev.clash-verge-rev' },
  { name: 'Telegram', bundle: 'ru.keepcoder.Telegram' },
  { name: 'Electron(overlay)', bundle: 'com.github.Electron' },
];

// 交互控件识别：不同应用会把 AX role 本地化成中文或英文（Electron/DSH 是英文 role），
// 所以这里同时匹配中英文角色名，按「角色短语」命中算一个可交互控件。
const INTERACTIVE_RE = /(按钮|文本栏|复选框|弹出式按钮|菜单项|文本输入区|列表框|滑块|单选框|开关|链接|link\b|button\b|text field|text area|check ?box|pop ?up button|menu item|list box|slider|radio button|switch\b|toggle\b|combo box|search field|disclosure triangle|segmented control|tab\b)/i;
const ROLE_PATTERNS = [
  'text field', 'text area', 'check box', 'checkbox', 'pop up button', 'menu item', 'list box',
  'radio button', 'combo box', 'search field', 'disclosure triangle', 'segmented control',
  '按钮', '文本栏', '复选框', '弹出式按钮', '菜单项', '文本输入区', '列表框', '滑块', '单选框', '开关', '链接',
  'button', 'slider', 'switch', 'toggle', 'link', 'tab',
];

function run(cmd, args, opts) {
  const options = Object.assign({ timeout: 60000, maxBuffer: 64 * 1024 * 1024 }, opts || {});
  return new Promise((resolve) => {
    execFile(cmd, args, options, (err, stdout, stderr) => {
      resolve({
        code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
      });
    });
  });
}

async function listApps() {
  const r = await run(OCU, ['list-apps']);
  const apps = [];
  for (const line of r.stdout.split('\n')) {
    const m = /^(.*?)\s+—\s+(\S+)\s+\[([^\]]*)\]/.exec(line.trim());
    if (!m) continue;
    apps.push({
      name: m[1].trim(),
      bundle: m[2].trim(),
      running: /running/.test(m[3]),
      frontmost: /frontmost/.test(m[3]),
      markers: m[3],
    });
  }
  return apps;
}

function countNodes(text) {
  return (text.match(/^\s*\d+ /gm) || []).length;
}

function roleOf(line) {
  const stripped = line.replace(/^\s*\d+\s*/, '');
  const lower = stripped.toLowerCase();
  for (const p of ROLE_PATTERNS) {
    if (lower.startsWith(p)) return p;
  }
  const m = /^(\S+)/.exec(stripped);
  return m ? m[1] : '';
}

function analyze(text, bundle, name) {
  const nodes = countNodes(text);
  const lines = text.split('\n');
  const roleCounts = new Map();
  const examples = [];
  let interactive = 0;
  for (const line of lines) {
    if (!/^\s*\d+ /.test(line)) continue;
    const role = roleOf(line);
    if (!role) continue;
    const strippedLine = line.replace(/^\s*\d+\s*/, '');
    if (!INTERACTIVE_RE.test(strippedLine)) continue;
    interactive += 1;
    roleCounts.set(role, (roleCounts.get(role) || 0) + 1);
    if (examples.length < 3) {
      const textPart = line.replace(/^\s*\d+\s*/, '').trim();
      if (textPart && !/^\S+$/.test(textPart)) examples.push(textPart.slice(0, 100));
    }
  }
  const topRoles = Array.from(roleCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map((e) => e[0] + ':' + e[1]);
  const win = /^Window: (.*)$/m.exec(text);
  const windowTitle = win ? win[1].trim() : null;
  const windowCount = (text.match(/^Window:/gm) || []).length;

  let tier = '不可用';
  let reason = '';
  if (nodes === 0) {
    reason = '节点数为 0（无可读 AX 树）';
  } else if (nodes < 15 || interactive < 2) {
    reason = '节点/可交互控件过少（' + nodes + ' 节点 / ' + interactive + ' 可交互）';
  } else if (nodes >= 60 && interactive >= 10) {
    tier = '可用';
  } else {
    tier = '勉强可用';
    reason = '节点或可交互数量偏少（' + nodes + ' 节点 / ' + interactive + ' 可交互）';
  }
  return {
    name: name,
    bundle: bundle,
    status: 'ok',
    tier: tier,
    reason: reason,
    nodes: nodes,
    interactive: interactive,
    windowCount: windowCount,
    windowTitle: windowTitle,
    topRoles: topRoles,
    examples: examples,
  };
}

function classifyError(text) {
  if (/appNotFound/.test(text)) return 'appNotFound（应用未运行/未安装/无法绑定）';
  if (/cgWindowNotFound/.test(text)) return 'cgWindowNotFound（应用在运行但没有可读窗口，可能在别的 Space 或窗口尚未创建）';
  if (/NSPOSIXErrorDomain Code=2/.test(text)) return 'NSPOSIXErrorDomain Code=2（屏幕锁定，AX 全部不可用）';
  if (/timed? ?out|timeout/i.test(text)) return '超时';
  return text.split('\n')[0].slice(0, 200) || '未知错误';
}

async function probeOne(target) {
  const t0 = Date.now();
  const r = await run(OCU, ['snapshot', '--max-tree-nodes', String(NODES), target.bundle], { timeout: 45000 });
  const text = r.stdout + r.stderr;
  const elapsedMs = Date.now() - t0;
  if (/Error Domain=|appNotFound|cgWindowNotFound/.test(text) || r.code !== 0 || countNodes(text) === 0) {
    return {
      name: target.name,
      bundle: target.bundle,
      status: 'error',
      tier: '不可用',
      reason: classifyError(text),
      nodes: countNodes(text),
      interactive: 0,
      rawHead: text.split('\n').slice(0, 6).join('\n'),
      elapsedMs: elapsedMs,
    };
  }
  const info = analyze(text, target.bundle, target.name);
  info.elapsedMs = elapsedMs;
  info.rawHead = text.split('\n').slice(0, 4).join('\n');
  return info;
}

function printTable(results) {
  const cols = ['应用', 'bundle', '分档', '节点', '可交互', '窗口', '说明/示例'];
  const rows = results.map((r) => [
    r.name,
    r.bundle,
    r.tier,
    String(r.nodes),
    String(r.interactive),
    r.windowTitle ? String(r.windowTitle).slice(0, 40) : (r.windowCount ? String(r.windowCount) + ' 个' : '-'),
    (r.reason || (r.examples && r.examples[0]) || '').slice(0, 60),
  ]);
  const widths = cols.map((c, i) => Math.max(c.length, ...rows.map((row) => String(row[i]).length)));
  const pad = (s, w) => {
    let out = String(s);
    let visible = 0;
    for (const ch of out) visible += /[\u4e00-\u9fa5]/.test(ch) ? 2 : 1;
    while (visible < w) { out += ' '; visible += 1; }
    return out;
  };
  const line = (cells) => cells.map((c, i) => pad(c, widths[i])).join('  ');
  console.log(line(cols));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const row of rows) console.log(line(row));
}

async function main() {
  console.log('=== macOS 应用 AX 覆盖率探测 ===');
  console.log('ocu:', OCU, '| 树预算:', NODES, '| 时间:', new Date().toISOString());
  await mkdir(RAW_DIR, { recursive: true }).catch(() => {});

  const apps = await listApps();
  const running = new Set(apps.filter((a) => a.running).map((a) => a.bundle));
  const nameByBundle = new Map();
  for (const a of apps) nameByBundle.set(a.bundle, a.name);

  // 计划探测：显式目标 + 其它正在运行的应用（动态补充，最多 8 个）
  const plan = [];
  const seen = new Set();
  for (const t of TARGETS) {
    if (seen.has(t.bundle)) continue;
    seen.add(t.bundle);
    plan.push({ name: t.name, bundle: t.bundle, running: running.has(t.bundle) });
  }
  let extra = 0;
  for (const a of apps) {
    if (!a.running || seen.has(a.bundle) || extra >= 8) continue;
    seen.add(a.bundle);
    plan.push({ name: a.name, bundle: a.bundle, running: true, dynamic: true });
    extra += 1;
  }

  const results = [];
  for (const item of plan) {
    if (!item.running) {
      results.push({
        name: item.name,
        bundle: item.bundle,
        status: 'not-running',
        tier: '未测',
        reason: '未运行（扫描非运行应用会把它启动起来，因此跳过；需要覆盖请先手动打开）',
        nodes: 0,
        interactive: 0,
      });
      continue;
    }
    process.stdout.write('探测 ' + item.name + ' (' + item.bundle + ') … ');
    const res = await probeOne(item);
    results.push(res);
    console.log(res.tier + ' | ' + res.nodes + ' 节点 / ' + res.interactive + ' 可交互');
    const rawName = item.bundle.replace(/[^A-Za-z0-9._-]/g, '_') + '.txt';
    const raw = await run(OCU, ['snapshot', '--max-tree-nodes', String(NODES), item.bundle], { timeout: 45000 });
    await writeFile(path.join(RAW_DIR, rawName), raw.stdout + raw.stderr, 'utf8').catch(() => {});
  }

  const summary = {
    generatedAt: new Date().toISOString(),
    ocu: OCU,
    nodeBudget: NODES,
    counts: {
      total: results.length,
      usable: results.filter((r) => r.tier === '可用').length,
      barely: results.filter((r) => r.tier === '勉强可用').length,
      unusable: results.filter((r) => r.tier === '不可用').length,
      notTested: results.filter((r) => r.status === 'not-running').length,
    },
    results: results,
  };
  await writeFile(OUT_JSON, JSON.stringify(summary, null, 2), 'utf8').catch(() => {});

  console.log('');
  console.log('--- 覆盖率表 ---');
  printTable(results.filter((r) => r.status !== 'not-running'));
  console.log('');
  console.log('--- 未运行（未测） ---');
  for (const r of results.filter((r) => r.status === 'not-running')) {
    console.log('  ' + r.name + ' (' + r.bundle + ')');
  }
  console.log('');
  console.log('统计:', JSON.stringify(summary.counts));
  console.log('JSON:', OUT_JSON, '| 原始快照:', RAW_DIR);
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
