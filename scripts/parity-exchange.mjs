#!/usr/bin/env node
// 阶段 B：角色互换对拍（V7 §5）。
// 同一 seed、同一地点/资源/工具，同一意图分别走 玩家路径（survAct）与 居民路径（agent.execute），
// 逐项记录 合法性/成功/失败码/产出/材料/存续，并给出差异结论。只读世界、不联网、不写 data/。
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

function runScenario({ name, setup, player, resident }) {
  const spA = createSurvPlay(seed, GAME); setup(spA.world, 'p1');
  const bA = snap(spA.world, 'p1');
  const rA = player(spA) ?? null;
  const aA = snap(spA.world, 'p1');

  const spB = createSurvPlay(seed, GAME); setup(spB.world, RESIDENT);
  const bB = snap(spB.world, RESIDENT);
  const rB = resident(spB.world, RESIDENT) ?? null;
  const aB = snap(spB.world, RESIDENT);

  const delta = (a, b) => ({ wood: a.wood - b.wood, stone: a.stone - b.stone, store: a.store - b.store, viab: Number((a.viab - b.viab).toFixed(4)), plots: a.plots - b.plots, buildings: a.buildings - b.buildings });
  const dA = delta(aA, bA), dB = delta(aB, bB);
  const codeOf = (r) => {
    if (!r) return 'NO_ATTEMPT';
    if (r.ok) return 'OK';
    return r.code ?? r.error ?? (r.gate ? (r.gate.ok ? 'OK' : r.gate.code) : 'FAIL');
  };
  const sameCode = codeOf(rA) === codeOf(rB);
  const sameDelta = JSON.stringify(dA) === JSON.stringify(dB);
  // 居民侧根本没执行（validate 就失败/NULL）⇒ 这是样本无效，不是"规则不同"。
  const invalidSample = codeOf(rB) === 'NO_ATTEMPT' || codeOf(rA) === 'NO_ATTEMPT';
  return {
    scenario: name,
    player: { result: rA, code: codeOf(rA), delta: dA },
    resident: { result: rB, code: codeOf(rB), delta: dB },
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
    player: (sp) => survAct(sp, { kind: 'till', plot: 4 }),
    resident: (w, id) => { const bed = nextFarmBed(w); const gate = validate(w, id, { kind: 'till', plot: bed?.id }); return { gate, executed: Boolean(w.agents[id].execute(w, { kind: 'till', plot: bed?.id }, 'deliberation', w.t, true)) }; },
  },
  {
    name: '奠基（庇护所）',
    setup: (w, id) => { w.loc[id] = 'yard'; w.pinv[id] = { ...(w.pinv[id] ?? {}), wood: 8, stone: 4 }; },
    player: (sp) => survAct(sp, { kind: 'plan', type: 'shelter' }),
    resident: (w, id) => w.agents[id].execute(w, { kind: 'plan', type: 'shelter' }, 'deliberation', w.t, true),
  },
  {
    name: '进食（玩家营地 vs 居民日界）',
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
];

const scenariosOut = scenarios.map(runScenario);
console.log(JSON.stringify({ seed, scenarios: scenariosOut }, null, 2));
