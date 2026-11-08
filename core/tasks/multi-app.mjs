import { isScreenLocked, lockedSkipNotice } from '../platform.mjs';
import { ocu, overlay, guard, withAppLock, countElements } from '../agentd.mjs';
import { isAppRunning, quitApp, frontName, settleFront } from '../background.mjs';

// 同时控制两个应用：每个应用独立加锁，互不阻塞。
const TARGETS = (process.env.TARGETS || 'Finder,Calculator')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

/**
 * 环境跳过原因：没在运行的应用绝不去"探测"。
 *
 * 为什么要有这条：ocu 的 snapshot 对一个没运行的应用会把它启动起来并顶到前台
 * （2026-11-08 08:08 的 multi-app 实测：Calculator 被拉起，前台 DeepSeek Harness → 计算器，
 * 任务结束也没关，后面的任务/验收全被这个前台污染）。
 */
export const SKIP_NOT_RUNNING_REASON = '没在运行，不为了演示去启动/激活它（ocu 对未运行应用会把它拉起来并顶到前台）';

/**
 * 该不该 probe 这个应用（纯函数，便于单测）。
 * 只有确定在运行才允许探测；拿不到运行状态按"不在运行"处理，宁可跳过也不误启动。
 *
 * @param {{running?:boolean}} [input]
 * @returns {{probe:boolean, reason:string}}
 */
export function shouldProbeApp(input) {
  const opts = input || {};
  if (opts.running === true) return { probe: true, reason: '' };
  return { probe: false, reason: SKIP_NOT_RUNNING_REASON };
}

/**
 * 并行结果判定（纯函数）：fulfilled 不等于成功——快照可能是空树（节点 0），
 * 只有真的读到节点才算这个应用成功；任何一个失败都不能 exit 0（评审 false-green 类问题）。
 *
 * 环境跳过（status='skipped'，没在运行）不计入分母：既不算成功，也不算失败，
 * 由调用方按「环境跳过」正常退出；全部跳过时 envSkip=true。
 *
 * @param {Array<{status:string, value?:{nodes?:number}, reason?:any}>} results
 * @param {number} total 目标应用数
 */
export function summarizeMultiApp(results, total) {
  const list = Array.isArray(results) ? results : [];
  const expected = Number(total) > 0 ? Number(total) : list.length;
  const skipped = list.filter((r) => r && r.status === 'skipped').length;
  const success = list.filter((r) => r && r.status === 'fulfilled' && Number(r.value && r.value.nodes) > 0).length;
  const graded = Math.max(0, expected - skipped);
  let problem = '';
  if (graded === 0) problem = '所有目标应用都没在运行：环境跳过，不为了演示去启动它们';
  else if (success < graded) problem = '并行控制只有 ' + success + '/' + graded + ' 个应用真的读到内容';
  return { ok: graded > 0 && success === graded, envSkip: graded === 0, success, skipped, graded, total: expected, problem };
}

/**
 * 探测一个在运行的应用：读 AX 树并数节点。
 * 额外记一次前台基线：guard 只拦"目标应用被顶到前台"，这里在探测后发现前台被换成别的应用时，
 * 尝试把用户原来的前台还原回去（只还原，不启动任何东西）。
 */
async function probe(app) {
  return withAppLock(app, async () => {
    const baseline = await frontName();
    const { result, before, after } = await guard(
      app,
      async () => {
        const text = await ocu.snapshot(app, { nodes: 3000 });
        return text;
      },
      { label: '读取 ' + app + ' 完成' }
    );
    let frontStolen = before !== after;
    let frontRestored = true;
    if (frontStolen && baseline && baseline !== '(unknown)') {
      try {
        const settled = await settleFront(baseline, { waitMs: 150, retries: 2 });
        frontStolen = settled.stolen;
        frontRestored = settled.restored;
      } catch {
        frontRestored = false;
      }
    }
    return { app, nodes: countElements(result), before, after, frontStolen, frontRestored };
  });
}

/**
 * 兜底收尾：如果有本不该被拉起的应用（跑之前没在运行、跑之后在运行），尝试关掉它。
 * 只处理"跑之前不在运行"的目标，用户原本开着的应用一律不碰。
 */
async function cleanupUnexpectedLaunches(plans) {
  const cleaned = [];
  for (const plan of plans) {
    if (plan.running) continue; // 用户本来开着的，绝不关
    let nowRunning = false;
    try {
      nowRunning = await isAppRunning({ appName: plan.app, processName: plan.app });
    } catch {
      nowRunning = false;
    }
    if (!nowRunning) continue;
    let quit = { quit: false, mode: 'error', detail: '' };
    try {
      quit = await quitApp({ appName: plan.app, processName: plan.app });
    } catch (e) {
      quit = { quit: false, mode: 'error', detail: String(e && e.message || e).slice(0, 80) };
    }
    cleaned.push({ app: plan.app, mode: quit.mode, quit: quit.quit });
    console.log('清理：' + plan.app + ' 本不该被拉起，已尝试关闭（mode=' + quit.mode + '）');
    await overlay.log('清理意外启动：' + plan.app + '（mode=' + quit.mode + '）');
  }
  return cleaned;
}

async function main() {
  // 锁屏下 AX 不可用：不跳过会得到「节点 0 / 前台 (unknown)」还 exit 0，看着像全部正常
  if (await isScreenLocked()) {
    console.log(lockedSkipNotice('multi-app.mjs'));
    return;
  }

  // 先判每个目标在不在运行；不在运行的一律跳过，绝不为了演示去启动/激活它。
  const plans = [];
  for (const name of TARGETS) {
    let running = false;
    try {
      running = await isAppRunning({ appName: name, processName: name });
    } catch {
      running = false;
    }
    plans.push({ app: name, running, ...shouldProbeApp({ running }) });
  }
  const runnable = plans.filter((p) => p.probe);
  console.log('目标', plans.length, '个：在运行', runnable.length, '个，环境跳过', plans.length - runnable.length, '个');
  for (const plan of plans) {
    if (plan.probe) continue;
    console.log('SKIP', plan.app.padEnd(14), '| 环境跳过：' + plan.reason);
    await overlay.log(plan.app + '：环境跳过（没在运行，不启动它）');
  }

  await overlay.status('并行读取 ' + runnable.length + ' 个在运行的应用');
  const t0 = Date.now();

  const results = [];
  if (runnable.length) {
    const settled = await Promise.allSettled(runnable.map((p) => probe(p.app)));
    let index = 0;
    for (const plan of plans) {
      if (plan.probe) {
        results.push(settled[index]);
        index += 1;
      } else {
        results.push({ status: 'skipped', value: { app: plan.app, nodes: 0, reason: plan.reason } });
      }
    }
  } else {
    for (const plan of plans) {
      results.push({ status: 'skipped', value: { app: plan.app, nodes: 0, reason: plan.reason } });
    }
  }

  for (const r of results) {
    if (r.status === 'fulfilled') {
      const v = r.value;
      console.log(v.app.padEnd(14), '节点', String(v.nodes).padStart(5), '| 前台', v.before, '→', v.after,
        v.frontStolen ? (v.frontRestored ? '（前台被抢，已还原）' : '（前台被抢，还原失败）') : '');
      await overlay.log(v.app + '：' + v.nodes + ' 个节点');
    } else if (r.status === 'skipped') {
      // 上面已经逐条打印过，这里不重复刷屏
    } else {
      console.log('FAIL', String(r.reason).slice(0, 120));
      await overlay.log('失败：' + String(r.reason).slice(0, 80));
    }
  }

  const verdict = summarizeMultiApp(results, TARGETS.length);
  await overlay.status('并行完成：' + verdict.success + '/' + verdict.graded + ' 个在运行应用，跳过 ' + verdict.skipped + ' 个，用时 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
  console.log('用时', ((Date.now() - t0) / 1000).toFixed(1), 's');

  // 理论不该发生：跳过之后还有应用被拉起，说明探测路径仍有副作用。只关"跑之前没在运行"的。
  await cleanupUnexpectedLaunches(plans);

  if (verdict.envSkip) {
    console.log('环境跳过：' + verdict.problem);
    return;
  }
  if (!verdict.ok) {
    console.log('❌ ' + verdict.problem);
    process.exitCode = 1;
  }
}

const invokedDirectly = Boolean(process.argv[1])
  && (await import('node:path')).resolve(process.argv[1]) === (await import('node:url')).fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main().catch((e) => {
    console.error('FAIL:', e.message);
    process.exit(1);
  });
}
