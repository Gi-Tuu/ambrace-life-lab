// 生存单世界游玩层（Phase D）。把 survival+coop 接成一个可玩的单世界，独立于 town A/B 研究对照。
// 服务端权威；前端只读 /world.survival；玩家动作走 /act {mode:'survival'}。
//  additive：不改动 A/B pack、不改动 lab/town 基线；存档以独立键 survival 挂载（缺省 tolerant）。
import { makeWorld, spawn, scanSecrets, actuate } from './body.mjs';
import { weatherFor, phaseOf, dayOf } from './clock.mjs';
import { effectiveMods, BUILDINGS } from './production.mjs';
import { SURV } from './worldstate.mjs';
import { initCoop } from './cooperation.mjs';

const ROSTER = [['a1', '岑'], ['a2', '绛'], ['a3', '蓑']];

export function createSurvPlay(seed = 7) {
  const world = makeWorld({ preset: 'survival', seed, pantries: 0, coop: true });
  for (const [id, name] of ROSTER) { world.agents[id] = { id, name }; spawn(world, id, 'home'); }
  world.agents.p1 = { id: 'p1', name: '你', isPlayer: true }; spawn(world, 'p1', 'hall');
  return { world, log: [] };
}

export function tickSurvPlay(sp) {
  const w = sp.world;
  w.t += 1;
  w.weather = weatherFor(7, dayOf(w.t));
  scanSecrets(w);           // 内含 advanceSurvival(日界) + stepCooperation(coop 开)
  return w;
}

export function survAct(sp, body) {
  const w = sp.world;
  const kind = String(body?.kind ?? '');
  if (kind === 'move') {
    const room = String(body?.room ?? '');
    if (!Object.hasOwn(w.locs, room)) return { ok: false, error: 'NO_LOC' };
    w.occupancy[w.loc.p1] = (w.occupancy[w.loc.p1] ?? []).filter((x) => x !== 'p1');
    w.loc.p1 = room; (w.occupancy[room] ??= []).push('p1');
    return { ok: true };
  }
  if (!['harvest', 'plant', 'gather', 'plan', 'build', 'repair'].includes(kind)) return { ok: false, error: 'UNKNOWN_KIND' };
  const r = actuate(w, 'p1', { kind, type: body?.type });
  sp.log.push({ t: w.t, kind, ok: r.ok, code: r.code });
  if (sp.log.length > 40) sp.log.shift();
  return r;
}

export function survView(sp) {
  const w = sp.world; const s = w.survival; const mods = effectiveMods(w);
  return {
    t: w.t, phase: phaseOf(w.t), weather: w.weather,
    day: dayOf(w.t), targetDays: SURV.targetDays,
    rooms: w.locs, outdoor: w.outdoor,
    loc: w.loc, occupancy: w.occupancy,
    store: s.store, storeCap: mods.storeCap, water: Number(s.water.toFixed(2)), soil: Number(s.soil.toFixed(2)),
    plots: s.plots.map((p) => ({ id: p.id, growth: Number(p.growth.toFixed(2)) })),
    inv: s.inv, sites: s.sites, buildings: s.buildings,
    coop: { enabled: s.coop.enabled, task: s.coop.task, completions: s.coop.completions.slice(-10), refusals: s.coop.refusals, replans: s.coop.replans },
    agents: Object.fromEntries(Object.values(w.agents).map((a) => [a.id, { id: a.id, name: a.name, isPlayer: !!a.isPlayer }])),
    failed: s.failed, won: s.won, history: s.history.slice(-14),
    log: sp.log.slice(-12),
    buildingsDef: BUILDINGS,
  };
}

// 持久化（additive）：只 dump 生存世界事实，读回时 tolerant。
export function dumpSurv(sp) {
  const w = sp.world;
  return { t: w.t, loc: w.loc, survival: w.survival, log: sp.log };
}
export function loadSurv(raw, seed = 7) {
  const sp = createSurvPlay(seed);
  if (raw && typeof raw.t === 'number' && raw.survival) {
    sp.world.t = raw.t;
    sp.world.loc = { ...sp.world.loc, ...(raw.loc ?? {}) };
    sp.world.survival = { ...sp.world.survival, ...raw.survival, coop: { ...sp.world.survival.coop, ...(raw.survival.coop ?? {}) } };
    sp.log = raw.log ?? [];
  }
  return sp;
}
