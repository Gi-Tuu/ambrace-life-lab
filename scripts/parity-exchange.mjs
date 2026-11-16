#!/usr/bin/env node
// 阶段 B：角色互换对拍（V7 §5）。
// 同一 seed、同一地点/资源/工具，同一意图分别走 玩家路径（survAct）与 居民路径（agent.execute），
// 逐项记录 合法性/成功/失败码/产出/材料/存续，并给出差异结论。只读世界、不联网、不写 data/。
//
// 夹具说明（读数必须连着这句才成立）：
//   · 进食：玩家侧 drives.energy=0.2 —— RES-02 之后不饿不给吃，这里测的是成功路径，不是"饥饿门不存在"。
//   · 开垦：夹具显式给 soil/water/clear/lastTilledDay=-1，两侧同一套条件、同一块田（见 samePlot）。
//   · 居民侧"进食"没有动作可跑，那是**声明**不是测量，所以 source=stub，不许算进对拍结论。
import { createSurvPlay, survAct } from '../life/survplay.mjs';
import { validate } from '../life/rules.mjs';
import { nextFarmBed } from '../life/farmland.mjs';

const GAME = { independentWorld: true, gameRules: true, residentialDecisions: true, unifiedCooperation: true, settlementLife: true, autonomousGoals: true, farmLife: true, regionalWork: true, ecosystem: true, wildFood: true };
const seed = Number(process.argv[2] ?? 7);
const RESIDENT = 'a1';

const woodDistrict = (w) => Object.keys(w.districts).find((k) => w.districts[k].resource === 'wood') ?? Object.keys(w.districts)[0];
const snap = (w, id) => ({
  wood: w.pinv?.[id]?.wood ?? 0,
  stone: w.pinv?.[id]?.stone ?? 0,
  store: w.survival.store,
  viab: Number((w.agents[id]?.viab?.v ?? 0).toFixed(4)),
  plots: Object.keys(w.survival.plots ?? {}).length,
  buildings: Object.keys(w.survival.buildings ?? {}).length,
});

function runScenario({ name, setup, player, resident, source = 'measured' }) {
  const chosen = {};
  const spA = createSurvPlay(seed, GAME); setup(spA.world, 'p1');
  const bA = snap(spA.world, 'p1');
  const rA = player(spA, chosen) ?? null;
  const aA = snap(spA.world, 'p1');

  const spB = createSurvPlay(seed, GAME); setup(spB.world, RESIDENT);
  const bB = snap(spB.world, RESIDENT);
  // execute 只有两条 null 出路（life/agent.mjs:478 validate 拒绝、:482 本刻动作账已花），
  // 但返回值都是 null ⇒ 光看返回值分不开"规则拒了"和"居民这一刻已经动过手"。后者正是 AUD-03 的差异本身，
  // 不能混进"样本无效"里静音掉，所以这里按 trace 增量回查一次。
  const traceLen = spB.world.agents[RESIDENT]?.trace?.length ?? 0;
  const rawB = resident(spB.world, RESIDENT, chosen) ?? null;
  const refused = (spB.world.agents[RESIDENT]?.trace ?? []).slice(traceLen).find((e) => e?.layer === 'refused');
  // ALREADY_ACTED 必须有账本证据（life/agent.mjs:481-483 写的就是这张账），不能当兜底桶——
  // 否则将来出现第三条 null 出路又会被静音掉，那正是我们上一轮批评 INVALID_SAMPLE 的毛病。
  const ledgerHit = spB.world.survival?.residentActionsAt?.[RESIDENT] === spB.world.t;
  const rB = rawB ?? (refused
    ? { ok: false, code: String(refused.code ?? 'FAIL'), note: `取自 refused trace（kind=${refused.kind}）` }
    : ledgerHit
      ? { ok: false, code: 'ALREADY_ACTED', note: 'validate 已过，但本刻居民动作账已花掉（unifiedCooperation）——这是居民侧的真实限制' }
      : { ok: false, code: 'NO_ATTEMPT', note: '意图没递到规则层（夹具问题），这才叫样本无效' });
  const aB = snap(spB.world, RESIDENT);

  const delta = (a, b) => ({ wood: a.wood - b.wood, stone: a.stone - b.stone, store: a.store - b.store, viab: Number((a.viab - b.viab).toFixed(4)), plots: a.plots - b.plots, buildings: a.buildings - b.buildings });
  const dA = delta(aA, bA), dB = delta(aB, bB);
  const codeOf = (r) => {
    if (!r) return 'NO_ATTEMPT';
    if (r.ok) return 'OK';
    if (r.code) return r.code;
    if (r.error) return r.error;
    if (r.gate) return r.gate.ok ? (r.executed === false ? (ledgerHit ? 'ALREADY_ACTED' : 'NO_ATTEMPT') : 'OK') : r.gate.code;
    return 'FAIL';
  };
  const cA = codeOf(rA), cB = codeOf(rB);
  const sameCode = cA === cB;
  const sameDelta = JSON.stringify(dA) === JSON.stringify(dB);
  const samePlot = chosen.playerPlot === undefined || chosen.playerPlot === chosen.residentPlot;
  // NO_ATTEMPT＝居民侧连意图都没递上去（夹具问题），这才叫样本无效；
  // ALREADY_ACTED / refused code 都是规则层的可见读数，必须照常参与 SAME/DIFF 判定。
  const invalidSample = (cA === 'NO_ATTEMPT' || cB === 'NO_ATTEMPT') || !samePlot;
  return {
    scenario: name,
    source,
    ...(samePlot ? {} : { note: `两侧不是同一块田：玩家 ${chosen.playerPlot} vs 居民 ${chosen.residentPlot}` }),
    player: { result: rA, code: cA, delta: dA },
    resident: { result: rB, code: cB, delta: dB },
    verdict: invalidSample ? 'INVALID_SAMPLE' : (sameCode && sameDelta ? 'SAME' : 'DIFF'),
  };
}

const scenarios = [
  {
    name: '采集木料',
    setup: (w, id) => { const loc = woodDistrict(w); w.loc[id] = loc; w.pinv[id] = { ...(w.pinv[id] ?? {}), axe: 1 }; if (id === 'p1') { const src = w.districts[loc].source; w.survival.playerPos = { x: src[0], z: src[1], t: w.t }; } },
    player: (sp) => { const w = sp.world; const src = w.districts[w.loc.p1].source; survAct(sp, { kind: 'player_sync', from: src }); return survAct(sp, { kind: 'gather', target: w.loc.p1, tool: 'axe', from: src }); },
    resident: (w, id) => w.agents[id].execute(w, { kind: 'gather', target: w.loc[id], tool: 'axe' }, 'deliberation', w.t, true),
  },
  {
    name: '开垦农田',
    setup: (w, id) => {
      w.loc[id] = 'garden';
      w.pinv[id] = { ...(w.pinv[id] ?? {}), wood: 2 };
      const s0 = w.survival;
      s0.soil = 1; s0.water = 1; s0.drought = false; s0.disasterToday = false; s0.lastTilledDay = -1; w.weather = 'clear';
    },
    // 两边都问引擎要同一块田，不许一边写死 id、一边现算（写死 4 恰好等于 nextFarmBed 是巧合，不是约束）。
    player: (sp, chosen) => { const bed = nextFarmBed(sp.world); chosen.playerPlot = bed?.id; return survAct(sp, { kind: 'till', plot: bed?.id }); },
    resident: (w, id, chosen) => { const bed = nextFarmBed(w); chosen.residentPlot = bed?.id; const gate = validate(w, id, { kind: 'till', plot: bed?.id }); return { gate, executed: Boolean(w.agents[id].execute(w, { kind: 'till', plot: bed?.id }, 'deliberation', w.t, true)) }; },
  },
  {
    name: '奠基（庇护所）',
    setup: (w, id) => { w.loc[id] = 'yard'; w.pinv[id] = { ...(w.pinv[id] ?? {}), wood: 8, stone: 4 }; },
    player: (sp) => survAct(sp, { kind: 'plan', type: 'shelter' }),
    resident: (w, id) => w.agents[id].execute(w, { kind: 'plan', type: 'shelter' }, 'deliberation', w.t, true),
  },
  {
    name: '进食（玩家营地 vs 居民日界）',
    source: 'stub', // 居民侧没有 eat 动作可跑，这里是声明的入口缺失，不是测量结果
    setup: (w, id) => {
      if (id === 'p1') { w.loc.p1 = 'home'; w.campPlayerRoom = 'home'; w.pinv.p1 = { ...(w.pinv.p1 ?? {}), tray: 1 }; w.survival.campContainers = { 'home:meal': { crop: 4 } }; w.agents.p1.viab.v = 0.3; w.agents.p1.drives.v.energy = 0.2; }
      else { w.agents[id].viab.v = 0.3; }
    },
    player: (sp) => survAct(sp, { kind: 'camp_eat', type: 'crop' }),
    resident: () => ({ ok: false, code: 'NO_EAT_ENTRY', note: '生存模式居民没有 eat 动作；只有日界 regen' }),
  },
  {
    name: '失败动作（无工地 build）',
    setup: (w, id) => { w.loc[id] = 'hall'; },
    player: (sp) => survAct(sp, { kind: 'build' }),
    resident: (w, id) => w.agents[id].execute(w, { kind: 'build' }, 'deliberation', w.t, true),
  },
  {
    name: '同刻第二次动作（两种账）',
    // AUD-03 的正面样本：同一 actor 同一刻连发两次同一个合法动作。
    // 居民撞的是"每刻一次"的动作账（unifiedCooperation），玩家撞的是 100 点时间预算（gather=75，两次=150）。
    // 两边都不许改预算夹具——这里要量的就是各自的账长什么样。
    setup: (w, id) => { const loc = woodDistrict(w); w.loc[id] = loc; w.pinv[id] = { ...(w.pinv[id] ?? {}), axe: 1 }; if (id === 'p1') { const src = w.districts[loc].source; w.survival.playerPos = { x: src[0], z: src[1], t: w.t }; } },
    player: (sp) => {
      const w = sp.world; const src = w.districts[w.loc.p1].source;
      survAct(sp, { kind: 'player_sync', from: src });
      survAct(sp, { kind: 'gather', target: w.loc.p1, tool: 'axe', from: src });
      return survAct(sp, { kind: 'gather', target: w.loc.p1, tool: 'axe', from: src });
    },
    resident: (w, id) => {
      w.agents[id].execute(w, { kind: 'gather', target: w.loc[id], tool: 'axe' }, 'deliberation', w.t, true);
      return w.agents[id].execute(w, { kind: 'gather', target: w.loc[id], tool: 'axe' }, 'deliberation', w.t, true);
    },
  },
];

const scenariosOut = scenarios.map(runScenario);
console.log(JSON.stringify({ seed, scenarios: scenariosOut }, null, 2));
