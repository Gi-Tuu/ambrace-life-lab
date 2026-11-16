// B 验收：主动玩家 5 种子 × 200 日。策略：饿就去谷仓吃一份（B-a 的入口），否则待命。
// 只读世界、不写 data/；输出 JSON 供回报引用。
import { CURRENT_EVENT_RULES } from '../life/rng.mjs';
import { createSurvPlay, tickSurvPlay, survAct } from '../life/survplay.mjs';
import { isAlive } from '../life/body.mjs';

const GAME = {
  eventRulesVersion: CURRENT_EVENT_RULES, independentWorld: true, gameRules: true,
  residentialDecisions: true, unifiedCooperation: true, settlementLife: true,
  autonomousGoals: true, farmLife: true, regionalWork: true, ecosystem: true,
  wildFood: true, playerRation: true,
};
const seeds = (process.argv[2] ?? '7,13,29,42,99').split(',').map(Number);
const days = Number(process.argv[3] ?? 200);
const DAY = 24;

const out = [];
for (const seed of seeds) {
  const sp = createSurvPlay(seed, GAME);
  const w = sp.world;
  let meals = 0;
  let moved = 0;
  for (let t = 0; t < days * DAY; t += 1) {
    if (!isAlive(w.agents.p1)) break;
    const energy = w.agents.p1.drives?.v?.energy ?? 1;
    if (energy < 0.55) {
      if (w.loc.p1 !== 'store') {
        const r = survAct(sp, { kind: 'move', room: 'store' });
        if (r.ok) moved += 1;
      } else {
        const r = survAct(sp, { kind: 'camp_eat', type: 'crop' });
        if (r.ok) meals += 1;
      }
    }
    await tickSurvPlay(sp, { now: Date.now() });
  }
  const agents = Object.values(w.agents).filter((a) => !a.dead && !a.isPlayer);
  out.push({
    seed,
    days: Math.floor(w.t / DAY),
    playerAlive: isAlive(w.agents.p1),
    playerDeathDay: w.agents.p1.death ? Math.floor(w.agents.p1.death.t / DAY) : null,
    playerCause: w.agents.p1.death?.cause ?? null,
    settlementAlive: agents.length,
    ended: !!w.survival.ended,
    mealsEaten: meals,
    moves: moved,
    store: w.survival.store,
    births: w.survival.births ?? 0,
    deaths: (w.survival.deaths ?? []).length,
  });
}
const alive = out.filter((r) => r.playerAlive).length;
const settlements = out.filter((r) => r.settlementAlive > 0).length;
console.log(JSON.stringify({ summary: { seeds: seeds.length, playerAlive: alive, settlementAlive: settlements, days }, runs: out }, null, 2));
