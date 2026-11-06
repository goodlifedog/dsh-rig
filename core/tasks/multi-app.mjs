import { ocu, overlay, guard, withAppLock, countElements } from '../agentd.mjs';

// 同时控制两个应用：每个应用独立加锁，互不阻塞。
const TARGETS = (process.env.TARGETS || 'Finder,Calculator').split(',').map((s) => s.trim());

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

  const ok = results.filter((r) => r.status === 'fulfilled').length;
  await overlay.status('并行完成：' + ok + '/' + TARGETS.length + ' 个应用，用时 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
  console.log('用时', ((Date.now() - t0) / 1000).toFixed(1), 's');
}

main().catch((e) => {
  console.error('FAIL:', e.message);
  process.exit(1);
});
