'use strict';
// 一条命令看全局：服务、权限、小窗、队列、锁屏、最近失败。
//   node scripts/health.mjs
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyRun, envSkipReason } from '../core/run-classify.mjs';
import { localHeaders } from '../core/local-token.mjs';
import { daemonUrl, daemonPort, overlayUrl, overlayPort } from '../core/ports.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const rows = [];
function add(name, ok, detail) { rows.push({ name, ok, detail: detail === undefined ? '' : String(detail) }); }

async function getJson(url, timeout = 2500) {
  try {
    const r = await fetch(url, { headers: localHeaders(), signal: AbortSignal.timeout(timeout) });
    return await r.json();
  } catch { return null; }
}

/** 发一个请求只取状态码（可伪造 Host）：用来实机验证安全边界，不读响应体、不改变状态 */
function httpStatus(url, options = {}) {
  const { host, method = 'GET', headers = {}, body = null } = options;
  return new Promise((resolve) => {
    let u;
    try { u = new URL(url); } catch { resolve(0); return; }
    const req = http.request({
      host: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      method,
      headers: Object.assign({}, host ? { Host: host } : {}, headers),
      timeout: 3000,
    }, (res) => { res.resume(); resolve(res.statusCode || 0); });
    req.on('timeout', () => { req.destroy(); resolve(0); });
    req.on('error', () => resolve(0));
    if (body) req.write(body);
    req.end();
  });
}

function sh(cmd, args, timeout = 5000) {
  try { return execFileSync(cmd, args, { encoding: 'utf8', timeout }).trim(); } catch { return ''; }
}

async function main() {
  // 1. 服务
  // 用 /status：它才带 history 和 queueLength；GET / 只剩 ok/pid/uptimeSec
  const daemon = await getJson(daemonUrl('/status'));
  // /status 返回 queue(数组) 与 queueLength，没有 queued 字段；之前这里读 daemon.queued 一直显示 undefined
  const queueLen = daemon && (daemon.queueLength != null ? daemon.queueLength : (Array.isArray(daemon.queue) ? daemon.queue.length : null));
  add('后台 daemon ' + daemonPort(), Boolean(daemon && daemon.ok), daemon ? 'pid=' + daemon.pid + ' 队列=' + (queueLen == null ? '-' : queueLen) : '未启动');

  // 后台服务是 launchd 起的，权限身份和终端里跑不同：实际探一次系统事件与 ocu 是否可控
  const selftest = await getJson(daemonUrl('/selftest'), 20000);
  if (selftest) {
    const se = (selftest.checks && selftest.checks.systemEvents) || {};
    const ocu = (selftest.checks && selftest.checks.ocu) || {};
    let locked = false;
    try {
      const { isScreenLocked } = await import('../core/platform.mjs');
      locked = await isScreenLocked();
    } catch {}
    if (!selftest.ok) {
      add('后台服务自检', false, selftest.hint || '系统事件不可用');
    } else if (ocu.ok) {
      add('后台服务自检', true, '系统事件可用（' + (se.out || '').slice(0, 20) + ' 个进程）｜ocu 可用');
    } else if (locked) {
      // 锁屏时系统不让访问窗口服务，ocu 会直接失败，属系统限制不是配置问题
      add('后台服务自检', true, '系统事件可用｜ocu 锁屏期间不可用（解锁后恢复）');
    } else {
      add('后台服务自检', false, 'ocu 不可用：' + (ocu.error || '未知原因'));
    }
  }

  const ov = await getJson(overlayUrl('/health'));
  add('小窗 ' + overlayPort(), Boolean(ov && ov.ok), ov ? 'pid=' + ov.pid + ' session=' + ov.session : '未启动');

  // 安全边界实机自检：这几条是「承诺过必须挡住」的，服务在跑就顺手验一遍
  if (daemon && daemon.ok) {
    const noToken = await httpStatus(daemonUrl('/status'));
    const withToken = await httpStatus(daemonUrl('/status'), { headers: localHeaders() });
    add('接口票据（daemon）', noToken === 401 && withToken === 200, '无票=' + noToken + '｜带票=' + withToken);
    const daemonHost = await httpStatus(daemonUrl('/'), { host: 'evil.example:' + daemonPort() });
    add('Host 校验（daemon 防 DNS rebinding）', daemonHost === 403, 'Host=evil.example → ' + daemonHost);
  }
  if (ov && ov.ok) {
    const overlayHost = await httpStatus(overlayUrl('/health'), {
      host: 'evil.example:' + overlayPort(),
      headers: localHeaders(),
    });
    add('Host 校验（小窗防 DNS rebinding）', overlayHost === 403, 'Host=evil.example → ' + overlayHost);
    const badFrame = await httpStatus(overlayUrl('/frame'), {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, localHeaders()),
      body: JSON.stringify({ dataUrl: 'https://evil.example/track.png' }),
    });
    add('推帧白名单（不收远程图片）', badFrame === 400, '远程 dataUrl → ' + badFrame);
  }
  if (ov) {
    const sess = await getJson(overlayUrl('/sessions'));
    if (sess && typeof sess.count === 'number') {
      add('会话窗口', sess.count > 0, sess.count + ' 个（闲置 30 分钟自动回收，有活动按需重建）');
    }
    // hostVisible=false 不一定是故障：宿主不在前台、或当前 DSH 会话标题没命中门控时，
    // 小窗本来就该隐藏。只有 hostVisible=true 时才需要报告 stale。
    if (ov.hostVisible === true) {
      add('小窗宿主可见', true, 'hostVisible=true stale=' + ov.hostBoundsStale);
    } else {
      add('小窗宿主可见', true, '宿主不在前台或标题门控未命中，小窗按设计隐藏（stale=' + ov.hostBoundsStale + '）');
    }
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
    const pending = daemon.pendingRetry;
    if (cur) add('当前任务', true, cur + '（运行中）');
    else if (pending) {
      const secs = Math.max(0, Math.round((pending.at - Date.now()) / 1000));
      add('当前任务', true, '等待重试：' + pending.name + '（第 ' + (pending.attempt + 1) + ' 次，约 ' + secs + 's 后）');
    } else add('当前任务', true, '空闲');
    const hist = daemon.history || [];
    const cancelledRuns = hist.filter((h) => h && h.cancelled === true);
    // 用户按「停止」结束的任务不算失败
    const fails = hist.filter((h) => h && h.ok === false && !h.cancelled);
    const fmtDur = (ms) => {
      const s = Math.max(0, Math.round((ms || 0) / 1000));
      return s >= 90 ? Math.round(s / 60) + 'm' + (s % 60 ? Math.round(s % 60) + 's' : '') : s + 's';
    };
    let failDetail;
    const stopNote = cancelledRuns.length ? '，主动停止 ' + cancelledRuns.length + ' 次' : '';
    const skipRuns = hist.filter((h) => h && h.envSkip === true);
    const skipNote = skipRuns.length ? '｜其中 ' + skipRuns.length + ' 次环境跳过（未验证）' : '';
    if (!hist.length) failDetail = '暂无记录';
    else if (!fails.length) failDetail = '最近 ' + hist.length + ' 次全部成功（上次：' + hist[0].name + ' ' + fmtDur(hist[0].durationMs) + '）' + stopNote + skipNote;
    else {
      const lf = fails[0];
      failDetail = fails.length + ' / ' + hist.length + ' 次失败（最近失败：' + lf.name + '，退出码 ' + lf.code + '，' + (lf.startedAt || '').slice(5, 16).replace('T', ' ') + ' UTC）';
    }
    add('最近任务失败数', fails.length === 0, failDetail);

    // 自动重试是否真的在帮忙：有重试记录说明遇到过临时性失败并救回来了
    const retried = hist.filter((h) => h && (h.attempt || 0) > 0);
    if (retried.length) {
      const rescued = retried.filter((h) => h.ok).length;
      add('自动重试', true, '最近 ' + hist.length + ' 次里重试 ' + retried.length + ' 次，救回 ' + rescued + ' 次');
    } else {
      add('自动重试', true, '最近 ' + hist.length + ' 次未触发重试');
    }

    // 前台保护：任务期间有没有应用试图抢前台，被看门狗拦下几次
    const guardHits = hist.filter((h) => h && (h.frontSteals || 0) > 0);
    const guardTotal = guardHits.reduce((sum, h) => sum + (h.frontSteals || 0), 0);
    add('前台保护', true,
      guardTotal
        ? '最近 ' + hist.length + ' 次里拦截 ' + guardTotal + ' 次前台抢占（用户重切 3 次以上会认账）'
        : '最近 ' + hist.length + ' 次未发生前台抢占');

    // 耗时趋势：按任务聚合，能看出哪个任务在拖后腿
    const stats = await getJson(daemonUrl('/stats'));
    if (stats && stats.runs) {
      const secs = (ms) => (ms >= 1000 ? (ms / 1000).toFixed(1) + 's' : Math.round(ms) + 'ms');
      const slowest = (stats.tasks || []).slice().sort((a, b) => b.avgMs - a.avgMs)[0];
      add('任务耗时', true,
        '近 ' + stats.runs + ' 次：成功率 ' + stats.okRate + '%' +
        (stats.envSkips ? '（已排除 ' + stats.envSkips + ' 次环境跳过）' : '') + '｜平均 ' + secs(stats.avgMs) +
        (slowest ? '｜最慢 ' + slowest.name + ' ' + secs(slowest.avgMs) + '（最多 ' + secs(slowest.maxMs) + '）' : ''));
    }
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

  // 6. --deep：顺带跑小窗效果回归 + 会话隔离（约 20 秒）
  // 失败时 execFileSync 会抛错，但 stdout 里有具体哪几条没通过，要抓出来展示
  if (process.argv.includes('--deep')) {
    const runCheck = (script) => {
      try {
        return { out: execFileSync(process.execPath, [path.join(ROOT, 'scripts', script)], { encoding: 'utf8', timeout: 120000 }), crashed: false };
      } catch (e) {
        return { out: String(e.stdout || '') + String(e.stderr || ''), crashed: Boolean(e.stderr && !String(e.stdout || '').trim()) };
      }
    };
    const summarize = (out) => {
      const total = (out.match(/✅/g) || []).length + (out.match(/❌/g) || []).length;
      const failed = (out.match(/❌/g) || []).length;
      const names = out.split('\n').filter((l) => l.includes('❌')).map((l) => l.replace(/.*❌\s*/, '').trim().slice(0, 18));
      return { total, failed, detail: total ? (total + ' 项，' + failed + ' 项失败' + (names.length ? '：' + names.join('、') : '')) : '没有输出' };
    };

    // 被检脚本在锁屏时会打印「环境跳过」并退 0：这是环境限制，不能显示成 ❌。
    // 复用 run-classify 的那套判定（已单测），不在这里另写一条正则。
    const ui = runCheck('ui-regression.mjs');
    const uiSkip = envSkipReason(ui.out) ? '环境跳过：' + envSkipReason(ui.out) : '';
    const uiSum = summarize(ui.out);
    if (uiSkip) add('小窗效果回归', true, uiSkip);
    else {
      add('小窗效果回归', uiSum.failed === 0 && uiSum.total > 0, uiSum.detail);
      if (!uiSum.total) add('小窗效果回归失败原因', false, ui.out.slice(-120).replace(/\n/g, ' '));
    }

    const scope = runCheck('session-scope-check.mjs');
    const scopeSkip = envSkipReason(scope.out) ? '环境跳过：' + envSkipReason(scope.out) : '';
    const scopeSum = summarize(scope.out);
    if (scopeSkip) add('会话隔离检查', true, scopeSkip);
    else add('会话隔离检查', scopeSum.failed === 0 && scopeSum.total > 0, scopeSum.detail);
  }

  const width = Math.max(...rows.map((r) => r.name.length)) + 2;
  console.log('\n整体状态\n');
  for (const r of rows) console.log((r.ok ? '  ✅ ' : '  ❌ ') + r.name.padEnd(width) + r.detail);
  const bad = rows.filter((r) => !r.ok);
  console.log('\n' + (bad.length ? bad.length + ' 项需要关注' : '全部正常') + '\n');
  process.exit(bad.length ? 1 : 0);
}

main().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });