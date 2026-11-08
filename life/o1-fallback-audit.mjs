// O1-M 审查补证（只测量，不改引擎）：cfFallback 兜底窗口是否与侵蚀同窗。
// 背景：viability.usage() 在"测量未积累或三项全零"时退回旧量纲公式并记 cfFallback。
// 若某次侵蚀发生在兜底窗口里，"削的是实测影响度最高的器官"这句主张在那一次不成立。
// 这里把注册窗口（3 seed × 1200 刻）里每次侵蚀发生时的度量来源记下来：useCf 真/假 + 当刻 cfFallback 增量。
// 真饥馑用手工每刻清零的世界（simulate 每 55 刻自动补粮，pantry:0 不是真缺粮）；常态/宽裕用 simulate。
import { makeWorld, spawn } from './body.mjs';
import { Organism } from './agent.mjs';
import { simulate } from './run.mjs';

const rate = (c, k) => (c.cfDecisions ? (c[k] ?? 0) / c.cfDecisions : 0);
const useCfOf = (c) => (c.cfDecisions ?? 0) > 0 && rate(c, 'cfMem') + rate(c, 'cfRel') + rate(c, 'cfHabit') > 0;
const totals = (agents) => Object.values(agents).reduce((s, a) => {
  s.fallback += a.counters.cfFallback ?? 0; s.decisions += a.counters.cfDecisions ?? 0;
  s.erosions += a.viab.ledger.length; return s;
}, { fallback: 0, decisions: 0, erosions: 0 });

async function starve(seed, ticks) {
  const w = makeWorld({ pantries: 0, stash: 0 });
  for (const [id, name, s] of [['a1', '岑', seed], ['a2', '绛', seed + 1]]) {
    const a = new Organism({ id, name, archetype: '谨慎', seed: s, condition: 'C2', channelMask: { cfUsage: 1 } });
    w.agents[id] = a; spawn(w, id, 'home');
  }
  const rows = [];
  for (let t = 1; t <= ticks; t++) {
    w.t = t; w.percepts = []; w.pantry = 0;
    for (const id of Object.keys(w.agents)) w.stash[id] = 0;
    for (const a of Object.values(w.agents)) {
      const before = a.viab.ledger.length;
      const fb = a.counters.cfFallback ?? 0;
      const use = useCfOf(a.counters);
      await a.tick(w);
      if (a.viab.ledger.length > before) rows.push({ t, who: a.id, organ: a.viab.ledger[before].key, useCfAtErosion: use, fallbackDelta: (a.counters.cfFallback ?? 0) - fb });
    }
  }
  return { rows, totals: totals(w.agents) };
}

let coincident = 0, erosionCount = 0;
for (const seed of [7, 11, 13]) {
  const s = await starve(seed, 1200);
  erosionCount += s.rows.length;
  coincident += s.rows.filter((r) => !r.useCfAtErosion || r.fallbackDelta > 0).length;
  console.log(`饥馑 seed=${seed} 侵蚀=${s.rows.length} 兜底总计=${s.totals.fallback}`, JSON.stringify(s.rows));
  for (const [label, pantry, stash] of [['常态', 6, 3], ['宽裕', 8, 5]]) {
    const { agents } = await simulate({ seed, ticks: 1200, condition: 'C2', pantry, stash, channelMask: { cfUsage: 1 } });
    const t = totals(agents);
    console.log(`${label} seed=${seed} 侵蚀=${t.erosions} 兜底=${t.fallback} 决策=${t.decisions}`);
  }
}
console.log(`VERDICT 侵蚀共 ${erosionCount} 次，其中落在兜底窗口（useCf=false 或当刻 fallback 增量>0）的 ${coincident} 次`);
