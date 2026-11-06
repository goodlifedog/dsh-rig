'use strict';
// 一条命令看全局：服务、权限、小窗、队列、锁屏、最近失败。
//   node scripts/health.mjs
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyRun } from '../core/run-classify.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const rows = [];
function add(name, ok, detail) { rows.push({ name, ok, detail: detail === undefined ? '' : String(detail) }); }

async function getJson(url, timeout = 2500) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(timeout) });
    return await r.json();
  } catch { return null; }
}

function sh(cmd, args, timeout = 5000) {
  try { return execFileSync(cmd, args, { encoding: 'utf8', timeout }).trim(); } catch { return ''; }
}

async function main() {
  // 1. 服务
  // 用 /status：它才带 history；GET / 只有 current/queued/tasks
  const daemon = await getJson('http://127.0.0.1:7789/status');
  add('后台 daemon 7789', Boolean(daemon && daemon.ok), daemon ? 'pid=' + daemon.pid + ' 队列=' + daemon.queued : '未启动');

  // 后台服务是 launchd 起的，权限身份和终端里跑不同：实际探一次系统事件与 ocu 是否可控
  const selftest = await getJson('http://127.0.0.1:7789/selftest', 20000);
  if (selftest) {
    const se = (selftest.checks && selftest.checks.systemEvents) || {};
    const ocu = (selftest.checks && selftest.checks.ocu) || {};
    add('后台服务自检', Boolean(selftest.ok),
      selftest.ok
        ? '系统事件可用（' + (se.out || '').slice(0, 20) + ' 个进程）｜ocu ' + (ocu.ok ? '可用' : '不可用：' + (ocu.error || ''))
        : (selftest.hint || '系统事件不可用'));
  }

  const ov = await getJson('http://127.0.0.1:7788/health');
  add('小窗 7788', Boolean(ov && ov.ok), ov ? 'pid=' + ov.pid + ' session=' + ov.session : '未启动');
  if (ov) {
    add('小窗宿主可见', ov.hostVisible === true, 'hostVisible=' + ov.hostVisible + ' stale=' + ov.hostBoundsStale);
    add('点击穿透', ov.clickThrough === true, 'clickThrough=' + ov.clickThrough);
    // 画面：只有「真出错」和「该有画面却停住」才算问题；空闲没绑窗口是正常态
    const thumbState = (ov.thumbnail && ov.thumbnail.state) || '-';
    const thumbError = (ov.thumbnail && ov.thumbnail.error) || '';
    if (thumbState === 'live') {
      const stalled = !(ov.fps > 0) && (ov.frameBytes || 0) === 0;
      add('画面', !stalled, 'state=live fps=' + ov.fps + ' 宽=' + ov.frameWidth + (stalled ? '（没有新帧）' : ''));
    } else if (thumbState === 'error') {
      add('画面', false, thumbError || '抓帧失败');
    } else if (thumbState === 'no-window') {
      add('画面', true, '未绑定被控窗口（空闲时正常）');
    } else {
      add('画面', true, 'state=' + thumbState + (thumbError ? ' ｜' + thumbError : ''));
    }
    add('锁屏状态', true, ov.screenLocked ? '已锁屏（Chrome 启动会慢很多）' : '未锁屏');
  }

  // 2. 权限（复用 core/permissions.mjs，避免这里再写一份解析）
  try {
    const { checkPermissions } = await import('../core/permissions.mjs');
    const perm = await checkPermissions();
    add('系统权限', perm.ok, perm.missing && perm.missing.length ? '缺：' + perm.missing.join(',') : '辅助功能 + 屏幕录制均已授权');
  } catch (e) {
    add('系统权限', false, '检查失败：' + String(e.message).slice(0, 60));
  }

  // 3. 队列与最近任务
  if (daemon) {
    const cur = daemon.current ? daemon.current.name : null;
    add('当前任务', true, cur ? cur + '（运行中）' : '空闲');
    const hist = daemon.history || [];
    const fails = hist.filter((h) => h && h.ok === false);
    const fmtDur = (ms) => {
      const s = Math.max(0, Math.round((ms || 0) / 1000));
      return s >= 90 ? Math.round(s / 60) + 'm' + (s % 60 ? Math.round(s % 60) + 's' : '') : s + 's';
    };
    let failDetail;
    if (!hist.length) failDetail = '暂无记录';
    else if (!fails.length) failDetail = '最近 ' + hist.length + ' 次全部成功（上次：' + hist[0].name + ' ' + fmtDur(hist[0].durationMs) + '）';
    else {
      const lf = fails[0];
      failDetail = fails.length + ' / ' + hist.length + ' 次失败（最近失败：' + lf.name + '，退出码 ' + lf.code + '，' + (lf.startedAt || '').slice(5, 16).replace('T', ' ') + ' UTC）';
    }
    add('最近任务失败数', fails.length === 0, failDetail);
  }

  // 4. 近 24 小时运行日志里的失败
  const runsDir = path.join(ROOT, 'logs', 'runs');
  let recentTotal = 0;
  let envSkips = 0;
  let unexpected = 0;      // 24h 内的真失败（含历史）
  let unexpectedRecent = 0; // 最近 1 小时的真失败（当前状态判断依据）
  const unexpectedNames = [];
  try {
    const cutoff = Date.now() - 24 * 3600 * 1000;
    for (const f of fs.readdirSync(runsDir)) {
      const full = path.join(runsDir, f);
      const st = fs.statSync(full);
      if (st.mtimeMs < cutoff) continue;
      recentTotal += 1;
      const text = fs.readFileSync(full, 'utf8');
      // 失败归类与验收共用一份规则（core/run-classify.mjs），避免两边判定不一致
      const verdict = classifyRun(text);
      if (!verdict.failed) continue;
      if (verdict.envSkip) envSkips += 1;
      else {
        unexpected += 1;
        const ageMs = Date.now() - st.mtimeMs;
        if (ageMs < 3600 * 1000) unexpectedRecent += 1;
        const name = (text.match(/"task":"([^"]+)"/) || [])[1] || f;
        if (unexpectedNames.length < 3) unexpectedNames.push(name);
      }
    }
  } catch {}
  add('24h 运行记录', unexpectedRecent === 0,
    recentTotal + ' 次｜近 1h 真失败 ' + unexpectedRecent + '｜24h 真失败 ' + unexpected + '｜已知环境失败 ' + envSkips +
    (unexpected ? '｜' + unexpectedNames.join(', ') : ''));

  // 5. 依赖版本
  const bundledPkg = path.join(ROOT, 'third_party', 'open-computer-use', 'package.json');
  if (fs.existsSync(bundledPkg)) {
    const v = JSON.parse(fs.readFileSync(bundledPkg, 'utf8')).version;
    add('随包 ocu', true, 'v' + v);
  } else {
    add('随包 ocu', true, '未打包（用全局安装）');
  }

  // 6. --deep：顺带跑一遍小窗效果回归（会出现/消失/放大，约 20 秒）
  if (process.argv.includes('--deep')) {
    try {
      const out = execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'ui-regression.mjs')], { encoding: 'utf8', timeout: 120000 });
      const passed = (out.match(/✅/g) || []).length;
      const failed = (out.match(/❌/g) || []).length;
      add('小窗效果回归', failed === 0, passed + ' 项通过' + (failed ? '，' + failed + ' 项失败' : ''));
    } catch (e) {
      add('小窗效果回归', false, '执行失败：' + String(e.message).slice(0, 60));
    }
  }

  const width = Math.max(...rows.map((r) => r.name.length)) + 2;
  console.log('\n整体状态\n');
  for (const r of rows) console.log((r.ok ? '  ✅ ' : '  ❌ ') + r.name.padEnd(width) + r.detail);
  const bad = rows.filter((r) => !r.ok);
  console.log('\n' + (bad.length ? bad.length + ' 项需要关注' : '全部正常') + '\n');
  process.exit(bad.length ? 1 : 0);
}

main().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });