#!/usr/bin/env node
// V7.1 P2：四个真实行为案例（帮助/死亡/自主建设/计划失败），记录种子与事件。
// 只读世界、零联网、不写 data/。
import { CURRENT_EVENT_RULES } from '../life/rng.mjs';
import { createSurvPlay, tickSurvPlay } from '../life/survplay.mjs';
import { residentStage } from '../life/households.mjs';

const GAME = { eventRulesVersion: CURRENT_EVENT_RULES, independentWorld: true, gameRules: true, residentialDecisions: true, unifiedCooperation: true, settlementLife: true, autonomousGoals: true, farmLife: true, regionalWork: true, ecosystem: true, wildFood: true, playerRation: true };
const SEEDS = [7, 13, 29];
const out = [];

const trustOf = (w, a, b) => w.agents[a]?.relations?.get?.(b)?.trust ?? null;

for (const seed of SEEDS) {
  const sp = createSurvPlay(seed, GAME);
  const w = sp.world;
  const caseA = [];
  const caseC = [];
  let coopSeen = 0;
  let buildingsBefore = Object.keys(w.survival.buildings ?? {}).length;
  const deathsBefore = [];

  for (let d = 0; d < 60 && !w.survival.ended; d += 1) {
    for (let i = 0; i < 24; i += 1) await tickSurvPlay(sp, { now: Date.now() });
    // A：合作完工时记录参与者信任变化（帮助的长期后果）
    const completions = w.survival.coop?.completions ?? [];
    if (completions.length > coopSeen) {
      for (const c of completions.slice(coopSeen)) {
        const people = c.participants ?? [];
        const links = [];
        for (const a of people) for (const b of people) if (a < b) links.push({ pair: a + '-' + b, trust: trustOf(w, a, b) });
        caseA.push({ day: d + 1, task: c.type ?? '?', workers: c.workers ?? people.length, links });
      }
      coopSeen = completions.length;
    }
    // C：建筑完工事件
    const bCount = Object.keys(w.survival.buildings ?? {}).length;
    if (bCount > buildingsBefore) {
      const entry = (w.survival.history ?? []).slice(-1)[0];
      caseC.push({ day: d + 1, buildings: bCount, lastHistory: entry ?? null });
      buildingsBefore = bCount;
    }
    // B：家庭成员死亡事件
    for (const e of (w.survival.deaths ?? [])) {
      if (deathsBefore.includes(e.t)) continue;
      deathsBefore.push(e.t);
    }
  }

  // B：构造一次配偶死亡（若已有婚姻），观察 3 天后的家庭状态
  const h = w.survival.households ?? {};
  const pair = Object.entries(h.spouses ?? {}).filter(([a, b]) => a < b)[0];
  let caseB = null;
  if (pair) {
    const [a, b] = pair;
    w.agents[b].viab.v = 0;
    for (let i = 0; i < 72; i += 1) await tickSurvPlay(sp, { now: Date.now() });
    caseB = {
      pair: [a, b],
      widowSpouse: h.spouses[a] ?? null,
      widowed: !!h.widowed?.[a],
      bDead: !!w.agents[b].dead,
      cause: w.agents[b].death?.cause ?? null,
      aStage: residentStage(w, a),
      housingA: w.housing[a] ?? null,
      deeds: h.deeds?.[w.housing[a]]?.owner ?? null,
    };
  }

  // D：资源为零且断供——居民不能凭空开工；记录被拒原因与行动转向
  const spD = createSurvPlay(seed, GAME);
  const wD = spD.world;
  const refused0 = { ...(wD.survival.actionLedger?.resident?.refused ?? {}) };
  const sites0 = (wD.survival.sites ?? []).length;
  const buildings0 = Object.keys(wD.survival.buildings ?? {}).length;
  wD.survival.store = 0;
  wD.survival.inv = { ...(wD.survival.inv ?? {}), wood: 0, stone: 0 };
  wD.survival.resStock = Object.fromEntries(Object.keys(wD.districts ?? {}).map((k) => [k, 0]));
  if (wD.survival.campTrees) for (const k of Object.keys(wD.survival.campTrees)) wD.survival.campTrees[k] = wD.t + 9999;
  for (let i = 0; i < 72; i += 1) {
    for (const id of Object.keys(wD.pinv ?? {})) wD.pinv[id] = { wood: 0, stone: 0 };
    wD.survival.inv.wood = 0; wD.survival.inv.stone = 0;
    await tickSurvPlay(spD, { now: Date.now() });
  }
  const refused1 = wD.survival.actionLedger?.resident?.refused ?? {};
  const refusedDelta = {};
  for (const k of new Set([...Object.keys(refused0), ...Object.keys(refused1)])) {
    const d = (refused1[k] ?? 0) - (refused0[k] ?? 0);
    if (d > 0) refusedDelta[k] = d;
  }
  const caseD = {
    sitesBefore: sites0,
    sitesAfter: (wD.survival.sites ?? []).length,
    buildingsBefore: buildings0,
    buildingsAfter: Object.keys(wD.survival.buildings ?? {}).length,
    refused: refusedDelta,
    store: wD.survival.store,
  };
  out.push({ seed, days: Math.floor(w.t / 24), ended: !!w.survival.ended, caseA: caseA.slice(0, 5), caseB, caseC: caseC.slice(0, 5), caseD, buildings: Object.keys(w.survival.buildings ?? {}).length, living: Object.values(w.agents).filter((a) => !a.dead && !a.isPlayer).length });
}

console.log(JSON.stringify(out, null, 2));
