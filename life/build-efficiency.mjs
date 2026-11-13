// P0-A 对照实验：同一初始世界、同一建筑，比较独建 / 玩家+1 AI / 玩家+3 AI / AI 自主。
// 只做“劳动—时间”微基准：每个世界刻每个角色最多一次施工行动，资源已按奠基成本预付。
import { createSurvPlay, survAct } from './survplay.mjs';
import { actuate } from './body.mjs';
import { BUILDINGS } from './production.mjs';

const GAME = { residentialDecisions: true, ecosystem: true, unifiedCooperation: true, independentWorld: true, wildFood: true, autonomousGoals: true };

function arm(nAI, playerActive) {
  const sp = createSurvPlay(7, GAME), w = sp.world, s = w.survival;
  const keep = ['p1', ...['a1', 'a2', 'a3'].slice(0, nAI)];
  for (const id of Object.keys(w.agents)) if (!keep.includes(id)) { delete w.agents[id]; delete w.loc[id]; }
  for (const id of keep) { w.loc[id] = 'yard'; w.agents[id].viab.v = 1; }
  w.occupancy = { yard: keep.slice() };
  s.sites = [{ type: 'shelter', loc: 'yard', progress: 0 }];
  s.buildings = [];
  s.inv = { wood: BUILDINGS.shelter.cost.wood, stone: BUILDINGS.shelter.cost.stone };
  w.pinv.p1 = { wood: 4, stone: 2 };
  const viab0 = Object.fromEntries(keep.map((id) => [id, w.agents[id].viab.v]));
  let ticks = 0, playerLabor = 0, aiLabor = 0;
  while (s.buildings.length === 0 && ticks < 20) {
    w.t += 1; ticks += 1;
    if (playerActive && survAct(sp, { kind: 'build' }).ok) playerLabor += 1;
    for (const id of keep.filter((x) => x !== 'p1')) if (actuate(w, id, { kind: 'build' }).ok) aiLabor += 1;
  }
  return {
    arm: `${playerActive ? 'player' : 'ai'}+${nAI}ai`,
    ticks, playerLabor, aiLabor, totalLabor: playerLabor + aiLabor,
    completed: s.buildings.length, cost: { ...BUILDINGS.shelter.cost },
    viabDelta: Number((Object.values(viab0).reduce((a, b) => a + b, 0) - keep.reduce((a, id) => a + w.agents[id].viab.v, 0)).toFixed(4)),
  };
}

export function compare() {
  return { solo: arm(0, true), duo: arm(1, true), team: arm(3, true), aiOnly: arm(3, false) };
}

if (process.argv[1]?.endsWith('build-efficiency.mjs')) console.log(JSON.stringify(compare(), null, 2));
