#!/usr/bin/env node
// P2 空间一致性证据：同一批坐标，客户端 buildWorld().space 与服务端 constructionSpace 各自回答。
//
// 用法：node scripts/p2-space-parity.mjs
// 输出：evidence/redo-p2/parity.json + parity.log + parity-client.json
// 口径：
//   · 每例 11k 抽样：8k 营地均匀 + 1k 河岸带 + 1k 桥带 + 1k 地点/门附近；
//   · 跑两例：宿主当前世界（seed 0 / v0）与强制 seed 13 / v2（覆盖桥/门）；
//   · terrainWalkable / walkable(0.33) / heightAt / portalAt 四项逐点比较；
//   · 差异按“客户端专属实体（树/岩/屋）”“服务端专属实体”“地形”分类；地形差异必须为 0。
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromeGate } from '../life/chrome-gate.mjs';
import { createSurvPlay, survView } from '../life/survplay.mjs';
import { constructionSpace, sceneSpace } from '../life/construction-access.mjs';
import { campTerrain } from '../shared/camp-terrain.mjs';
import { campBridgeBounds, generateCampLayout } from '../shared/camp-layout.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'evidence', process.env.PARITY_OUT || 'redo-p2b');
mkdirSync(OUT, { recursive: true });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const logLines = [];
const log = (line) => { logLines.push(line); console.log(line); };

const gate = chromeGate({ requireChrome: true });
if (gate.fail || !gate.path) throw new Error(gate.reason ?? '找不到 Chrome');
const CHROME = process.env.CHROME_PATH ?? gate.path;
const PORT = 9500 + (process.pid % 200);
const DATA = mkdtempSync(join(tmpdir(), 'p2-space-data-'));
const PROFILE = mkdtempSync(join(tmpdir(), 'p2-space-chrome-'));

function startServer() {
  const server = spawn(process.execPath, ['serve.mjs'], {
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
  return {
    ready: async () => {
      for (let i = 0; i < 150 && !out.includes('就绪'); i += 1) await wait(150);
      if (!out.includes('就绪')) throw new Error('服务未就绪：' + out.slice(0, 400));
    },
    kill: () => server.kill(),
  };
}

function startChrome() {
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-pipe', `--user-data-dir=${PROFILE}`, 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
  const writeFd = chrome.stdio[3], readFd = chrome.stdio[4];
  let buf = '';
  const cdp = { pending: new Map() };
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
  return { chrome, cdp, kill: () => chrome.kill() };
}

async function evaluate(cdp, expression, sessionId) {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true }, sessionId);
  if (r.exceptionDetails) throw new Error('JS 异常：' + r.exceptionDetails.text + ' ' + (r.result?.description ?? ''));
  return r.result.value;
}

function prng(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}
function samplesFor(mapSeed, layoutVersion) {
  const rnd = prng(20261119);
  const { riverCenter, riverHalfWidth } = campTerrain(mapSeed, true, layoutVersion);
  const layout = generateCampLayout(mapSeed, layoutVersion);
  const points = [];
  for (let i = 0; i < 8000; i += 1) points.push([rnd() * 120, rnd() * 80]);
  for (let i = 0; i < 1000; i += 1) {
    const z = rnd() * 80;
    const center = riverCenter(z * 16) / 16;
    const half = riverHalfWidth(z * 16) / 16;
    points.push([center + (rnd() * 2 - 1) * (half + .35), z]);
  }
  const bounds = campBridgeBounds(layout.crossZ - 1, layout.crossZ + 1, riverCenter, riverHalfWidth);
  for (let i = 0; i < 1000; i += 1) {
    points.push([bounds[0] + rnd() * (bounds[2] - bounds[0]), bounds[1] + rnd() * (bounds[3] - bounds[1])]);
  }
  const sites = Object.values(layout.sites);
  for (let i = 0; i < 1000; i += 1) {
    const [sx, sz] = sites[Math.floor(rnd() * sites.length)];
    points.push([sx + .5 + (rnd() * 2 - 1) * 2.5, sz + .5 + (rnd() * 2 - 1) * 3.5]);
  }
  return points;
}

const CLIENT_FN = `async (points, seed, version, layout, view) => {
  const S = window.__lifeDebug.S;
  const base = S.view;
  // P4：heightAt 现在包含同一条地形链，客户端必须拿到**与该世界完全相同的输入**
  // （districts/peripheralHomes/households/homeRoads/ecoSources…），否则比较的是两套输入。
  // 生产路径本来就是服务端 survView 同一份快照；强制 seed 例由 Node 侧 survView 提供。
  const w = view ? { ...base, ...view } : { ...base, mapSeed: seed, layoutVersion: version, ...(layout ? { layout } : {}) };
  const world = window.__lifeDebug.buildWorld(w);
  if (!world.space) return { space: false };
  const space = world.space;
  const rows = points.map(([x, z]) => {
    const s = space.surface(x, z, 0.33);
    return [space.terrainWalkable(x, z) ? 1 : 0, space.walkable(x, z, 0.33) ? 1 : 0,
      Number(space.heightAt(x, z).toFixed(4)), space.portalAt(x, z, 0.3)?.id ?? null,
      s.kind, space.collidersNear(x, z, 0.33).map(c => c.kind).join('|')];
  });
  const hex = async (u8) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', u8))]
    .map(v => v.toString(16).padStart(2, '0')).join('');
  return { space: true, seed: w.mapSeed, version: w.layoutVersion, camp: Boolean(base.camp), rows,
    probe: [[30, 24], [30.5, 24], [31, 24], [31.5, 24], [32, 24]].map(([x, z]) => [x, z,
      space.walkable(x, z, 0.33), space.terrainWalkable(x, z),
      space.collidersNear(x, z, 0.33).map(c => c.kind + ':' + c.x.toFixed(2) + ',' + c.z.toFixed(2) + ',' + c.w.toFixed(2) + ',' + c.d.toFixed(2))]),
    hashes: { walk: await hex(world.walk), terrainWalk3d: await hex(world.terrainWalk3d) } };
}`;

function serverSpace(seed, version) {
  const sp = createSurvPlay(seed, {
    gameRules: true, mapSeed: seed, layoutVersion: version, settlementLife: true,
    regionalWork: true, independentWorld: true, residentialDecisions: true, unifiedCooperation: true, actTimeModel: true,
  });
  // P2b：正式世界走 constructionSpace；无 campLayout 的宿主世界（layout 0）用同一份
  // sceneGeometry/Stage 的只读空间（sceneSpace），不再手工传 trees:[]。
  return constructionSpace(sp.world) ?? sceneSpace(sp.world);
}

function compare(label, seed, version, client, server, points) {
  const rows = points.map(([x, z]) => {
    const s = server.surface(x, z, 0.33);
    return [server.terrainWalkable(x, z) ? 1 : 0, server.walkable(x, z, 0.33) ? 1 : 0,
      Number(server.heightAt(x, z).toFixed(4)), server.portalAt(x, z, 0.3)?.id ?? null,
      s.kind, server.collidersNear(x, z, 0.33).map(c => c.kind).join('|')];
  });
  const diffs = { terrain: [], walk: [], height: [], portal: [], kind: [] };
  for (let i = 0; i < points.length; i += 1) {
    const [x, z] = points[i], c = client.rows[i], s = rows[i];
    if (c[0] !== s[0]) diffs.terrain.push([x, z, c[0], s[0]]);
    if (c[1] !== s[1]) diffs.walk.push([x, z, c[1], s[1], c[5], s[5]]);
    if (c[2] !== s[2]) diffs.height.push([x, z, c[2], s[2], c[4], s[4]]);
    if (c[3] !== s[3]) diffs.portal.push([x, z, c[3], s[3]]);
    if (c[4] !== s[4]) diffs.kind.push([x, z, c[4], s[4]]);
  }
  const buckets = { 'client-collider': [], 'server-collider': [], terrain: [] };
  for (const d of diffs.walk) {
    const [, , cw, sw, cc, sc] = d;
    buckets[cw === sw ? 'terrain' : cc && !sc ? 'client-collider' : sc && !cc ? 'server-collider' : 'terrain'].push(d);
  }
  const sample = (arr, n = 40) => arr.slice(0, n);
  const bridgeHeightDiffs = diffs.height.filter((d) => d[4] === 'bridge' || d[5] === 'bridge');
  const portalDiffs = diffs.portal.filter(([, , cid, sid]) => cid || sid);
  const result = {
    label, seed, version, samples: points.length,
    client: { seed: client.seed, version: client.version, camp: client.camp, hashes: client.hashes },
    diffs: {
      terrain: diffs.terrain.length, walk: diffs.walk.length, height: diffs.height.length,
      portal: diffs.portal.length, kind: diffs.kind.length,
    },
    walkBuckets: Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, { count: v.length, sample: sample(v) }])),
    terrainSamples: sample(diffs.terrain),
    heightSamples: sample(diffs.height, 20),
    bridgeHeightDiffs: bridgeHeightDiffs.length,
    portalSamples: sample(diffs.portal),
    portalDiffCount: portalDiffs.length,
  };
  writeFileSync(join(OUT, `parity-${label}.json`), JSON.stringify(result, null, 2) + '\n');
  log(`[${label}] samples ${points.length} · terrainDiff ${diffs.terrain.length} · walkDiff ${diffs.walk.length} · heightDiff ${diffs.height.length} · portalDiff ${portalDiffs.length} · bridgeHeightDiff ${bridgeHeightDiffs.length}`);
  log(`[${label}] walk buckets ${JSON.stringify(Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, v.length])))}`);
  log(`[${label}] walk ${client.hashes.walk} · terrainWalk3d ${client.hashes.terrainWalk3d}`);
  if (diffs.terrain.length) log(`[${label}] TERRAIN DIFF SAMPLE ` + JSON.stringify(sample(diffs.terrain, 10)));
  if (label === 'host') log(`[${label}] quickstart probe ` + JSON.stringify(client.probe));
  return { result, buckets, bridgeHeightDiffs, portalDiffs };
}

const srv = startServer();
let chromeCtl;
try {
  await srv.ready();
  chromeCtl = startChrome();
  const { cdp } = chromeCtl;
  const target = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const attached = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
  const sid = attached.sessionId;
  await cdp.send('Page.enable', {}, sid);
  await cdp.send('Runtime.enable', {}, sid);
  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?mode=survival` }, sid);
  const waitFor = async (expr, ms = 60000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await evaluate(cdp, expr, sid).catch(() => false)) return true;
      await wait(150);
    }
    return false;
  };
  if (!await waitFor('Boolean(window.__lifeDebug)', 30000)) throw new Error('页面未就绪');
  if (!await waitFor("Boolean(document.getElementById('cvA')?.dataset.renderer)", 60000)) throw new Error('首帧未渲染');
  if (!await waitFor('Boolean(window.__lifeDebug?.S?.view?.camp)', 60000)) throw new Error('营地世界未建立');
  const meta = await evaluate(cdp, '(() => { const s=window.__lifeDebug.S.view; return {mapSeed:s?.mapSeed??13,layoutVersion:s?.layoutVersion??2}; })()', sid);
  log('host meta ' + JSON.stringify(meta));

  const runClient = async (points, seed, version, layout, view = null) => {
    const client = await evaluate(cdp, `(${CLIENT_FN})(...${JSON.stringify([points, seed, version, layout ?? null, view])})`, sid);
    if (!client.space) throw new Error('客户端 buildWorld().space 未建立');
    if (client.rows.length !== points.length) throw new Error('客户端返回行数不符');
    return client;
  };

  const cases = [];
  // 例 1：宿主当前世界（通常是 seed 0 / v0，覆盖河岸与村内实体）。
  {
    const points = samplesFor(meta.mapSeed, meta.layoutVersion);
    const client = await runClient(points, meta.mapSeed, meta.layoutVersion, null);
    const server = serverSpace(meta.mapSeed, meta.layoutVersion);
    cases.push(compare('host', meta.mapSeed, meta.layoutVersion, client, server, points));
  }
  // 真实按键 0.7s：确认玩家移动仍发生（P2 速度换算 + space 碰撞不能把人钉住）。
  {
    const walk = await evaluate(cdp, `(async () => {
      const W = window.__lifeDebug.WALK; const k = Object.keys(W).find(k => k.endsWith(':p1')) ?? Object.keys(W)[0];
      const before = { x: W[k].x, y: W[k].y };
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyD', key: 'd', bubbles: true }));
      await new Promise(r => setTimeout(r, 700));
      window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyD', key: 'd', bubbles: true }));
      return { key: k, before, after: { x: W[k].x, y: W[k].y }, moved: Math.hypot(W[k].x - before.x, W[k].y - before.y) };
    })()`, sid);
    walk.moved = Number(walk.moved.toFixed(3));
    log('[walk] ' + JSON.stringify(walk));
    writeFileSync(join(OUT, 'parity-walk.json'), JSON.stringify(walk, null, 2) + '\n');
    if (!(walk.moved > 0.05)) process.exitCode = 6;
  }
  // 例 2：强制 seed 13 / v2，覆盖桥面与门 portal。
  // 客户端必须用这个世界的 survView（与生产中 provider 下发的快照同一份输入），
  // 不能拿宿主 view 改 seed/layout —— 那会把 districts/households 留在宿主世界，比较失去意义。
  {
    const seed = 13, version = 2;
    const opts = {
      gameRules: true, mapSeed: seed, layoutVersion: version, settlementLife: true,
      regionalWork: true, independentWorld: true, residentialDecisions: true, unifiedCooperation: true, actTimeModel: true,
    };
    const sp = createSurvPlay(seed, opts);
    const view = survView(sp);
    const layout = generateCampLayout(seed, version);
    const points = samplesFor(seed, version);
    const client = await runClient(points, seed, version, layout, view);
    const server = constructionSpace(sp.world) ?? sceneSpace(sp.world);
    cases.push(compare('seed13v2', seed, version, client, server, points));
  }

  const summary = {
    at: new Date().toISOString(), host: meta,
    cases: cases.map(({ result }) => ({
      label: result.label, seed: result.seed, version: result.version, samples: result.samples,
      diffs: result.diffs, walkBuckets: Object.fromEntries(Object.entries(result.walkBuckets).map(([k, v]) => [k, v.count])),
      bridgeHeightDiffs: result.bridgeHeightDiffs, portalDiffCount: result.portalDiffCount,
    })),
  };
  writeFileSync(join(OUT, 'parity.json'), JSON.stringify(summary, null, 2) + '\n');
  writeFileSync(join(OUT, 'parity.log'), logLines.join('\n') + '\n');

  for (const c of cases) {
    if (c.result.diffs.terrain) process.exitCode = 2;
    if (c.result.diffs.walk) process.exitCode = 3;
    if (c.result.diffs.height) process.exitCode = 4;
    if (c.result.diffs.portal) process.exitCode = 5;
    if (c.bridgeHeightDiffs.length) process.exitCode = 6;
    if (!c.result.diffs.terrain && !c.result.diffs.walk && !c.result.diffs.height &&
        !c.result.diffs.portal && !c.bridgeHeightDiffs.length) {
      log(`[${c.result.label}] PASS：${c.result.samples} 点 terrain/walk/height/portal 全 0 差异`);
    }
  }
} finally {
  try { chromeCtl?.kill(); } catch { /* noop */ }
  try { srv.kill(); } catch { /* noop */ }
  await wait(300);
}
