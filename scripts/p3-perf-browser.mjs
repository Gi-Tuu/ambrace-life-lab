#!/usr/bin/env node
// P3 加载/帧率验收（真实 Chrome via CDP pipe）。
//
// 量什么（全部写 evidence/redo-p3/）：
//   · cold survival 首帧：全新 Chrome、第一张页面就是 ?mode=survival，navigationStart → #cvA 首个 renderer=3d；
//   · warm title 首帧：同一 Chrome 再开 `/`（与 P0/P2c golden 的 third-scenario 热缓存口径一致）；
//   · cold title 首帧：再换一个全新 Chrome，第一张页面就是 `/`；
//   · 点「继续生存」→ 首帧：菜单就绪后真实 click 到 cvA 首帧；
//   · buildWorld：页面内 __lifeDebug.buildWorld 对 mapSeed 7/123456/654321 各冷跑一次，p50/max；
//   · 首屏请求：首帧那一刻 performance resource 条数（按 .mjs/.js/png/json/font 分类）；
//   · 室外移动帧率：真按键持续移动 4s（先热身 1s），rAF 间隔 p50/p95/max、>50ms 长帧数；
//   · CPU profile：cold survival 与 cold title 各采一份 V8 sampling profile，按 self time 聚合 top 函数。
//
// 环境：headless=new + --disable-gpu（与 P0/P2c golden 同口径；WebGL 走 SwiftShader，帧率不代表真机 GPU）。
// 本脚本只读仓库（启动 serve.mjs + Chrome），不改任何世界/仓库文件。
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromeGate } from '../life/chrome-gate.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = process.env.P3_PERF_OUT ? resolve(process.env.P3_PERF_OUT) : join(ROOT, 'evidence', 'redo-p3');
mkdirSync(OUT, { recursive: true });
const log = [];
const note = (kind, data = {}) => log.push({ at: new Date().toISOString(), kind, ...data });

const gate = chromeGate({ requireChrome: true });
if (gate.fail || !gate.path) throw new Error(gate.reason ?? '找不到 Chrome');
const CHROME = process.env.CHROME_PATH ?? gate.path;
const PORT = 9400 + (process.pid % 300);
const DATA = mkdtempSync(join(tmpdir(), 'p3-perf-data-'));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let server, chrome, cdp;

function startServer() {
  server = spawn(process.execPath, ['serve.mjs'], {
    cwd: ROOT,
    env: {
      ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: DATA,
      SEED_FILE: join(ROOT, 'seed', 'world.json'), GAME_MODE: 'game', GAME_RULES: '1',
      BRAIN: 'local', TICK_MS: '10000000', MODEL_UNATTENDED: '0', V73_TEST: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  server.stdout.on('data', (d) => { out += String(d); });
  server.stderr.on('data', (d) => { out += String(d); });
  return { ready: async () => {
    for (let i = 0; i < 150 && !out.includes('就绪'); i += 1) await wait(150);
    if (!out.includes('就绪')) throw new Error('服务未就绪：' + out.slice(0, 300));
  }, log: () => out };
}

// P3_GPU=1：不传 --disable-gpu（用真机 ANGLE/D3D；headless 下仍可能是 SwiftShader，按实际报）。
// 默认与 P0/P2c golden 同口径 --disable-gpu，便于逐位比较首帧。
const USE_GPU = process.env.P3_GPU === '1';
const CHROME_ARGS = [
  '--headless=new', ...(USE_GPU ? [] : ['--disable-gpu']), '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-pipe',
];
function startChrome() {
  const profile = mkdtempSync(join(tmpdir(), 'p3-perf-chrome-'));
  chrome = spawn(CHROME, [...CHROME_ARGS, `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
  const writeFd = chrome.stdio[3], readFd = chrome.stdio[4];
  let buf = '';
  cdp = { pending: new Map(), targets: [] };
  cdp.send = (method, params = {}, sessionId) => new Promise((res, rej) => {
    const id = (cdp.seq = (cdp.seq ?? 0) + 1);
    cdp.pending.set(id, { res, rej });
    writeFd.write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\u0000');
  });
  readFd.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    for (;;) {
      const end = buf.indexOf('\u0000');
      if (end < 0) return;
      const raw = buf.slice(0, end); buf = buf.slice(end + 1);
      if (!raw.trim()) continue;
      const msg = JSON.parse(raw);
      const p = cdp.pending.get(msg.id);
      if (p) { cdp.pending.delete(msg.id); msg.error ? p.rej(new Error(JSON.stringify(msg.error))) : p.res(msg.result); }
    }
  });
}

async function killChrome() {
  if (!chrome) return;
  try { chrome.kill(); } catch { /* 已退出 */ }
  await wait(700);
  chrome = null; cdp = null;
}

// 关掉本轮所有 page，避免上一页的 rAF/动画时钟在下一场景抢 CPU（否则 warm 首帧会被污染）。
async function closePages() {
  for (const targetId of cdp.targets.splice(0)) {
    try { await cdp.send('Target.closeTarget', { targetId }); } catch { /* 已关闭 */ }
  }
  await wait(300);
}

async function evaluate(expression, sessionId) {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true }, sessionId);
  if (r.exceptionDetails) throw new Error('JS 异常：' + r.exceptionDetails.text + ' ' + (r.result?.description ?? ''));
  return r.result.value;
}

async function waitFor(fn, ms = 30000, sid) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn(sid)) return true; await wait(120); }
  return false;
}

const PROBE = `(() => {
  const p = window.__p3 = { nav: performance.now(), marks: {}, longtasks: [], raf: [] };
  try { new PerformanceObserver((list) => { for (const e of list.getEntries()) p.longtasks.push([Math.round(e.startTime), Math.round(e.duration), e.name]); }).observe({ type: 'longtask', buffered: true }); } catch {}
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

async function newPage() {
  const target = await cdp.send('Target.createTarget', { url: 'about:blank' });
  cdp.targets.push(target.targetId);
  const attached = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
  const sid = attached.sessionId;
  await cdp.send('Page.enable', {}, sid);
  await cdp.send('Runtime.enable', {}, sid);
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: PROBE }, sid);
  return sid;
}

const percentile = (xs, q) => {  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return Number(s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))].toFixed(2));
};

function resourceFacts() {
  return `(() => {
    const rs = performance.getEntriesByType('resource').filter((r) => r.name.startsWith(location.origin));
    const by = {};
    for (const r of rs) { const k = (r.name.split('.').pop() || 'other').toLowerCase(); by[k] = (by[k] ?? 0) + 1; }
    return {
      count: rs.length, byExt: by,
      modules: rs.filter((r) => /\\.m?js$/.test(r.name)).length,
      png: rs.filter((r) => r.name.endsWith('.png')).length,
      names: rs.map((r) => [r.name.replace(location.origin, ''), Math.round(r.duration), r.transferSize || 0]).sort((a, b) => b[1] - a[1]),
    };
  })()`;
}

function profileSummary(profile, intervalUs) {
  const self = new Map();
  let total = 0;
  for (const n of profile.nodes) {
    const ms = (n.hitCount ?? 0) * intervalUs / 1000;
    total += ms;
    if (!ms) continue;
    const cf = n.callFrame ?? {};
    const url = String(cf.url ?? '').replace(`http://127.0.0.1:${PORT}`, '');
    const key = `${cf.functionName || '(anonymous)'} @ ${url}:${cf.lineNumber}`;
    self.set(key, (self.get(key) ?? 0) + ms);
  }
  return {
    totalMs: Number(total.toFixed(1)),
    top: [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([k, v]) => [k, Number(v.toFixed(1))]),
  };
}

// profile=false：纯计时（不采 CPU，避免采样开销影响首帧）；profile=true：采一份 V8 profile 归因。
async function capture(sid, url, waitKey, { profile = false } = {}) {
  if (profile) {
    await cdp.send('Profiler.enable', {}, sid);
    await cdp.send('Profiler.setSamplingInterval', { interval: 200 }, sid);
    await cdp.send('Profiler.start', {}, sid);
  }
  await cdp.send('Page.navigate', { url }, sid);
  const ok = await waitFor(async () => Boolean(await evaluate(`window.__p3?.marks?.[${JSON.stringify(waitKey)}] ?? null`, sid)), 40000, sid);
  if (!ok) throw new Error(`${waitKey} 首帧未渲染：` + (await evaluate('document.body.innerText.slice(0,300)', sid)));
  const first3d = await evaluate(`window.__p3.marks[${JSON.stringify(waitKey)}]`, sid);
  const raw = await evaluate(`(() => ({
    marks: window.__p3.marks, longtasks: window.__p3.longtasks,
    measures: performance.getEntriesByType('measure').map((m) => [m.name, Number(m.startTime.toFixed(1)), Number(m.duration.toFixed(1))]),
    renderers: { title: document.getElementById('startScene')?.dataset.renderer ?? null, a: document.getElementById('cvA')?.dataset.renderer ?? null },
    place: document.getElementById('placeHud')?.textContent ?? null, debug: Boolean(window.__lifeDebug),
    webgl: (() => { try { const c = document.createElement('canvas'); const g = c.getContext('webgl'); const d = g.getExtension('WEBGL_debug_renderer_info'); return d ? g.getParameter(d.UNMASKED_RENDERER_WEBGL) : 'unknown'; } catch { return null; } })(),
  }))()`, sid);
  const resources = await evaluate(resourceFacts(), sid);
  let prof = null;
  if (profile) {
    prof = await cdp.send('Profiler.stop', {}, sid);
    writeFileSync(join(OUT, `profile-${waitKey === 'renderer:cvA' ? 'survival' : 'title'}.json`), JSON.stringify(prof.profile));
  }
  return { first3d, raw, resources, summary: prof ? profileSummary(prof.profile, 200) : null };
}

const result = { at: new Date().toISOString(), node: process.version, port: PORT, env: { headless: true, gpu: USE_GPU, webgl: null }, scenarios: {} };
try {
  const srv = startServer();
  await srv.ready();
  note('server.ready', { port: PORT });

  // ── Chrome A：cold survival → warm title → 同一页做 buildWorld / fps / click→首帧 ──
  startChrome();
  {
    const sid = await newPage();
    const cap = await capture(sid, `http://127.0.0.1:${PORT}/?mode=survival`, 'renderer:cvA');
    result.scenarios.coldSurvival = {
      first3d: cap.first3d, longtasks: cap.raw.longtasks, measures: cap.raw.measures, renderers: cap.raw.renderers, place: cap.raw.place,
      webgl: cap.raw.webgl,
      resources: { count: cap.resources.count, byExt: cap.resources.byExt, modules: cap.resources.modules, png: cap.resources.png, names: cap.resources.names },
    };
    result.env.webgl = cap.raw.webgl;
    note('coldSurvival', result.scenarios.coldSurvival);

    // buildWorld 冷跑：同一页面内每个种子只跑一次（与 golden 口径一致）。
    result.buildWorld = await evaluate(`(async () => {
      const S = window.__lifeDebug.S, base = S.view, rows = [];
      for (const mapSeed of [7, 123456, 654321]) {
        const w = { ...base, mapSeed, layoutVersion: base.layoutVersion ?? 0 };
        const t0 = performance.now();
        window.__lifeDebug.buildWorld(w);
        rows.push({ mapSeed, ms: performance.now() - t0 });
      }
      return rows;
    })()`, sid);
    const cold = result.buildWorld.map((r) => r.ms);
    result.buildWorldSummary = {
      p50: percentile(cold, 0.5), max: Number(Math.max(...cold).toFixed(1)),
      rows: result.buildWorld.map((r) => ({ mapSeed: r.mapSeed, ms: Number(r.ms.toFixed(1)) })),
    };
    note('buildWorld', result.buildWorldSummary);

    // 室外移动帧率：先热身 1s，再按住 D 4s 采 rAF（headless SwiftShader，帧率不代表真机 GPU）。
    let place = await evaluate(`document.getElementById('placeHud')?.textContent ?? ''`, sid);
    if (!String(place).includes('户外')) {
      await evaluate(`fetch('/act',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({mode:'survival',kind:'camp_exit'})}).then(r=>r.json())`, sid);
      await wait(500);
      place = await evaluate(`document.getElementById('placeHud')?.textContent ?? ''`, sid);
    }
    await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown',{code:'KeyD',key:'d',bubbles:true}))`, sid);
    await wait(1000);
    await evaluate(`window.__p3.startRaf()`, sid);
    await wait(4000);
    const raf = await evaluate(`window.__p3.stopRaf()`, sid);
    await evaluate(`window.dispatchEvent(new KeyboardEvent('keyup',{code:'KeyD',key:'d',bubbles:true}))`, sid);
    const deltas = Array.isArray(raf) ? raf.filter((x) => x > 0) : [];
    const fps = deltas.length ? Number((1000 / (deltas.reduce((a, b) => a + b, 0) / deltas.length)).toFixed(1)) : null;
    result.fps = {
      place, frames: deltas.length, fps,
      p50ms: percentile(deltas, 0.5), p95ms: percentile(deltas, 0.95), maxMs: Number(Math.max(...deltas).toFixed(2)),
      longFrames50: deltas.filter((d) => d > 50).length,
      longFrames33: deltas.filter((d) => d > 33.4).length,
    };
    note('fps', result.fps);

    // warm title：同一 Chrome 的 HTTP 缓存已热（与 P0/P2c golden 的 title 第三场景同口径）。
    await closePages();
    const sidT = await newPage();
    const titleWarm = await capture(sidT, `http://127.0.0.1:${PORT}/`, 'renderer:startScene');
    result.scenarios.warmTitle = {
      first3d: titleWarm.first3d, longtasks: titleWarm.raw.longtasks, measures: titleWarm.raw.measures, renderers: titleWarm.raw.renderers,
      resources: { count: titleWarm.resources.count, byExt: titleWarm.resources.byExt, modules: titleWarm.resources.modules, png: titleWarm.resources.png, names: titleWarm.resources.names },
    };
    note('warmTitle', result.scenarios.warmTitle);

    // 点「继续生存」→ 首帧（菜单就绪后点击；缓存热）。
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` }, sidT);
    await waitFor(async () => Boolean(await evaluate(`window.__lifeDebug?.S?.view && !document.getElementById('startSurvival').disabled`, sidT)), 30000, sidT);
    const clickAt = await evaluate(`(() => { window.__p3.marks.click = performance.now(); document.getElementById('startSurvival').click(); return window.__p3.marks.click; })()`, sidT);
    const rendered = await waitFor(async () => Boolean(await evaluate(`window.__p3?.marks?.['renderer:cvA'] ?? null`, sidT)), 30000, sidT);
    result.clickToFirstFrame = {
      ok: rendered,
      clickAt: Number(clickAt.toFixed(1)),
      first3d: rendered ? Number((await evaluate(`window.__p3.marks['renderer:cvA']`, sidT)).toFixed(1)) : null,
      deltaMs: rendered ? Number(((await evaluate(`window.__p3.marks['renderer:cvA']`, sidT)) - clickAt).toFixed(1)) : null,
      place: await evaluate(`document.getElementById('placeHud')?.textContent ?? null`, sidT),
    };
    note('clickToFirstFrame', result.clickToFirstFrame);
  }
  await killChrome();

  // ── Chrome B：cold title（全新 profile，无 HTTP 缓存）──
  startChrome();
  {
    const sid = await newPage();
    const cap = await capture(sid, `http://127.0.0.1:${PORT}/`, 'renderer:startScene');
    result.scenarios.coldTitle = {
      first3d: cap.first3d, longtasks: cap.raw.longtasks, measures: cap.raw.measures, renderers: cap.raw.renderers,
      resources: { count: cap.resources.count, byExt: cap.resources.byExt, modules: cap.resources.modules, png: cap.resources.png, names: cap.resources.names },
    };
    note('coldTitle', result.scenarios.coldTitle);
  }
  await killChrome();

  // ── Chrome C：CPU profile（cold title，与 Chrome B 同口径）──
  startChrome();
  {
    const sid = await newPage();
    const cap = await capture(sid, `http://127.0.0.1:${PORT}/`, 'renderer:startScene', { profile: true });
    result.profiles = { title: cap.summary };
    note('profile.title', cap.summary);
  }
  await killChrome();

  // ── Chrome D：CPU profile（cold survival）──
  startChrome();
  {
    const sid = await newPage();
    const cap = await capture(sid, `http://127.0.0.1:${PORT}/?mode=survival`, 'renderer:cvA', { profile: true });
    result.profiles.survival = cap.summary;
    note('profile.survival', cap.summary);
  }
  await killChrome();

  result.ok = true;
  console.log('[p3-perf] PASS', JSON.stringify({
    coldSurvival: { first3d: Number(result.scenarios.coldSurvival.first3d.toFixed(1)), requests: result.scenarios.coldSurvival.resources.count },
    warmTitle: { first3d: Number(result.scenarios.warmTitle.first3d.toFixed(1)), requests: result.scenarios.warmTitle.resources.count },
    coldTitle: { first3d: Number(result.scenarios.coldTitle.first3d.toFixed(1)), requests: result.scenarios.coldTitle.resources.count },
    buildWorld: result.buildWorldSummary,
    fps: result.fps,
    clickToFirstFrame: result.clickToFirstFrame,
  }));
} catch (error) {
  result.ok = false;
  result.error = String(error?.stack ?? error);
  console.error('[p3-perf] FAIL', error);
  process.exitCode = 1;
} finally {
  await killChrome();
  try { server?.kill(); } catch {}
  writeFileSync(join(OUT, 'perf.json'), JSON.stringify(result, null, 2) + '\n');
  writeFileSync(join(OUT, 'perf.log'), log.map((row) => JSON.stringify(row)).join('\n') + '\n');
  console.log(`[p3-perf] wrote ${join(OUT, 'perf.json')}`);
}
