// Phase E/§11 测量（预登记 phase1-plan §9/§9.1/§10/§11）：digest 基线 / E1 / E3 / 生态灾害闸门读数。
// 用法：node life/phase-e-sweep.mjs baseline|e1|e3|base2|grid|eco；export run 供闸门复用同一装置。
import { createHash } from 'node:crypto';
import { createSurvPlay, tickSurvPlay, survAct } from './survplay.mjs';
import { forecastDisasters } from './worldstate.mjs';

const SEEDS = [7, 11, 13];
const TICKS = 360;
const DAY10 = 240;

export function run(seed, { forage = false, player = false, policy = 'continuous', flags = {} } = {}) {
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
    tickSurvPlay(sp);
    const dayNow = Math.floor(sp.world.t / 24);
    if (s.disasterToday && dayNow !== lastDisDay) {
      disasterDays.push(dayNow);
      if (!lastWarn) warnBad += 1; // 预警只需 onset 前存在一次，按灾害日计
      lastDisDay = dayNow;
    }
    lastWarn = f.stormTomorrow || f.coldsnapTomorrow;
    if (s.drought && dayNow !== lastDroughtDay) { droughtDays.push(dayNow); lastDroughtDay = dayNow; }
    if (player) {
      if (s.plots.some((p) => p.growth >= 1)) { const r = survAct(sp, { kind: 'harvest' }); if (r.ok) playerHarvests += 1; }
      const empty = s.plots.filter((p) => p.growth === 0).length;
      if (empty > 0 && (policy === 'continuous' || empty >= 2) && s.water >= 0.1) survAct(sp, { kind: 'plant' });
    }
    const ints = s.buildings.map((b) => b.integrity);
    ints.forEach((v, k) => { if (prevInt[k] !== undefined && v < prevInt[k]) damageEvents += 1; });
    prevInt = ints;
    if (sp.world.t === DAY10) store240 = s.store;
    if (s.failed && failDay === null) failDay = Math.floor(sp.world.t / 24);
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
    storeEnd: s.store,
    warnBad,
    disasterDays,
    droughtDays,
    soilEnd: s.soil,
    yieldTotal: s.yieldTotal ?? 0,
    harvestCount: s.harvestCount ?? 0,
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

export const BASELINE_DIGEST = 'a946f538b14ce9242fbc31d23882e69f'; // 2026-11-11 E1/E3 改前实测（seed 7；§13 后仅 seed 7 有效）
export const BASELINE2 = '05d3cd7c72de4cbe70fbb42864a91499'; // §11 实施前默认（seed 7；§13 后仅 seed 7 有效）
// §13 回填：L2 回退后天气复归硬编码 7 ⇒ 基线复抓#2 回到全 seed 同值（阶段A 的按 seed 映射作废，披露）
export const OFF_BASE = { 7: 'a946f538b14ce9242fbc31d23882e69f', 11: 'a946f538b14ce9242fbc31d23882e69f', 13: 'a946f538b14ce9242fbc31d23882e69f' };
export const BASELINE3 = { 7: '05d3cd7c72de4cbe70fbb42864a91499', 11: '05d3cd7c72de4cbe70fbb42864a91499', 13: '05d3cd7c72de4cbe70fbb42864a91499' };
export const OFF = { forage: false, flags: { repairEarly: false, eco: false, disasters: false, playerEats: false, endFreeze: false } };
export const OFF2 = { forage: true, flags: { repairEarly: true, eco: false, disasters: false, playerEats: false, endFreeze: false } };

if (process.argv[1]?.endsWith('phase-e-sweep.mjs')) {
  const mode = process.argv[2] ?? 'baseline';
  if (mode === 'baseline') {
    console.log(JSON.stringify(SEEDS.map((seed) => run(seed, OFF)), null, 2));
  } else if (mode === 'base2') {
    console.log(JSON.stringify(SEEDS.map((seed) => run(seed, OFF2)), null, 2));
  } else if (mode === 'e1') {
    const off = SEEDS.map((seed) => run(seed, OFF));
    const on = SEEDS.map((seed) => run(seed, { forage: true, flags: { repairEarly: false, eco: false, disasters: false, playerEats: false, endFreeze: false } }));
    const withPlayer = SEEDS.map((seed) => run(seed, { forage: true, player: true, flags: { repairEarly: false, eco: false, disasters: false, playerEats: false, endFreeze: false } }));
    console.log(JSON.stringify({ off, on, withPlayer }, null, 2));
  } else if (mode === 'e3') {
    const off = SEEDS.map((seed) => run(seed, OFF));
    const on = SEEDS.map((seed) => run(seed, { forage: false, flags: { repairEarly: true, eco: false, disasters: false, playerEats: false, endFreeze: false } }));
    console.log(JSON.stringify({ off, on }, null, 2));
  } else if (mode === 'eco') {
    const g1 = SEEDS.map((seed) => run(seed, { forage: true, player: true }));
    const g1alt = SEEDS.map((seed) => run(seed, { forage: true, player: true, flags: { disasters: true, playerEats: true } }));
    const g2 = SEEDS.map((seed) => run(seed, { forage: false, flags: { disasters: true, playerEats: true } }));
    const g2off = SEEDS.map((seed) => run(seed, { forage: false, flags: { disasters: false, playerEats: true } }));
    const g9 = SEEDS.map((seed) => run(seed, { forage: true, player: true }));
    const armA = SEEDS.map((seed) => run(seed, { player: true, policy: 'continuous', flags: { disasters: false, eco: true } }));
    const armB = SEEDS.map((seed) => run(seed, { player: true, policy: 'rotation', flags: { disasters: false, eco: true } }));
    const g6 = SEEDS.map((seed) => run(seed, OFF2));
    console.log(JSON.stringify({ g1, g1alt, g2, g2off, g9, armA, armB, g6 }, null, 2));
  } else if (mode === 'eco2') {
    const h1 = SEEDS.map((seed) => run(seed, { forage: true, player: true, flags: { eco: true } }));
    const h1off = SEEDS.map((seed) => run(seed, { forage: true, player: true }));
    const h2a = SEEDS.map((seed) => run(seed, { player: true, policy: 'continuous', flags: { disasters: false, eco: true } }));
    const h2b = SEEDS.map((seed) => run(seed, { player: true, policy: 'rotation', flags: { disasters: false, eco: true } }));
    const h3 = SEEDS.map((seed) => run(seed, OFF2));
    console.log(JSON.stringify({ h1, h1off, h2a, h2b, h3 }, null, 2));
  } else if (mode === 'drought') {
    const k1 = SEEDS.map((seed) => run(seed, { forage: true }));
    const k2 = SEEDS.map((seed) => run(seed, { forage: true, player: true }));
    const k5 = SEEDS.map((seed) => run(seed, OFF2));
    console.log(JSON.stringify({ k1, k2, k5 }, null, 2));
  } else if (mode === 'grid') {
    const points = [];
    for (const repairEarly of [false, true]) for (const wearRate of [0.1, 0.05]) for (const repairRisk of [0.3, 0.15]) {
      points.push({ repairEarly, wearRate, repairRisk, runs: SEEDS.map((seed) => run(seed, { forage: false, flags: { repairEarly, wearRate, repairRisk, eco: false, disasters: false, playerEats: false, endFreeze: false } })) });
    }
    console.log(JSON.stringify(points, null, 2));
  } else {
    console.error('unknown mode'); process.exit(1);
  }
}