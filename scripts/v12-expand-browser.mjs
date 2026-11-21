#!/usr/bin/env node
// 1.2 浏览器验收：荒野宅基地（可站/可达/可建/入口·碰撞/存档镜头）与居民室内 10 秒位置变化（不穿模）。
// 输出：evidence/v12-expand/browser.json + browser.log + *.png
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCdpHarness } from './lib/cdp-harness.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'evidence', 'v12-expand');
mkdirSync(OUT, { recursive: true });
const log = [];
const note = (kind, data = {}) => { log.push({ at: new Date().toISOString(), kind, ...data }); return data; };
const h = createCdpHarness({
  root: ROOT,
  port: 9300 + (process.pid % 200),
  dataPrefix: 'v12-data-',
  profilePrefix: 'v12-chrome-',
  serverEnv: {
    GAME_MODE: 'game', GAME_RULES: '1', BRAIN: 'local',
    GAME_MS_PER_MINUTE: '6000', TICK_MS: '360000',
    MODEL_UNATTENDED: '0', V73_TEST: '1', SURV_CATCHUP_CAP: '0',
  },
});
const assert = (cond, message) => { if (!cond) throw new Error(message); };
const act = async (body) => (await h.post('/act', { mode: 'survival', ...body })).body;
const ctl = async (body) => (await h.post('/ctl', { confirm: true, ...body })).body;

try {
  await h.startServer();
  h.startChrome();
  const sid = await h.openPage({ url: `${h.origin}/` });
  assert(await h.waitFor(async () => Boolean(await h.evaluate('!!window.__lifeDebug?.S', sid))), '页面未就绪');
  await h.wait(800);
  assert(await h.waitFor(async () => !(await h.evaluate("document.querySelector('#startSurvival').disabled", sid))), '继续生存按钮禁用');
  await h.evaluate("document.querySelector('#startSurvival').click()", sid);
  assert(await h.waitFor(async () => await h.evaluate('window.__lifeDebug.S.playing === true', sid)), '没有进入游戏');
  await h.wait(1200);

  // ── A1：生成 / 可站 / 可达（服务端权威 + 客户端同一份 space）────────────────
  const state0 = await ctl({ action: 'v12_state' });
  note('wild.state0', {
    claims: state0.claims, plots: state0.plots.map((p) => ({ id: p.id, at: p.at, stand: p.stand, route: p.route, claimed: p.claimed })),
  });
  assert(state0.plots.length >= 4 && state0.plots.length <= 8, `地块数量 ${state0.plots.length}`);
  assert(state0.plots.every((p) => p.stand === true), '有地块门口不可站');
  assert(state0.plots.every((p) => (p.route ?? 0) > 0), '有地块从村口不可达');
  assert(state0.plots.every((p) => p.claimed === false && p.houseCenterWalkable === null));
  const client0 = await h.evaluate(`(() => {
    const w = window.__lifeDebug.buildWorld(window.__lifeDebug.S.view);
    return {
      entrances: Object.keys(w.homes3d?.entrances ?? {}),
      plots: (window.__lifeDebug.S.view.wildPlots?.plots ?? []).map(p => {
        const door = [p.gate.x + p.gate.w/2, p.gate.z + p.gate.d*.72];
        return { id: p.id, walkable: w.space.walkable(door[0], door[1], .33), hasRoad: Boolean(p.road) };
      }),
    };
  })()`, sid);
  note('wild.client0', client0);
  assert(client0.plots.every((p) => p.walkable), '客户端 space 认为地块门口不可站（与服务端不一致）');
  assert(client0.plots.every((p) => p.hasRoad === false), '未认领地块不得携带道路几何');
  assert(!client0.entrances.some((id) => id.startsWith('wild-')), '未认领地块不得生成房屋/入口');

  // ── A2：玩家认领 → 施工 3 次 → 完工（全部走真实 /act 规则路径）──────────────
  const plot = state0.plots[0];
  await ctl({ action: 'v12_fixture', fixture: 'materials', wood: 8, stone: 6 });
  await ctl({ action: 'v12_fixture', fixture: 'stand', plot: plot.id });
  const far = await act({ kind: 'home_claim', type: plot.id, from: [plot.door[0] + 40, plot.door[1]] });
  note('wild.claim.far', far);
  assert(far.ok === false, '不在门口也能认领');
  const claim = await act({ kind: 'home_claim', type: plot.id });
  note('wild.claim', claim);
  assert(claim.ok, `认领失败：${JSON.stringify(claim)}`);
  const again = await act({ kind: 'home_claim', type: plot.id });
  note('wild.claim.again', again);
  assert(again.code === 'PLOT_TAKEN', `重复认领没有被拒：${JSON.stringify(again)}`);
  const claimedState = await ctl({ action: 'v12_state' });
  assert(claimedState.claims.includes(plot.id), '认领没有写 claims');
  assert(claimedState.projects[plot.id]?.owner === 'p1', '认领没有写 project');
  const works = [];
  for (let i = 0; i < 3; i += 1) {
    const start = await act({ kind: 'house_work', target: plot.id });
    works.push({ start });
    assert(start.ok, `第 ${i + 1} 次施工没有进入时间轴：${JSON.stringify(start)}`);
    await ctl({ action: 'step' }); // 推进 60 游戏分，让 15 分钟的连续动作到点结算
    const mid = await ctl({ action: 'v12_state' });
    works.at(-1).progress = mid.projects[plot.id]?.progress ?? null;
    works.at(-1).deed = mid.deeds[plot.id] ?? null;
  }
  const doneState = await ctl({ action: 'v12_state' });
  note('wild.work', { works, done: { deeds: doneState.deeds, housing: doneState.housing, projects: doneState.projects } });
  assert(doneState.deeds[plot.id] === 'p1', '完工后没有产权');
  assert(doneState.housing.p1 === plot.id, '完工后玩家没有入住');
  assert(doneState.plots.find((p) => p.id === plot.id).houseCenterWalkable === false, '房屋主体没有被登记为实体（服务端可穿墙）');
  assert(doneState.plots.find((p) => p.id === plot.id).stand === true, '完工后门口不可站');
  // 等页面拿到完工后的 /world 快照（deed + 已认领），再验客户端几何。
  assert(await h.waitFor(async () => await h.evaluate(
    `Boolean(window.__lifeDebug.S.view?.households?.deeds?.[${JSON.stringify(plot.id)}])`, sid), 15000, sid), '页面没有拿到完工后的快照');

  const client1 = await h.evaluate(`(() => {
    const view = window.__lifeDebug.S.view;
    const w = window.__lifeDebug.buildWorld(view);
    const p = view.wildPlots.plots.find(p => p.claimed);
    const center = [p.lot.x + p.lot.w/2, p.lot.z + p.lot.d/2];
    const door = [p.gate.x + p.gate.w/2, p.gate.z + p.gate.d*.72];
    return {
      entrance: Boolean(w.homes3d?.entrances?.[p.id]),
      centerWalkable: w.space.walkable(center[0], center[1], .33),
      doorWalkable: w.space.walkable(door[0], door[1], .33),
      centerColliders: w.space.collidersNear(center[0], center[1], 0).map(c => c.kind),
      heightAtCenter: w.space.heightAt(center[0], center[1]),
      roadCarried: Boolean(p.road && p.road.length),
    };
  })()`, sid);
  note('wild.client1', client1);
  assert(client1.entrance === true, '客户端没有生成荒野住宅入口');
  assert(client1.centerWalkable === false, '客户端可以穿进屋体（与服务端/碰撞不一致）');
  assert(client1.doorWalkable === true, '客户端门口不可站');
  assert(client1.centerColliders.includes('wild-house'), `客户端 colliders 缺 wild-house：${client1.centerColliders}`);
  assert(Math.abs(client1.heightAtCenter) < 1e-9, '认领后地基没有压平到 0');
  assert(client1.roadCarried, '认领后没有携带接入路数据');
  await h.screenshot(sid, join(OUT, 'wild-built.png'));

  // ── B：居民室内 10 秒位置变化 + 每帧可站 + loc 不变 + 玩家不受影响 ───────────
  const indoor = await ctl({ action: 'v12_fixture', fixture: 'indoor', room: 'home', ids: ['a2', 'a3'] });
  note('room.fixture', indoor);
  assert(indoor.ok, JSON.stringify(indoor));
  await h.evaluate("window.__lifeDebug.ui.interior = 'home'", sid);
  await h.wait(900);
  const samples = [];
  const t0 = Date.now();
  while (Date.now() - t0 < 10000) {
    const row = await h.evaluate(`(() => {
      const S = window.__lifeDebug.S, space = window.__lifeDebug.roomSpaceFor('home');
      const out = {};
      for (const id of ['a2','a3']) {
        const a = S.view.agents[id], p = a?.pos ?? null;
        out[id] = { loc: a?.loc ?? null, pos: p, walkable: p ? space.walkable(p.x, p.z, .33) : null };
      }
      out.player = S.view.loc?.p1 ?? null;
      out.playerPos = S.view.playerPos ?? null;
      return out;
    })()`, sid);
    samples.push({ at: Date.now() - t0, ...row });
    await h.wait(1200);
  }
  await h.screenshot(sid, join(OUT, 'room-indoor.png'));
  const moved = {};
  for (const id of ['a2', 'a3']) {
    const pts = samples.map((s) => s[id]?.pos).filter(Boolean);
    assert(pts.length >= 5, `${id} 采样太少`);
    assert(samples.every((s) => s[id]?.walkable === true), `${id} 有采样点穿进家具/墙`);
    assert(samples.every((s) => s[id]?.loc === 'home'), `${id} 在窗口里被改动了 loc`);
    moved[id] = Math.hypot(pts.at(-1).x - pts[0].x, pts.at(-1).z - pts[0].z);
  }
  const playerStill = samples.every((s) => s.player === samples[0].player &&
    JSON.stringify(s.playerPos) === JSON.stringify(samples[0].playerPos));
  note('room.samples', { count: samples.length, moved, playerStill, first: samples[0], last: samples.at(-1) });
  for (const id of ['a2', 'a3']) assert(moved[id] > 0.05, `${id} 在 10 秒内没有移动（${moved[id]}）`);
  assert(playerStill, '玩家位置被室内走动改动');

  const result = {
    ok: true,
    at: new Date().toISOString(),
    step: 'A 可站/可达/可建/入口/碰撞 + B 室内 10 秒移动/可站',
    plots: { count: state0.plots.length, ids: state0.plots.map((p) => p.id), allStand: true, allRoutable: true },
    claim: { id: plot.id, ok: claim.ok, repeat: again.code, deed: doneState.deeds[plot.id], housing: doneState.housing.p1 },
    client: { entrance: client1.entrance, centerWalkable: client1.centerWalkable, doorWalkable: client1.doorWalkable, colliders: client1.centerColliders, heightAtCenter: client1.heightAtCenter },
    room: { samples: samples.length, windowSeconds: 10, moved, allWalkable: true, locStable: true, playerStill },
  };
  note('summary', result);
  writeFileSync(join(OUT, 'browser.json'), JSON.stringify(result, null, 2) + '\n');
  console.log('[v12-browser] PASS', JSON.stringify(result));
} catch (error) {
  note('error', { message: String(error?.stack ?? error) });
  console.error('[v12-browser] FAIL', error);
  process.exitCode = 1;
} finally {
  await h.close({ settleMs: 0 });
  writeFileSync(join(OUT, 'browser.log'), log.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8');
  console.log(`[v12-browser] wrote ${join(OUT, 'browser.log')}`);
}
