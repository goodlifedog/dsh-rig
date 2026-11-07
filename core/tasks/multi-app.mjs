import { isScreenLocked, lockedSkipNotice } from '../platform.mjs';
import { ocu, overlay, guard, withAppLock, countElements } from '../agentd.mjs';

// 同时控制两个应用：每个应用独立加锁，互不阻塞。
const TARGETS = (process.env.TARGETS || 'Finder,Calculator').split(',').map((s) => s.trim());

/**
 * 并行结果判定（纯函数）：fulfilled 不等于成功——快照可能是空树（节点 0），
 * 只有真的读到节点才算这个应用成功；任何一个失败都不能 exit 0（评审 false-green 类问题）。
 * @param {Array<{status:string, value?:{nodes?:number}, reason?:any}>} results
 * @param {number} total 目标应用数
 */
export function summarizeMultiApp(results, total) {
  const list = Array.isArray(results) ? results : [];
  const expected = Number(total) > 0 ? Number(total) : list.length;
  const success = list.filter((r) => r && r.status === 'fulfilled' && Number(r.value && r.value.nodes) > 0).length;
  let problem = '';
  if (success < expected) problem = '并行控制只有 ' + success + '/' + expected + ' 个应用真的读到内容';
  return { ok: success === expected && expected > 0, success, total: expected, problem };
}

async function probe(app) {
  return withAppLock(app, async () => {
    const { result, before, after } = await guard(
      app,
      async () => {
        const text = await ocu.snapshot(app, { nodes: 3000 });
        return text;
      },
      { label: '读取 ' + app + ' 完成' }
    );
    return { app, nodes: countElements(result), before, after };
  });
}

async function main() {
  // 锁屏下 AX 不可用：不跳过会得到「节点 0 / 前台 (unknown)」还 exit 0，看着像全部正常
  if (await isScreenLocked()) {
    console.log(lockedSkipNotice('multi-app.mjs'));
    return;
  }
  await overlay.status('并行读取 ' + TARGETS.length + ' 个应用');
  const t0 = Date.now();

  const results = await Promise.allSettled(TARGETS.map((a) => probe(a)));

  for (const r of results) {
    if (r.status === 'fulfilled') {
      const v = r.value;
      console.log(v.app.padEnd(14), '节点', String(v.nodes).padStart(5), '| 前台', v.before, '→', v.after);
      await overlay.log(v.app + '：' + v.nodes + ' 个节点');
    } else {
      console.log('FAIL', String(r.reason).slice(0, 120));
      await overlay.log('失败：' + String(r.reason).slice(0, 80));
    }
  }

  const verdict = summarizeMultiApp(results, TARGETS.length);
  await overlay.status('并行完成：' + verdict.success + '/' + TARGETS.length + ' 个应用，用时 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
  console.log('用时', ((Date.now() - t0) / 1000).toFixed(1), 's');
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
