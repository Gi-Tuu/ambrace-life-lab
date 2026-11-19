#!/usr/bin/env node
// P0 金样：同一台机器、同一份 seed，采集改前/改后的可逐位对比基线。
//
// 用法：
//   node scripts/redo-p0-golden.mjs --label before
//   node scripts/redo-p0-golden.mjs --label after
// 输出：evidence/redo-p0/<label>.json + evidence/redo-p0/<label>-{survival,compare,title}.png
//
// 口径：
//   · buildWorld 用页面内 __lifeDebug.buildWorld，固定 mapSeed（0/7/123456）各跑一次，取 performance.now 差值；
//   · 首个 3D 帧由注入的 MutationObserver 记录（dataset.renderer 第一次变成 3d 的 performance.now）；
//   · walk/movementWalk/terrainWalk3d/assetWalk/scene3d/trees/bridges 全部取 sha256，改前改后必须逐位相同；
//   · 截图在 Emulation prefers-reduced-motion=reduce 下取（渲染时钟固定为 0），另对 canvas.toDataURL 取 sha256；
//   · 资源数/字节取 performance.getEntriesByType('resource')，缓存头由 Node 侧 HEAD/GET 复核。
// 本脚本只读仓库（启动 serve.mjs + Chrome），不改任何文件。
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromeGate } from '../life/chrome-gate.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const labelArg = (() => {
  const eq = process.argv.find((a) => a.startsWith('--label='));
  if (eq) return eq.split('=')[1];
  const i = process.argv.indexOf('--label');
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : 'before';
})();
const OUT = join(ROOT, 'evidence', 'redo-p0');
mkdirSync(OUT, { recursive: true });

const gate = chromeGate({ requireChrome: true });
if (gate.fail || !gate.path) throw new Error(gate.reason ?? '找不到 Chrome');
const CHROME = process.env.CHROME_PATH ?? gate.path;
const PORT = 9200 + (process.pid % 300);
const DATA = mkdtempSync(join(tmpdir(), 'redo-p0-data-'));
const PROFILE = mkdtempSync(join(tmpdir(), 'redo-p0-chrome-'));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let server, chrome, cdp;

function startServer() {
  server = spawn(process.execPath, ['serve.mjs'], {
    cwd: ROOT,
    env: {
      ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: DATA,
      SEED_FILE: join(ROOT, 'seed', 'world.json'), BRAIN: 'local', TICK_MS: '10000000',
      MODEL_UNATTENDED: '0', V73_TEST: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  server.stdout.on('data', (d) => { out += String(d); });
  server.stderr.on('data', (d) => { out += String(d); });
  return { ready: async () => {
    for (let i = 0; i < 150 && !out.includes('就绪'); i += 1) await wait(150);
    if (!out.includes('就绪')) throw new Error('服务未就绪：' + out.slice(0, 400));
  }, log: () => out };
}

function startChrome() {
  chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-pipe', `--user-data-dir=${PROFILE}`, 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
  const writeFd = chrome.stdio[3], readFd = chrome.stdio[4];
  let buf = '';
  cdp = { pending: new Map() };
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

async function evaluate(expression, sessionId) {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true }, sessionId);
  if (r.exceptionDetails) throw new Error('JS 异常：' + r.exceptionDetails.text + ' ' + (r.result?.description ?? ''));
  return r.result.value;
}

const PROBE = `(() => {
  window.__p0 = { first3d: null, renderer: null, longtasks: [] };
  try { new PerformanceObserver((list) => { for (const e of list.getEntries()) window.__p0.longtasks.push([Math.round(e.startTime), Math.round(e.duration)]); }).observe({ type: 'longtask', buffered: true }); } catch {}
  const watch = () => {
    for (const id of ['cvA','cvB','startScene']) {
      const cv = document.getElementById(id);
      if (!cv) continue;
      const check = () => {
        const v = cv.dataset.renderer;
        if (!v) return;
        window.__p0.renderer = window.__p0.renderer || v;
        if (window.__p0.first3d === null) window.__p0.first3d = performance.now();
      };
      check();
      new MutationObserver(check).observe(cv, { attributes: true, attributeFilter: ['data-renderer'] });
    }
  };
  document.addEventListener('DOMContentLoaded', watch);
})();`;

async function newPage() {
  const target = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const attached = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
  const sid = attached.sessionId;
  await cdp.send('Page.enable', {}, sid);
  await cdp.send('Runtime.enable', {}, sid);
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] }, sid);
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: PROBE }, sid);
  return sid;
}

async function waitFor(fn, ms = 30000, sid) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn(sid)) return true;
    await wait(120);
  }
  return false;
}

const sha = (s) => createHash('sha256').update(s).digest('hex');

async function settleWorlds(sid) {
  // 冻结居民行走器，避免截图受“抓帧时刻”影响（只改页面内表现层状态）。
  await evaluate(`(() => { for (const w of Object.values(window.__lifeDebug.WALK ?? {})) { if (w.path) w.pi = w.path.length; } return true; })()`, sid);
  await wait(350);
}

async function canvasHash(sid, id) {
  return evaluate(`(() => { const cv = document.getElementById(${JSON.stringify(id)}); return cv ? cv.toDataURL('image/png') : null; })()`, sid).then((u) => (u ? sha(u) : null));
}

async function screenshot(sid, file) {
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }, sid);
  writeFileSync(join(OUT, file), Buffer.from(shot.data, 'base64'));
}

async function measureWorlds(sid) {
  return evaluate(`(async () => {
    const hex = async (u8) => {
      if (!u8) return null;
      const d = new Uint8Array(await crypto.subtle.digest('SHA-256', u8));
      return [...d].map((b) => b.toString(16).padStart(2, '0')).join('');
    };
    const jsonHex = async (v) => hex(new TextEncoder().encode(JSON.stringify(v)));
    const S = window.__lifeDebug.S;
    const base = S.view;
    const runs = [];
    for (const mapSeed of [0, 7, 123456, 654321]) {
      const w = { ...base, mapSeed, layoutVersion: base.layoutVersion ?? 0 };
      const t0 = performance.now();
      const world = window.__lifeDebug.buildWorld(w);
      const ms = performance.now() - t0;
      runs.push({
        mapSeed,
        buildWorldMs: Math.round(ms * 10) / 10,
        walk: await hex(world.walk),
        movementWalk: await hex(world.movementWalk),
        terrainWalk3d: await hex(world.terrainWalk3d),
        assetWalk: await hex(world.assetWalk),
        trees: await jsonHex(world.trees),
        bridges: await jsonHex(world.bridges),
        blockers: await jsonHex([...world.blockers].sort()),
        grassPlots: world.scene3d?.fxs?.length ?? null,
        scene3d: await jsonHex({
          boxes: world.scene3d?.boxes?.length ?? null,
          floors: world.scene3d?.floors?.length ?? null,
          fxs: world.scene3d?.fxs?.length ?? null,
          chimneys: world.scene3d?.chimneys ?? null,
        }),
        counts: {
          blockers: world.blockers.size, trees: world.trees.length, bridges: world.bridges.length,
          wildlife: world.wildlife.length, lifeLayers: world.lifeLayers.size,
        },
      });
    }
    return { runs, kindsHash: window.__terrainKindsHashes?.slice(-4) ?? null };
  })()`, sid);
}

async function resourceFacts(sid) {
  return evaluate(`(() => {
    const rs = performance.getEntriesByType('resource').filter((r) => r.name.startsWith(location.origin));
    return {
      count: rs.length,
      transferBytes: Math.round(rs.reduce((a, r) => a + (r.transferSize || 0), 0)),
      encodedBytes: Math.round(rs.reduce((a, r) => a + (r.encodedBodySize || 0), 0)),
      assetCount: rs.filter((r) => r.name.includes('/assets/')).length,
      pngCount: rs.filter((r) => r.name.endsWith('.png')).length,
      slowest: rs.map((r) => [r.name.replace(location.origin, ''), Math.round(r.duration)]).sort((a, b) => b[1] - a[1]).slice(0, 8),
    };
  })()`, sid);
}

async function pageFacts(sid) {
  return evaluate(`(() => {
    const cvA = document.getElementById('cvA'), cvB = document.getElementById('cvB'), title = document.getElementById('startScene');
    return {
      rendererA: cvA?.dataset.renderer ?? null,
      rendererB: cvB?.dataset.renderer ?? null,
      rendererTitle: title?.dataset.renderer ?? null,
      debugA: cvA?._debug ?? null,
      debugB: cvB?._debug ?? null,
      first3d: window.__p0?.first3d ?? null,
      longtasks: window.__p0?.longtasks ?? [],
      menuDisabled: { survival: document.getElementById('startSurvival')?.disabled, newGame: document.getElementById('startNew')?.disabled, compare: document.getElementById('startCompare')?.disabled },
    };
  })()`, sid);
}

async function headers() {
  const get = (p, extra = {}) => fetch(`http://127.0.0.1:${PORT}${p}`, { headers: extra });
  const out = {};
  for (const p of ['/web/app.js', '/web/assets/manifest.json', '/web/assets/terrain_grass0.png', '/shared/camp-layout.mjs']) {
    const r = await get(p);
    const etag = r.headers.get('etag');
    const body = await r.arrayBuffer();
    const revalidate = etag ? await get(p, { 'if-none-match': etag }) : null;
    out[p] = {
      status: r.status,
      cacheControl: r.headers.get('cache-control'),
      etag,
      contentEncoding: r.headers.get('content-encoding'),
      bytes: body.byteLength,
      revalidateStatus: revalidate?.status ?? null,
      revalidateBytes: revalidate ? (await revalidate.arrayBuffer()).byteLength : null,
    };
  }
  const immutable = await get('/web/assets/terrain_grass0.png?v=0123456789ab');
  out.immutableProbe = { status: immutable.status, cacheControl: immutable.headers.get('cache-control') };
  return out;
}

const result = { label: labelArg, at: new Date().toISOString(), node: process.version, port: PORT, scenarios: {} };
try {
  const srv = startServer();
  await srv.ready();
  startChrome();
  result.cache = await headers();

  // ── survival ──────────────────────────────────────────────
  {
    const sid = await newPage();
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?mode=survival` }, sid);
    const ok = await waitFor(async () => Boolean(await evaluate('!!window.__lifeDebug', sid)), 30000, sid);
    if (!ok) throw new Error('survival 页面未就绪：' + (await evaluate('document.body.innerText.slice(0,300)', sid)));
    const rendered = await waitFor(async () => Boolean(await evaluate("document.getElementById('cvA')?.dataset.renderer", sid)), 40000, sid);
    if (!rendered) throw new Error('survival 首帧未渲染：' + JSON.stringify(await evaluate("({notice:document.getElementById('playNoticeText')?.textContent, status:document.getElementById('startStatus')?.textContent, inner:document.body.innerText.slice(0,400)})", sid)));
    await wait(1200);
    result.scenarios.survival = {
      ...(await pageFacts(sid)),
      resources: await resourceFacts(sid),
      worlds: await measureWorlds(sid),
      canvasSha: await canvasHash(sid, 'cvA'),
    };
    await screenshot(sid, `${labelArg}-survival.png`);
  }

  // ── compare ───────────────────────────────────────────────
  {
    const sid = await newPage();
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?mode=compare` }, sid);
    await waitFor(async () => Boolean(await evaluate('!!window.__lifeDebug', sid)), 30000, sid);
    const rendered = await waitFor(async () => Boolean(await evaluate("document.getElementById('cvB')?.dataset.renderer", sid)), 40000, sid);
    if (!rendered) throw new Error('compare 首帧未渲染');
    await wait(1500);
    await settleWorlds(sid);
    result.scenarios.compare = {
      ...(await pageFacts(sid)),
      resources: await resourceFacts(sid),
      canvasShaA: await canvasHash(sid, 'cvA'),
      canvasShaB: await canvasHash(sid, 'cvB'),
    };
    await screenshot(sid, `${labelArg}-compare.png`);
  }

  // ── title ─────────────────────────────────────────────────
  {
    const sid = await newPage();
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` }, sid);
    await waitFor(async () => Boolean(await evaluate('!!window.__lifeDebug', sid)), 30000, sid);
    const rendered = await waitFor(async () => Boolean(await evaluate("document.getElementById('startScene')?.dataset.renderer", sid)), 40000, sid);
    if (!rendered) throw new Error('title 场景未渲染');
    await wait(1200);
    const first3d = await evaluate('window.__p0?.first3d ?? null', sid);
    result.scenarios.title = {
      rendererTitle: await evaluate("document.getElementById('startScene')?.dataset.renderer ?? null", sid),
      first3d, longtasks: await evaluate('window.__p0?.longtasks ?? []', sid),
      resources: await resourceFacts(sid),
      canvasSha: await canvasHash(sid, 'startScene'),
      menuDisabled: await evaluate('({survival:document.getElementById("startSurvival")?.disabled,newGame:document.getElementById("startNew")?.disabled,compare:document.getElementById("startCompare")?.disabled})', sid),
    };
    await screenshot(sid, `${labelArg}-title.png`);
  }

  writeFileSync(join(OUT, `${labelArg}.json`), JSON.stringify(result, null, 2) + '\n');
  console.log(`✔ ${labelArg} 金样已写入 evidence/redo-p0/${labelArg}.json`);
  console.log(JSON.stringify({
    survival: { first3d: result.scenarios.survival.first3d, longtasks: result.scenarios.survival.longtasks, resources: result.scenarios.survival.resources },
    compare: { rendererA: result.scenarios.compare.rendererA, rendererB: result.scenarios.compare.rendererB },
    title: { first3d: result.scenarios.title.first3d, resources: result.scenarios.title.resources },
    cache: result.cache,
  }, null, 2));
} finally {
  try { chrome?.kill(); } catch {}
  try { server?.kill(); } catch {}
  await wait(400);
}
