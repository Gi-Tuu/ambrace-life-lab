#!/usr/bin/env node
// 债务-性能迭代探针：只量闸门相关的首帧 + 室外帧率，重复 N 轮取中位数。
// 与 p3-perf-browser.mjs 同口径（headless=new + --disable-gpu / SwiftShader，全新 profile 冷启）。
// 用途：改一版就快速看方向；最终闸门仍以 scripts/p3-perf-browser.mjs 为准。
//   DEBT_PERF_REPS=3 node scripts/debt-perf-first-frame.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCdpHarness } from './lib/cdp-harness.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = process.env.DEBT_PERF_OUT ? resolve(process.env.DEBT_PERF_OUT) : join(ROOT, 'evidence', 'debt-perf');
mkdirSync(OUT, { recursive: true });
const LABEL = process.env.DEBT_PERF_LABEL ?? 'iter';
const REPS = Math.max(1, Number(process.env.DEBT_PERF_REPS ?? 3));
// 可选：给两个场景追加同一段 query（如 '&firstScale=1'），用于同 harness 的 A/B。
const EXTRA = process.env.DEBT_PERF_QUERY ?? '';

const h = createCdpHarness({
  root: ROOT,
  port: 9600 + (process.pid % 200),
  dataPrefix: 'debt-perf-ff-data-',
  profilePrefix: 'debt-perf-ff-chrome-',
  chromeArgs: ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-pipe'],
  serverEnv: {
    GAME_MODE: 'game', GAME_RULES: '1', BRAIN: 'local', TICK_MS: '10000000',
    MODEL_UNATTENDED: '0', V73_TEST: '1',
  },
  readyAttempts: 150,
  waitMs: 30000,
  waitIntervalMs: 100,
});
const wait = h.wait;

const PROBE = `(() => {
  if (new URLSearchParams(location.search).has('perfseg')) window.__perfSeg = [];
  const p = window.__p3 = { marks: {}, raf: [] };
  try { new PerformanceObserver((list) => { for (const e of list.getEntries()) (p.longtasks ??= []).push([Math.round(e.startTime), Math.round(e.duration), e.name]); }).observe({ type: 'longtask', buffered: true }); } catch {}
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
const median = (xs) => percentile(xs, 0.5);

const result = { label: LABEL, at: new Date().toISOString(), node: process.version, reps: REPS, env: { headless: true, gpu: false }, runs: [], ok: false };
try {
  await h.startServer();
  for (let i = 0; i < REPS; i += 1) {
    h.startChrome();
    const sid = await h.newPage({ probe: PROBE });
    const t0 = Date.now();
    await h.send('Page.navigate', { url: `http://127.0.0.1:${h.port}/?mode=survival${EXTRA}` }, sid);
    const ok = await h.waitFor(async () => Boolean(await h.evaluate(`window.__p3?.marks?.['renderer:cvA'] ?? null`, sid)), 40000, sid);
    if (!ok) throw new Error('survival 首帧未渲染');
    const coldSurvival = await h.evaluate(`window.__p3.marks['renderer:cvA']`, sid);
    const webgl = await h.evaluate(`(() => { try { const c=document.createElement('canvas'); const g=c.getContext('webgl'); const d=g.getExtension('WEBGL_debug_renderer_info'); return d?g.getParameter(d.UNMASKED_RENDERER_WEBGL):'unknown'; } catch { return null; } })()`, sid);
    const requests = await h.evaluate(`performance.getEntriesByType('resource').filter(r=>r.name.startsWith(location.origin)).length`, sid);
    const run = { i, coldSurvival: Number(coldSurvival.toFixed(1)), requests, webgl };
    if (EXTRA.includes('perfseg')) run.seg = await h.evaluate(`window.__perfSeg ?? null`, sid);

    // 同 Chrome 热缓存下的标题首帧（与 p3 的 warmTitle 同口径：新 page，HTTP 缓存热）。
    await h.closePages();
    const sidT = await h.newPage({ probe: PROBE });
    await h.send('Page.navigate', { url: `http://127.0.0.1:${h.port}/${EXTRA ? '?' + EXTRA.slice(1) : ''}` }, sidT);
    const okT = await h.waitFor(async () => Boolean(await h.evaluate(`window.__p3?.marks?.['renderer:startScene'] ?? null`, sidT)), 40000, sidT);
    if (!okT) throw new Error('warm title 首帧未渲染');
    run.warmTitle = Number((await h.evaluate(`window.__p3.marks['renderer:startScene']`, sidT)).toFixed(1));
    if (EXTRA.includes('perfseg')) run.titleSeg = await h.evaluate(`window.__perfSeg ?? null`, sidT);

    // 帧率只在第一轮量（避免后面轮次的负载/热量偏差）。
    if (i === 0) {
      await h.send('Page.navigate', { url: `http://127.0.0.1:${h.port}/?mode=survival${EXTRA}` }, sidT);
      await h.waitFor(async () => Boolean(await h.evaluate(`window.__p3?.marks?.['renderer:cvA'] ?? null`, sidT)), 40000, sidT);
      let place = await h.evaluate(`document.getElementById('placeHud')?.textContent ?? ''`, sidT);
      if (!String(place).includes('户外')) {
        await h.evaluate(`fetch('/act',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({mode:'survival',kind:'camp_exit'})}).then(r=>r.json())`, sidT);
        await wait(500);
        place = await h.evaluate(`document.getElementById('placeHud')?.textContent ?? ''`, sidT);
      }
      await h.evaluate(`window.dispatchEvent(new KeyboardEvent('keydown',{code:'KeyD',key:'d',bubbles:true}))`, sidT);
      await wait(1000);
      await h.evaluate(`window.__p3.startRaf()`, sidT);
      await wait(4000);
      const raf = await h.evaluate(`window.__p3.stopRaf()`, sidT);
      await h.evaluate(`window.dispatchEvent(new KeyboardEvent('keyup',{code:'KeyD',key:'d',bubbles:true}))`, sidT);
      const deltas = Array.isArray(raf) ? raf.filter((x) => x > 0) : [];
      run.fps = {
        place, frames: deltas.length,
        fps: deltas.length ? Number((1000 / (deltas.reduce((a, b) => a + b, 0) / deltas.length)).toFixed(1)) : null,
        p50ms: percentile(deltas, 0.5), p95ms: percentile(deltas, 0.95),
        maxMs: deltas.length ? Number(Math.max(...deltas).toFixed(2)) : null,
        longFrames50: deltas.filter((d) => d > 50).length,
      };
    }
    run.wallMs = Date.now() - t0;
    result.runs.push(run);
    console.log(`[debt-perf-ff] rep ${i + 1}/${REPS}`, JSON.stringify(run));
    await h.killChrome({ settleMs: 500 });
  }
  const med = (key) => median(result.runs.map((r) => r[key]));
  result.summary = {
    coldSurvival: { median: med('coldSurvival'), all: result.runs.map((r) => r.coldSurvival) },
    warmTitle: { median: med('warmTitle'), all: result.runs.map((r) => r.warmTitle) },
    requests: med('requests'),
    fps: result.runs[0]?.fps ?? null,
  };
  result.ok = true;
  writeFileSync(join(OUT, `first-frame-${LABEL}.json`), JSON.stringify(result, null, 2) + '\n');
  console.log('[debt-perf-ff]', JSON.stringify(result.summary));
} catch (error) {
  result.error = String(error?.stack ?? error);
  writeFileSync(join(OUT, `first-frame-${LABEL}.json`), JSON.stringify(result, null, 2) + '\n');
  console.error('[debt-perf-ff] FAIL', error);
  process.exitCode = 1;
} finally {
  await h.killChrome({ settleMs: 300 });
  await h.stopServer({ settleMs: 0 });
}
