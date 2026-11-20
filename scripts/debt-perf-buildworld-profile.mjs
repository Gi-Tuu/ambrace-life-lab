#!/usr/bin/env node
// 债务-性能：buildWorld 归因探针（只读）。
// 在真实页面里对 5 个未缓存的 mapSeed 各跑一次 buildWorld，同时采 V8 CPU profile，
// 按 self time + 调用链聚合，找出 buildWorld 内部真正的热点（用于针对性优化，不改测量口径）。
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCdpHarness } from './lib/cdp-harness.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = process.env.DEBT_PERF_OUT ? resolve(process.env.DEBT_PERF_OUT) : join(ROOT, 'evidence', 'debt-perf');
mkdirSync(OUT, { recursive: true });
const h = createCdpHarness({
  root: ROOT, port: 9800 + (process.pid % 120),
  dataPrefix: 'debt-perf-bw-data-', profilePrefix: 'debt-perf-bw-chrome-',
  chromeArgs: ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-pipe'],
  serverEnv: { GAME_MODE: 'game', GAME_RULES: '1', BRAIN: 'local', TICK_MS: '10000000', MODEL_UNATTENDED: '0', V73_TEST: '1' },
  readyAttempts: 150, waitMs: 30000, waitIntervalMs: 120,
});
const percentile = (xs, q) => {
  const s = [...xs].sort((a, b) => a - b);
  return Number(s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))].toFixed(1));
};
function summarize(profile, intervalUs) {
  const self = new Map(), chains = new Map(), parent = new Map();
  for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  let total = 0;
  for (const n of profile.nodes) {
    const ms = (n.hitCount ?? 0) * intervalUs / 1000;
    total += ms;
    if (!ms) continue;
    const cf = n.callFrame ?? {};
    const key = `${cf.functionName || '(anon)'} @ ${String(cf.url ?? '').replace(/.*AMBRACElife/, '')}:${cf.lineNumber}`;
    self.set(key, (self.get(key) ?? 0) + ms);
    const chain = [key]; let p = parent.get(n.id);
    for (let i = 0; i < 4 && p != null; i += 1) {
      const pc = byId.get(p)?.callFrame ?? {};
      chain.push(`${pc.functionName || '(anon)'}@${String(pc.url ?? '').split('/').pop()}:${pc.lineNumber}`);
      p = parent.get(p);
    }
    const ck = chain.join(' <- ');
    chains.set(ck, (chains.get(ck) ?? 0) + ms);
  }
  return {
    totalMs: Number(total.toFixed(1)),
    top: [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([k, v]) => [k, Number(v.toFixed(1))]),
    chains: [...chains.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([k, v]) => [k, Number(v.toFixed(1))]),
  };
}
const result = { at: new Date().toISOString(), ok: false };
try {
  await h.startServer();
  h.startChrome();
  const sid = await h.newPage();
  await h.send('Page.navigate', { url: `http://127.0.0.1:${h.port}/?mode=survival` }, sid);
  const ok = await h.waitFor(async () => Boolean(await h.evaluate(`document.getElementById('cvA')?.dataset.renderer`, sid)), 40000, sid);
  if (!ok) throw new Error('首帧未渲染');
  await h.send('Profiler.enable', {}, sid);
  await h.send('Profiler.setSamplingInterval', { interval: 100 }, sid);
  await h.send('Profiler.start', {}, sid);
  const rows = await h.evaluate(`(() => {
    const S=window.__lifeDebug.S, base=S.view, out=[];
    for (const mapSeed of [11,22,33,44,55]) {
      const w={...base,mapSeed,layoutVersion:base.layoutVersion??0};
      const t0=performance.now(); window.__lifeDebug.buildWorld(w); out.push(Number((performance.now()-t0).toFixed(1)));
    }
    return out;
  })()`, sid);
  const prof = await h.send('Profiler.stop', {}, sid);
  result.buildWorldMs = rows;
  result.buildWorld = { p50: percentile(rows, .5), max: Math.max(...rows) };
  result.cpu = summarize(prof.profile, 100);
  result.ok = true;
  writeFileSync(join(OUT, 'buildworld-profile.json'), JSON.stringify(result, null, 2) + '\n');
  writeFileSync(join(OUT, 'buildworld-profile-cpu.json'), JSON.stringify(prof.profile));
  console.log('[bw-profile]', JSON.stringify({ buildWorld: result.buildWorld, top: result.cpu.top.slice(0, 14), chains: result.cpu.chains.slice(0, 10) }, null, 1));
} catch (error) {
  result.error = String(error?.stack ?? error);
  writeFileSync(join(OUT, 'buildworld-profile.json'), JSON.stringify(result, null, 2) + '\n');
  console.error('[bw-profile] FAIL', error);
  process.exitCode = 1;
} finally {
  await h.killChrome({ settleMs: 400 });
  await h.stopServer({ settleMs: 0 });
}
