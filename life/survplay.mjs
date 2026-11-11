// 生存单世界游玩层（Phase D）。把 survival+coop 接成一个可玩的单世界，独立于 town A/B 研究对照。
// 服务端权威；前端只读 /world.survival；玩家动作走 /act {mode:'survival'}。
//  additive：不改动 A/B pack、不改动 lab/town 基线；存档以独立键 survival 挂载（缺省 tolerant）。
import { makeWorld, spawn, scanSecrets, actuate } from './body.mjs';
import { weatherFor, phaseOf, dayOf, survivalPhaseOf, seasonOf, SEASONS, SEASON_DAYS } from './clock.mjs';
import { effectiveMods, BUILDINGS } from './production.mjs';
import { SURV } from './worldstate.mjs';
import { initCoop } from './cooperation.mjs';
import { forecastDisasters } from './worldstate.mjs';

const ROSTER = [['a1', '岑'], ['a2', '绛'], ['a3', '蓑']];

export function createSurvPlay(seed = 7) {
  const world = makeWorld({ preset: 'survival', seed, pantries: 0, coop: true });
  for (const [id, name] of ROSTER) { world.agents[id] = { id, name }; spawn(world, id, 'home'); }
  world.agents.p1 = { id: 'p1', name: '你', isPlayer: true }; spawn(world, 'p1', 'hall');
  world.survival.forage = true; // Phase E1：安全网觅食默认开（play 层；engine survival 不带此键 ⇒ S1–S6 不变）
  world.survival.repairEarly = true; // E3a 过 ⇒ 默认开（§10 跑前登记的裁决）
  world.survival.eco = true; // §12 缓和曲线 H1∧H2 过 ⇒ 默认开（0.8+0.2×土）
  world.survival.disasters = true; // §11 中档 G1 负 ⇒ 预登记备选档（4%/0.15）G1 过 ⇒ 默认开（备选档）
  world.survival.playerEats = true; // §11 裁决②成立：4 人/日可由工坊+1 产量支撑（曾误归因于水经济，已更正回填）
  world.survival.endFreeze = true; // §11 裁决①（G9 验）
  world.survival.droughts = false; // §13 K2 负（主/备各一次）⇒ 默认关、R3 主张撤回；机制与开关保留（K3 单元验）
  world.survival.forageStats = { harvest: 0, plant: 0 };
  return { world, log: [] };
}

// E1 安全网觅食（9.1 修订）：全聚落每日预算 1 收＋1 种，仅当公仓低于 pop×阈值；走 actuate+rules。
function forageRound(w) {
  const s = w.survival;
  const pop = Object.values(w.agents).filter((a) => !a.isPlayer).length;
  if (s.store >= pop * (s.forageThreshold ?? 1)) return;
  let budgetH = 1; let budgetP = 1;
  for (const id of Object.keys(w.agents)) {
    if (w.agents[id].isPlayer || (!budgetH && !budgetP)) continue;
    const wantH = budgetH > 0 && s.plots.some((p) => p.growth >= 1);
    const wantP = budgetP > 0 && s.plots.some((p) => p.growth === 0) && s.water >= 0.1;
    if (!wantH && !wantP) continue;
    if (w.loc[id] !== 'garden') {
      w.occupancy[w.loc[id]] = (w.occupancy[w.loc[id]] ?? []).filter((x) => x !== id);
      w.loc[id] = 'garden'; (w.occupancy.garden ??= []).push(id);
    }
    if (wantH) { const r = actuate(w, id, { kind: 'harvest' }); if (r.ok) { s.forageStats.harvest += 1; budgetH -= 1; } }
    if (wantP) { const r = actuate(w, id, { kind: 'plant' }); if (r.ok) { s.forageStats.plant += 1; budgetP -= 1; } }
  }
}

export function tickSurvPlay(sp) {
  const w = sp.world;
  w.t += 1;
  w.weather = weatherFor(7, dayOf(w.t)); // §13 L2 被 K2 否（11/13 不可玩）⇒ 回退硬编码 7；seed 轴退化保留披露
  scanSecrets(w);           // 内含 advanceSurvival(日界) + stepCooperation(coop 开)
  if (w.survival.forage && dayOf(w.t) !== dayOf(w.t - 1)) forageRound(w);
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
    t: w.t, phase: survivalPhaseOf(w.t), weather: w.weather,
    season: SEASONS[seasonOf(dayOf(w.t))], dayInSeason: (dayOf(w.t) % SEASON_DAYS) + 1,
    day: dayOf(w.t), targetDays: SURV.targetDays,
    rooms: w.locs, outdoor: w.outdoor,
    loc: w.loc, occupancy: w.occupancy,
    store: s.store, storeCap: mods.storeCap, water: Number(s.water.toFixed(2)), soil: Number(s.soil.toFixed(2)),
    plots: s.plots.map((p) => ({ id: p.id, growth: Number(p.growth.toFixed(2)) })),
    inv: s.inv, sites: s.sites, buildings: s.buildings,
    coop: { enabled: s.coop.enabled, task: s.coop.task, completions: s.coop.completions.slice(-10), refusals: s.coop.refusals, replans: s.coop.replans },
    agents: Object.fromEntries(Object.values(w.agents).map((a) => [a.id, { id: a.id, name: a.name, isPlayer: !!a.isPlayer }])),
    failed: s.failed, won: s.won, history: s.history.slice(-14),
    ...forecastDisasters(w),
    drought: !!s.drought, disasterToday: s.disasterToday,
    clearStreak: s.clearStreak ?? 0, coldStreak: s.coldStreak ?? 0,
    yieldTotal: s.yieldTotal ?? 0, harvestCount: s.harvestCount ?? 0,
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
