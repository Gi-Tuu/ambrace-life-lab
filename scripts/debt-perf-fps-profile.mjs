#!/usr/bin/env node
// 债务-性能：室外移动帧率的归因探针（只读，不改仓库/世界文件）。
//
// 在 p3-perf-browser.mjs 的同口径环境（headless=new + --disable-gpu / SwiftShader）里：
//   1) 进 survival 首帧 → 出营地 → 按住 D 热身 1s；
//   2) 采 4s rAF 间隔 + V8 CPU profile（200µs 采样）；
//   3) 再采 4s Chrome tracing（devtools.timeline + GPUTask），把主线程 / 光栅线程的
//      Rasterize / Paint / Layout / GPUTask 等时长按事件名求和。
// 输出 evidence/debt-perf/fps-profile.json，供报告归因（不是验收闸门）。
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCdpHarness } from './lib/cdp-harness.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = process.env.DEBT_PERF_OUT ? resolve(process.env.DEBT_PERF_OUT) : join(ROOT, 'evidence', 'debt-perf');
mkdirSync(OUT, { recursive: true });

const h = createCdpHarness({
  root: ROOT,
  port: 9500 + (process.pid % 200),
  dataPrefix: 'debt-perf-fps-data-',
  profilePrefix: 'debt-perf-fps-chrome-',
  chromeArgs: ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-pipe'],
  serverEnv: {
    GAME_MODE: 'game', GAME_RULES: '1', BRAIN: 'local', TICK_MS: '10000000',
    MODEL_UNATTENDED: '0', V73_TEST: '1',
  },
  readyAttempts: 150,
  waitMs: 30000,
  waitIntervalMs: 120,
});
const wait = h.wait;

const PROBE = `(() => {
  const p = window.__p3 = { marks: {}, raf: [] };
  const watch = () => {
    for (const id of ['cvA','cvB','startScene']) {
      const cv = document.getElementById(id);
      if (!cv) continue;
      const check = () => { if (cv.dataset.renderer && !p.marks['renderer:' + id]) p.marks['renderer:' + id] = performance.now(); };
      check();
      new MutationObserver(check).observe(cv, { attributes: true, attributeFilter: ['data-renderer'] });
    }
  };
  document.addEventListener('DOMContentLoaded', watch);
  p.startRaf = () => {
    p.raf = []; let last = performance.now();
    const tick = (now) => { p.raf.push(now - last); last = now; p.rafId = requestAnimationFrame(tick); };
    p.rafId = requestAnimationFrame(tick);
  };
  p.stopRaf = () => { cancelAnimationFrame(p.rafId); return p.raf.slice(1); };
})();`;

const percentile = (xs, q) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return Number(s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))].toFixed(2));
};

function profileSummary(profile, intervalUs) {
  const self = new Map(), chains = new Map(), parent = new Map();
  for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  let total = 0;
  for (const n of profile.nodes) {
    const ms = (n.hitCount ?? 0) * intervalUs / 1000;
    total += ms;
    if (!ms) continue;
    const cf = n.callFrame ?? {};
    const url = String(cf.url ?? '').replace(`http://127.0.0.1:${h.port}`, '');
    const key = `${cf.functionName || '(anonymous)'} @ ${url}:${cf.lineNumber}`;
    self.set(key, (self.get(key) ?? 0) + ms);
    // 调用链归因：自身 → 父 → 祖父（最多 4 层），看清 rawHeight/sight 是被谁按帧调用的。
    const chain = [key];
    let p = parent.get(n.id);
    for (let i = 0; i < 3 && p != null; i += 1) {
      const pcf = byId.get(p)?.callFrame ?? {};
      chain.push(`${pcf.functionName || '(anonymous)'}@${String(pcf.url ?? '').replace(`http://127.0.0.1:${h.port}`, '').split('/').pop()}:${pcf.lineNumber}`);
      p = parent.get(p);
    }
    const ck = chain.join(' <- ');
    chains.set(ck, (chains.get(ck) ?? 0) + ms);
  }
  return {
    totalMs: Number(total.toFixed(1)),
    top: [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40).map(([k, v]) => [k, Number(v.toFixed(1))]),
    chains: [...chains.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([k, v]) => [k, Number(v.toFixed(1))]),
  };
}

// tracing 里同一事件的 duration 是 µs；按 name 聚合（含主线程与 raster/GPU 线程）。
function traceSummary(events) {
  const by = new Map();
  for (const e of events) {
    if (e.ph !== 'X' || !Number.isFinite(e.dur)) continue;
    const key = `${e.name}${e.tid != null ? '@' + e.tid : ''}`;
    by.set(key, (by.get(key) ?? 0) + e.dur / 1000);
  }
  return [...by.entries()].filter(([, ms]) => ms >= 5).sort((a, b) => b[1] - a[1])
    .slice(0, 40).map(([k, ms]) => [k, Number(ms.toFixed(1))]);
}

const result = { at: new Date().toISOString(), node: process.version, env: { headless: true, gpu: false }, ok: false };
let sid;
try {
  await h.startServer();
  h.startChrome();
  sid = await h.newPage({ probe: PROBE });
  await h.send('Page.navigate', { url: `http://127.0.0.1:${h.port}/?mode=survival` }, sid);
  const ok = await h.waitFor(async () => Boolean(await h.evaluate(`window.__p3?.marks?.['renderer:cvA'] ?? null`, sid)), 40000, sid);
  if (!ok) throw new Error('首帧未渲染');
  result.webgl = await h.evaluate(`(() => { try { const c=document.createElement('canvas'); const g=c.getContext('webgl'); const d=g.getExtension('WEBGL_debug_renderer_info'); return d?g.getParameter(d.UNMASKED_RENDERER_WEBGL):'unknown'; } catch { return null; } })()`, sid);
  let place = await h.evaluate(`document.getElementById('placeHud')?.textContent ?? ''`, sid);
  if (!String(place).includes('户外')) {
    await h.evaluate(`fetch('/act',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({mode:'survival',kind:'camp_exit'})}).then(r=>r.json())`, sid);
    await wait(600);
    place = await h.evaluate(`document.getElementById('placeHud')?.textContent ?? ''`, sid);
  }
  result.place = place;
  await h.evaluate(`window.dispatchEvent(new KeyboardEvent('keydown',{code:'KeyD',key:'d',bubbles:true}))`, sid);
  await wait(1000);

  // 1) rAF + CPU profile
  await h.send('Profiler.enable', {}, sid);
  await h.send('Profiler.setSamplingInterval', { interval: 200 }, sid);
  await h.evaluate(`window.__p3.startRaf()`, sid);
  await h.send('Profiler.start', {}, sid);
  await wait(4000);
  const prof = await h.send('Profiler.stop', {}, sid);
  const raf = await h.evaluate(`window.__p3.stopRaf()`, sid);
  const deltas = Array.isArray(raf) ? raf.filter((x) => x > 0) : [];
  result.fps = {
    frames: deltas.length,
    fps: deltas.length ? Number((1000 / (deltas.reduce((a, b) => a + b, 0) / deltas.length)).toFixed(1)) : null,
    p50ms: percentile(deltas, 0.5), p95ms: percentile(deltas, 0.95),
    maxMs: deltas.length ? Number(Math.max(...deltas).toFixed(2)) : null,
    longFrames50: deltas.filter((d) => d > 50).length,
  };
  result.cpu = profileSummary(prof.profile, 200);
  writeFileSync(join(OUT, 'fps-profile-cpu.json'), JSON.stringify(prof.profile));
  result.cpuPerFrameMs = result.fps.frames ? Number((result.cpu.totalMs / result.fps.frames).toFixed(2)) : null;

  await h.evaluate(`window.dispatchEvent(new KeyboardEvent('keyup',{code:'KeyD',key:'d',bubbles:true}))`, sid);
  result.ok = true;
  writeFileSync(join(OUT, 'fps-profile.json'), JSON.stringify(result, null, 2) + '\n');
  console.log('[debt-perf-fps]', JSON.stringify({ place: result.place, fps: result.fps, cpuPerFrameMs: result.cpuPerFrameMs, top: result.cpu.top.slice(0, 10), chains: result.cpu.chains.slice(0, 12) }, null, 1));
} catch (error) {
  result.error = String(error?.stack ?? error);
  writeFileSync(join(OUT, 'fps-profile.json'), JSON.stringify(result, null, 2) + '\n');
  console.error('[debt-perf-fps] FAIL', error);
  process.exitCode = 1;
} finally {
  await h.killChrome({ settleMs: 500 });
  await h.stopServer({ settleMs: 0 });
}
