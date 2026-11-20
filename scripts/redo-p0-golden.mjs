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
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCdpHarness } from './lib/cdp-harness.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const labelArg = (() => {
  const eq = process.argv.find((a) => a.startsWith('--label='));
  if (eq) return eq.split('=')[1];
  const i = process.argv.indexOf('--label');
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : 'before';
})();
const OUT = join(ROOT, 'evidence', 'redo-p0');
mkdirSync(OUT, { recursive: true });
const h = createCdpHarness({
  root: ROOT,
  port: 9200 + (process.pid % 300),
  dataPrefix: 'redo-p0-data-',
  profilePrefix: 'redo-p0-chrome-',
  serverEnv: { BRAIN: 'local', TICK_MS: '10000000', MODEL_UNATTENDED: '0', V73_TEST: '1' },
  readyAttempts: 150,
  readyErrorChars: 400,
  waitMs: 30000,
  waitIntervalMs: 120,
});
const wait = h.wait;

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

const sha = (s) => createHash('sha256').update(s).digest('hex');

async function settleWorlds(sid) {
  // 冻结居民行走器，避免截图受“抓帧时刻”影响（只改页面内表现层状态）。
  await h.evaluate(`(() => { for (const w of Object.values(window.__lifeDebug.WALK ?? {})) { if (w.path) w.pi = w.path.length; } return true; })()`, sid);
  await wait(350);
}

async function canvasHash(sid, id) {
  return h.evaluate(`(() => { const cv = document.getElementById(${JSON.stringify(id)}); return cv ? cv.toDataURL('image/png') : null; })()`, sid).then((u) => (u ? sha(u) : null));
}

async function measureWorlds(sid) {
  return h.evaluate(`(async () => {
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
  return h.evaluate(`(() => {
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
  return h.evaluate(`(() => {
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
  const get = (p, extra = {}) => fetch(`${h.origin}${p}`, { headers: extra });
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

const result = { label: labelArg, at: new Date().toISOString(), node: process.version, port: h.port, scenarios: {} };
try {
  await h.startServer();
  h.startChrome();
  result.cache = await headers();

  // ── survival ──────────────────────────────────────────────
  {
    const sid = await h.newPage({ probe: PROBE, reducedMotion: true });
    await h.navigate(sid, `${h.origin}/?mode=survival`);
    const ok = await h.waitFor(async () => Boolean(await h.evaluate('!!window.__lifeDebug', sid)), 30000, sid);
    if (!ok) throw new Error('survival 页面未就绪：' + (await h.evaluate('document.body.innerText.slice(0,300)', sid)));
    const rendered = await h.waitFor(async () => Boolean(await h.evaluate("document.getElementById('cvA')?.dataset.renderer", sid)), 40000, sid);
    if (!rendered) throw new Error('survival 首帧未渲染：' + JSON.stringify(await h.evaluate("({notice:document.getElementById('playNoticeText')?.textContent, status:document.getElementById('startStatus')?.textContent, inner:document.body.innerText.slice(0,400)})", sid)));
    await wait(1200);
    result.scenarios.survival = {
      ...(await pageFacts(sid)),
      resources: await resourceFacts(sid),
      worlds: await measureWorlds(sid),
      canvasSha: await canvasHash(sid, 'cvA'),
    };
    await h.screenshot(sid, join(OUT, `${labelArg}-survival.png`));
  }

  // ── compare ───────────────────────────────────────────────
  {
    const sid = await h.newPage({ probe: PROBE, reducedMotion: true });
    await h.navigate(sid, `${h.origin}/?mode=compare`);
    await h.waitFor(async () => Boolean(await h.evaluate('!!window.__lifeDebug', sid)), 30000, sid);
    const rendered = await h.waitFor(async () => Boolean(await h.evaluate("document.getElementById('cvB')?.dataset.renderer", sid)), 40000, sid);
    if (!rendered) throw new Error('compare 首帧未渲染');
    await wait(1500);
    await settleWorlds(sid);
    result.scenarios.compare = {
      ...(await pageFacts(sid)),
      resources: await resourceFacts(sid),
      canvasShaA: await canvasHash(sid, 'cvA'),
      canvasShaB: await canvasHash(sid, 'cvB'),
    };
    await h.screenshot(sid, join(OUT, `${labelArg}-compare.png`));
  }

  // ── title ─────────────────────────────────────────────────
  {
    const sid = await h.newPage({ probe: PROBE, reducedMotion: true });
    await h.navigate(sid, `${h.origin}/`);
    await h.waitFor(async () => Boolean(await h.evaluate('!!window.__lifeDebug', sid)), 30000, sid);
    const rendered = await h.waitFor(async () => Boolean(await h.evaluate("document.getElementById('startScene')?.dataset.renderer", sid)), 40000, sid);
    if (!rendered) throw new Error('title 场景未渲染');
    await wait(1200);
    const first3d = await h.evaluate('window.__p0?.first3d ?? null', sid);
    result.scenarios.title = {
      rendererTitle: await h.evaluate("document.getElementById('startScene')?.dataset.renderer ?? null", sid),
      first3d, longtasks: await h.evaluate('window.__p0?.longtasks ?? []', sid),
      resources: await resourceFacts(sid),
      canvasSha: await canvasHash(sid, 'startScene'),
      menuDisabled: await h.evaluate('({survival:document.getElementById("startSurvival")?.disabled,newGame:document.getElementById("startNew")?.disabled,compare:document.getElementById("startCompare")?.disabled})', sid),
    };
    await h.screenshot(sid, join(OUT, `${labelArg}-title.png`));
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
  await h.close({ settleMs: 400 });
}
