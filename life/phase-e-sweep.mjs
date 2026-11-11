// Phase E/§11/§13/§15 测量（预登记 phase1-plan）：digest 基线 / E1 / E3 / 生态灾害 / 同权读数。
// 用法：node life/phase-e-sweep.mjs baseline|e1|e3|base2|drought|eco|eco2|grid|parity；export run 供闸门复用。
import { createHash } from 'node:crypto';
import { createSurvPlay, tickSurvPlay, survAct } from './survplay.mjs';
import { forecastDisasters } from './worldstate.mjs';

const SEEDS = [7, 11, 13];
const TICKS = 360;
const DAY10 = 240;

export async function run(seed, { forage = false, player = false, policy = 'continuous', flags = {} } = {}) {
  const sp = createSurvPlay(seed);
  const s = sp.world.survival;
  s.forage = forage;
  Object.assign(s, flags);
  if (player) survAct(sp, { kind: 'move', room: 'garden' });
  const h = createHash('md5');
  let prevInt = [];
  let damageEvents = 0;
  let store240 = null;
  let storeIntegral = 0;
  let playerHarvests = 0;
  let failDay = null;
  let storeAtWon = null;
  let storeDropsAfterWon = 0;
  let prevStore = null;
  let wonTick = null;
  let warnBad = 0;
  let lastWarn = false;
  let lastDisDay = -1;
  const disasterDays = [];
  const droughtDays = [];
  let lastDroughtDay = -1;
  for (let i = 0; i < TICKS; i++) {
    const f = forecastDisasters(sp.world);
    await tickSurvPlay(sp);
    const dayNow = Math.floor(sp.world.t / 24);
    if (s.disasterToday && dayNow !== lastDisDay) {
      disasterDays.push(dayNow);
      if (!lastWarn) warnBad += 1;
      lastDisDay = dayNow;
    }
    lastWarn = f.stormTomorrow || f.coldsnapTomorrow;
    if (s.drought && dayNow !== lastDroughtDay) { droughtDays.push(dayNow); lastDroughtDay = dayNow; }
    if (player) {
      if (s.plots.some((p) => p.growth >= 1)) { const r = survAct(sp, { kind: 'harvest' }); if (r.ok) playerHarvests += 1; }
      const empty = s.plots.filter((p) => p.growth === 0).length;
      if (empty > 0 && (policy === 'continuous' || empty >= 2) && s.water >= 0.1) survAct(sp, { kind: 'plant' });
      if (policy === 'competent') {
        const here = sp.world.loc.p1;
        if (s.buildings.some((b) => b.loc === here && b.integrity < 1)) survAct(sp, { kind: 'repair' });
        else if (s.sites.some((x) => x.loc === here)) survAct(sp, { kind: 'build' });
        else if ((sp.world.outdoor ?? []).includes(here) && (s.inv.wood < 4 || s.inv.stone < 4)) survAct(sp, { kind: 'gather' });
      }
    }
    const ints = s.buildings.map((b) => b.integrity);
    ints.forEach((v, k) => { if (prevInt[k] !== undefined && v < prevInt[k]) damageEvents += 1; });
    prevInt = ints;
    if (sp.world.t === DAY10) store240 = s.store;
    if (s.failed && failDay === null) failDay = dayNow;
    if (s.won && wonTick === null) wonTick = i;
    if (s.won && wonTick !== null && i > wonTick && prevStore !== null && s.store < prevStore) storeDropsAfterWon += 1;
    prevStore = s.store;
    storeIntegral += s.store;
    h.update(JSON.stringify([sp.world.t, s.store, s.water, s.soil, s.plots.map((p) => p.growth), s.inv, s.buildings.map((b) => [b.type, b.loc, b.integrity]), s.sites.map((x) => [x.type, x.loc, x.progress]), s.coop.task?.phase ?? null, s.coop.completions.length, s.coop.refusals, s.coop.replans, sp.world.loc]));
  }
  return {
    seed,
    digest: h.digest('hex'),
    store240,
    storeIntegral,
    playerHarvests,
    failDay,
    storeAtWon,
    storeDropsAfterWon,
    warnBad,
    disasterDays,
    droughtDays,
    soilEnd: s.soil,
    yieldTotal: s.yieldTotal ?? 0,
    harvestCount: s.harvestCount ?? 0,
    aiActions: s.aiActions ?? {},
    end: { failed: s.failed, won: s.won, store: s.store },
    forageStats: s.forageStats ?? null,
    repairs: s.coop.completions.filter((c) => c.repair).length,
    builds: s.coop.completions.filter((c) => !c.repair).length,
    refusals: s.coop.refusals,
    damageEvents,
    intact: s.buildings.filter((b) => b.integrity >= 1).length,
    destroyed: s.buildings.filter((b) => b.integrity <= 0).length,
  };
}

// §15 同权＋take_shared 守卫＋P2-B（无尽/繁衍/四季/两性 roster）后基线复抓#6（旧 survival 基线作废，披露于 §15 回填）
export const BASELINE_DIGEST = 'a946f538b14ce9242fbc31d23882e69f'; // 历史：E1/E3 前（plain 居民），仅留痕
export const BASELINE2 = '05d3cd7c72de4cbe70fbb42864a91499'; // 历史：§11 前（plain 居民），仅留痕
export const OFF_BASE = { 7: '5519ae49c91241c4db9c5b8d7751419b', 11: 'a43fcf3c57693856e6264e7f44c9f63c', 13: 'e54bf4ec50b38cb5ccc8ca8ea33c7192' };
export const BASELINE3 = { 7: '31e20e1f31cd7612882923e098064d8d', 11: 'ed60d044885f5062c8e546b2c35b52bf', 13: 'f8e2fb1e774e89bbd01a47b23f23b081' };
export const OFF = { forage: false, flags: { repairEarly: false, eco: false, disasters: false, playerEats: false, endFreeze: false, droughts: false } };
export const OFF2 = { forage: true, flags: { repairEarly: true, eco: false, disasters: false, playerEats: false, endFreeze: false, droughts: false } };

const modes = {
  baseline: () => Promise.all(SEEDS.map((s) => run(s, OFF))),
  base2: () => Promise.all(SEEDS.map((s) => run(s, OFF2))),
  e1: async () => ({
    off: await Promise.all(SEEDS.map((s) => run(s, OFF))),
    on: await Promise.all(SEEDS.map((s) => run(s, { forage: true, flags: { repairEarly: false, eco: false, disasters: false, playerEats: false, endFreeze: false, droughts: false } }))),
    withPlayer: await Promise.all(SEEDS.map((s) => run(s, { forage: true, player: true, flags: { repairEarly: false, eco: false, disasters: false, playerEats: false, endFreeze: false, droughts: false } }))),
  }),
  e3: async () => ({
    off: await Promise.all(SEEDS.map((s) => run(s, OFF))),
    on: await Promise.all(SEEDS.map((s) => run(s, { forage: false, flags: { repairEarly: true, eco: false, disasters: false, playerEats: false, endFreeze: false, droughts: false } }))),
  }),
  drought: async () => ({
    k1: await Promise.all(SEEDS.map((s) => run(s, { forage: true, flags: { droughts: true, droughtThreshold: 2 } }))),
    k2: await Promise.all(SEEDS.map((s) => run(s, { forage: true, player: true }))),
    k5: await Promise.all(SEEDS.map((s) => run(s, OFF2))),
  }),
  eco: async () => ({
    g1: await Promise.all(SEEDS.map((s) => run(s, { forage: true, player: true }))),
    g2: await Promise.all(SEEDS.map((s) => run(s, { forage: true }))),
    g2off: await Promise.all(SEEDS.map((s) => run(s, { forage: true, flags: { disasters: false } }))),
    g9: await Promise.all(SEEDS.map((s) => run(s, { forage: true, player: true }))),
    armA: await Promise.all(SEEDS.map((s) => run(s, { player: true, policy: 'continuous', flags: { disasters: false, eco: true } }))),
    armB: await Promise.all(SEEDS.map((s) => run(s, { player: true, policy: 'rotation', flags: { disasters: false, eco: true } }))),
    g6: await Promise.all(SEEDS.map((s) => run(s, OFF2))),
  }),
  eco2: async () => ({
    h1: await Promise.all(SEEDS.map((s) => run(s, { forage: true, player: true, flags: { eco: true } }))),
    h1off: await Promise.all(SEEDS.map((s) => run(s, { forage: true, player: true }))),
    h2a: await Promise.all(SEEDS.map((s) => run(s, { player: true, policy: 'continuous', flags: { disasters: false, eco: true } }))),
    h2b: await Promise.all(SEEDS.map((s) => run(s, { player: true, policy: 'rotation', flags: { disasters: false, eco: true } }))),
    h3: await Promise.all(SEEDS.map((s) => run(s, OFF2))),
  }),
  parity: async () => ({
    idle: await Promise.all(SEEDS.map((s) => run(s, {}))),
    withPlayer: await Promise.all(SEEDS.map((s) => run(s, { player: true }))),
  }),
  codesign: async () => {
    const points = [];
    for (const moveUrgency of [false, true]) for (const m2 of [{ rainRefill: 0.35 }, { plantWater: 0.06 }]) for (const forage of [false, true]) {
      const flags = { moveUrgency, ...m2 };
      points.push({
        moveUrgency, m2: Object.keys(m2)[0], forage,
        idle: await Promise.all(SEEDS.map((s) => run(s, { forage, flags }))),
        competent: await Promise.all(SEEDS.map((s) => run(s, { forage, player: true, policy: 'competent', flags }))),
        disOn: forage ? await Promise.all(SEEDS.map((s) => run(s, { forage, player: true, flags }))) : null,
        disOff: forage ? await Promise.all(SEEDS.map((s) => run(s, { forage, player: true, flags: { ...flags, disasters: false } }))) : null,
      });
    }
    return points;
  },
  urgency: async () => {
    const points = [];
    for (const urgencyThreshold of [1, 2]) for (const urgencyBoost of [0.6, 1.2]) for (const forage of [false, true]) {
      const flags = { urgencyThreshold, urgencyBoost };
      points.push({
        urgencyThreshold, urgencyBoost, forage,
        idle: await Promise.all(SEEDS.map((s) => run(s, { forage, flags }))),
        competent: await Promise.all(SEEDS.map((s) => run(s, { forage, player: true, policy: 'competent', flags }))),
        disOn: forage ? await Promise.all(SEEDS.map((s) => run(s, { forage, player: true, flags }))) : null,
        disOff: forage ? await Promise.all(SEEDS.map((s) => run(s, { forage, player: true, flags: { ...flags, disasters: false } }))) : null,
      });
    }
    return points;
  },
  balance: async () => {
    const points = [];
    for (const feedReward of [0.5, 0.3, 0.15]) for (const forage of [false, true]) {
      const flags = { feedReward };
      points.push({
        feedReward, forage,
        idle: await Promise.all(SEEDS.map((s) => run(s, { forage, flags }))),
        naive: await Promise.all(SEEDS.map((s) => run(s, { forage, player: true, flags }))),
        competent: await Promise.all(SEEDS.map((s) => run(s, { forage, player: true, policy: 'competent', flags }))),
        disOn: forage ? await Promise.all(SEEDS.map((s) => run(s, { forage, player: true, flags }))) : null,
        disOff: forage ? await Promise.all(SEEDS.map((s) => run(s, { forage, player: true, flags: { ...flags, disasters: false } }))) : null,
      });
    }
    return points;
  },
  grid: async () => {
    const points = [];
    for (const repairEarly of [false, true]) for (const wearRate of [0.1, 0.05]) for (const repairRisk of [0.3, 0.15]) {
      points.push({ repairEarly, wearRate, repairRisk, runs: await Promise.all(SEEDS.map((s) => run(s, { forage: false, flags: { repairEarly, wearRate, repairRisk, eco: false, disasters: false, playerEats: false, endFreeze: false, droughts: false } }))) });
    }
    return points;
  },
};

if (process.argv[1]?.endsWith('phase-e-sweep.mjs')) {
  const mode = process.argv[2] ?? 'baseline';
  if (!modes[mode]) { console.error('unknown mode'); process.exit(1); }
  console.log(JSON.stringify(await modes[mode](), null, 2));
}