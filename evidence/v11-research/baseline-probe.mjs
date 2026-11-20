// 1.1 第 6 项研究态基线探针：只读 dumpSurv 哈希与旧时间/空间口径。
import { createHash } from 'node:crypto';
import { createSurvPlay, dumpSurv, tickSurvPlay, survAct } from '../../life/survplay.mjs';
import { startMove } from '../../life/body.mjs';
import { FORMAL_OPTIONS } from '../../life/balance-probe.mjs';
import { GAME_OPTIONS } from '../../life/long-run.mjs';
import { worldSite } from '../../life/geometry.mjs';
import { RESIDENT_UNITS_PER_TICK } from '../../life/body.mjs';

const md5 = (s) => createHash('md5').update(s).digest('hex');
const run = async (label, seed, opts, ticks) => {
  const sp = createSurvPlay(seed, opts);
  for (let i = 0; i < ticks; i += 1) await tickSurvPlay(sp);
  const raw = JSON.stringify(dumpSurv(sp));
  console.log(label, 'tick', sp.world.t, 'bytes', raw.length, 'md5', md5(raw));
  return sp;
};
const A = await run('A research-base', 7, {}, 12);
const B = await run('B research-gameopts', 13, { ...GAME_OPTIONS }, 24);
const C = await run('C legacy-formal', 7, { ...FORMAL_OPTIONS, simTime: false }, 24);
const D = await run('D research-independent', 7, { independentWorld: true, actTimeModel: true, residentialDecisions: true, unifiedCooperation: true, gameRules: false }, 24);

for (const [label, sp] of [['A', A], ['B', B], ['C', C], ['D', D]]) {
  const w = sp.world; const locs = Object.keys(w.districts ?? {});
  if (!locs.length) continue;
  w.loc.a1 = w.loc.p1; startMove(w, 'a1', locs[0]);
  const tr = w.survival.districtTravel.a1;
  const from = worldSite(w, w.loc.p1), to = worldSite(w, locs[0]);
  const dist = Math.hypot(to[0] - from[0], to[1] - from[1]);
  console.log('travel', label, 'arrive-t', tr.arrive - w.t, 'expected', Math.max(2, Math.ceil(dist / RESIDENT_UNITS_PER_TICK) + 1), 'hasPath', Array.isArray(tr.path));
}
for (const [label, sp] of [['A', A], ['D', D], ['C', C]]) {
  const w = sp.world; const r1 = survAct(sp, { kind: 'gather' }); const r2 = survAct(sp, { kind: 'gather' });
  console.log('act', label, r1.code ?? 'OK', r2.code ?? 'OK', 'budgetLeft', w.survival.p1BudgetLeft, 'tickUsed', w.survival.actClock?.p1?.tick?.usedMin);
}
