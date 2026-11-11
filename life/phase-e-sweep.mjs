// Phase E 测量（预登记 phase1-plan §9）：baseline digest / E1 读数 / E2 八点网格。
// 用法：node life/phase-e-sweep.mjs baseline|e1|grid；亦 export run 供闸门复用同一装置。
import { createHash } from 'node:crypto';
import { createSurvPlay, tickSurvPlay, survAct } from './survplay.mjs';

const SEEDS = [7, 11, 13];
const TICKS = 360;
const DAY10 = 240;

export function run(seed, { forage = false, player = false, flags = {} } = {}) {
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
  for (let i = 0; i < TICKS; i++) {
    tickSurvPlay(sp);
    if (player) {
      if (s.plots.some((p) => p.growth >= 1)) { const r = survAct(sp, { kind: 'harvest' }); if (r.ok) playerHarvests += 1; }
      else if (s.plots.some((p) => p.growth === 0) && s.water >= 0.1) survAct(sp, { kind: 'plant' });
    }
    const ints = s.buildings.map((b) => b.integrity);
    ints.forEach((v, k) => { if (prevInt[k] !== undefined && v < prevInt[k]) damageEvents += 1; });
    prevInt = ints;
    if (sp.world.t === DAY10) store240 = s.store;
    storeIntegral += s.store;
    h.update(JSON.stringify([sp.world.t, s.store, s.water, s.soil, s.plots.map((p) => p.growth), s.inv, s.buildings.map((b) => [b.type, b.loc, b.integrity]), s.sites.map((x) => [x.type, x.loc, x.progress]), s.coop.task?.phase ?? null, s.coop.completions.length, s.coop.refusals, s.coop.replans, sp.world.loc]));
  }
  return {
    seed,
    digest: h.digest('hex'),
    store240,
    storeIntegral,
    playerHarvests,
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

export const BASELINE_DIGEST = 'a946f538b14ce9242fbc31d23882e69f'; // 2026-11-11 改前实测（3 seed 同值：生存环不消费 rng）
export const OFF = { forage: false, flags: { repairEarly: false } }; // 负控口径：全部新机制关（9.1/§10 跑前登记）

if (process.argv[1]?.endsWith('phase-e-sweep.mjs')) {
  const mode = process.argv[2] ?? 'baseline';
  if (mode === 'baseline') {
    console.log(JSON.stringify(SEEDS.map((seed) => run(seed, OFF)), null, 2));
  } else if (mode === 'e1') {
    const off = SEEDS.map((seed) => run(seed, OFF));
    const on = SEEDS.map((seed) => run(seed, { forage: true, flags: { repairEarly: false } }));
    const withPlayer = SEEDS.map((seed) => run(seed, { forage: true, player: true, flags: { repairEarly: false } }));
    console.log(JSON.stringify({ off, on, withPlayer }, null, 2));
  } else if (mode === 'e3') {
    const off = SEEDS.map((seed) => run(seed, OFF));
    const on = SEEDS.map((seed) => run(seed, { forage: false, flags: { repairEarly: true } }));
    console.log(JSON.stringify({ off, on }, null, 2));
  } else if (mode === 'grid') {
    const points = [];
    for (const repairEarly of [false, true]) for (const wearRate of [0.1, 0.05]) for (const repairRisk of [0.3, 0.15]) {
      points.push({ repairEarly, wearRate, repairRisk, runs: SEEDS.map((seed) => run(seed, { forage: false, flags: { repairEarly, wearRate, repairRisk } })) });
    }
    console.log(JSON.stringify(points, null, 2));
  } else {
    console.error('unknown mode'); process.exit(1);
  }
}