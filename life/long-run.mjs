// P1-D：正式默认配置、无额外粮/无补生命、关闭 LLM 的长期自主生存实验。
// 统计口径：人口/阶段/出生/死亡原因、存续、行动分布、经济与生态、运行质量。
import { writeFileSync } from 'node:fs';
import { createSurvPlay, tickSurvPlay, dumpSurv } from './survplay.mjs';
import { LEGACY_EVENT_RULES, CURRENT_EVENT_RULES } from './rng.mjs';
import { isAlive, livingResidents } from './body.mjs';
import { bedsPerHome, maritalStatus, residentsAt, residentStage } from './households.mjs';
import { dayOf, DAY_TICKS } from './clock.mjs';
import { effectiveMods } from './production.mjs';

export const LONG_SEEDS = [7, 13, 29, 41, 53];
export const GAME_OPTIONS = Object.freeze({
  residentialDecisions: true, ecosystem: true, unifiedCooperation: true,
  independentWorld: true, wildFood: true, autonomousGoals: true, eventRulesVersion: CURRENT_EVENT_RULES,
});

function stages(w) {
  const out = { infant: 0, child: 0, adult: 0, elder: 0 };
  for (const a of livingResidents(w)) out[residentStage(w, a.id)] += 1;
  return out;
}
function deathCauses(s) {
  const out = {};
  for (const d of s.deaths ?? []) out[d.cause ?? 'unknown'] = (out[d.cause ?? 'unknown'] ?? 0) + 1;
  return out;
}
function actionCounters(w) {
  const out = {};
  for (const a of Object.values(w.agents)) {
    if (a.isPlayer || !a.counters) continue;
    for (const [k, v] of Object.entries(a.counters)) out[k] = (out[k] ?? 0) + v;
  }
  return out;
}
function familySnapshot(w) {
  const h = w.survival.households;
  const res = livingResidents(w);
  const rooms = Object.keys(h.deeds);
  return {
    married: res.filter(a => maritalStatus(h, a.id) === 'married' && isAlive(w.agents[h.spouses[a.id]])).length,
    widowed: res.filter(a => maritalStatus(h, a.id) === 'widowed').length,
    widowEvents: (h.marriages ?? []).filter(m => m.deceased?.length === 1).length,
    remarriages: (h.marriages ?? []).filter(m => m.remarried?.length > 0).length,
    homes: rooms.length,
    emptyHomes: rooms.filter(room => !residentsAt(w, room)).length,
    vacantForSale: rooms.filter(room => h.deeds[room].listed && !residentsAt(w, room)).length,
    bedsInUsableHomes: rooms.reduce((sum, room) => sum + (residentsAt(w, room) || h.deeds[room].listed ?
      Math.max(0, bedsPerHome(w) - residentsAt(w, room)) : 0), 0),
    projects: Object.fromEntries(Object.entries(h.projects).map(([room, p]) => [room, { ...p, ownerAlive: isAlive(w.agents[p.owner]) }])),
  };
}

function snapshot(w) {
  const s = w.survival, res = livingResidents(w), mods = effectiveMods(w);
  const v = res.map((a) => Number((a.viab?.v ?? 0).toFixed(4)));
  return {
    t: w.t, day: dayOf(w.t),
    population: res.length, stages: stages(w),
    births: s.births ?? 0, deaths: (s.deaths ?? []).length, deathCauses: deathCauses(s),
    playerAlive: !s.playerDead, playerViab: Number((w.agents.p1?.viab?.v ?? 0).toFixed(4)),
    ended: !!s.ended, failed: !!s.failed, won: !!s.won, endReason: s.endReason ?? null,
    viability: { avg: v.length ? Number((v.reduce((a, b) => a + b, 0) / v.length).toFixed(4)) : null, min: v.length ? Math.min(...v) : null },
    store: s.store, storeCap: mods.storeCap, inv: { ...s.inv },
    materials: Object.fromEntries(['wood', 'stone'].map(kind => [kind, (s.inv[kind] ?? 0) +
      (s.households.receipts[kind] ?? 0) + [...Object.values(w.pinv), ...Object.values(s.campContainers ?? {})]
        .reduce((sum, bag) => sum + (bag[kind] ?? 0), 0)])), water: Number((s.water ?? 0).toFixed(3)), soil: Number((s.soil ?? 0).toFixed(3)),
    buildings: (s.buildings ?? []).map((b) => ({ type: b.type, integrity: b.integrity })),
    sites: (s.sites ?? []).length, resStock: { ...(s.resStock ?? {}) },
    produce: { ...(s.produce ?? {}) }, livestock: { ...(s.livestock ?? {}) },
    eco: { chickens: (s.ecoPop?.chickens ?? []).length, orchards: (s.ecoPop?.orchards ?? []).length },
    family: familySnapshot(w),
    aiActions: { ...(s.aiActions ?? {}) }, counters: actionCounters(w), actionAudit: structuredClone(s.actionAudit ?? {}),
    coop: { completions: (s.coop?.completions ?? []).length, refusals: s.coop?.refusals ?? 0, replans: s.coop?.replans ?? 0, exits: s.coop?.exits ?? 0 },
    agentErrors: s.agentErrors ?? 0,
  };
}

export async function runLong(seed, days = 30, { eventRulesVersion = CURRENT_EVENT_RULES,
  familyExperiment, populationExperiment, recordTimeline = false, checkpoints = [days], observeProduction } = {}) {
  const ticks = days * DAY_TICKS;
  const sp = createSurvPlay(seed, { ...GAME_OPTIONS, eventRulesVersion });
  const w = sp.world;
  w.familyExperiment = familyExperiment;
  w.populationExperiment = populationExperiment;
  w.observeProduction = observeProduction;
  const birthChecks = [], timeline = [], milestones = {}, marriageEvents = [], homeCompletions = [];
  w.observeFamilyMarriage = event => marriageEvents.push(event);
  w.observeHomeComplete = event => homeCompletions.push(event);
  w.observeBirth = event => birthChecks.push(event);
  const prior = new Map();
  const checkDays = new Set(checkpoints);
  const initial = snapshot(sp.world);
  Object.assign(initial.family, { marriages: 0, completedHomes: 0 });
  let maxTickMs = 0, sumTickMs = 0, lastDay = dayOf(sp.world.t);
  const daily = [];
  const heap0 = process.memoryUsage().heapUsed;
  for (let i = 0; i < ticks; i += 1) {
    const t0 = Date.now();
    await tickSurvPlay(sp);
    const dt = Date.now() - t0;
    if (recordTimeline) for (const [id, person] of Object.entries(w.survival.households.residents)) {
      const h = w.survival.households;
      const state = { born: person.born, parents: person.parents, stage: person.stage,
        sex: w.sex[id], spouse: h.spouses[id] ?? null, status: maritalStatus(h, id),
        home: w.housing[id], decision: person.decision, death: w.agents[id].death };
      const signature = JSON.stringify(state);
      if (signature !== prior.get(id)) {
        timeline.push({ t: w.t, id, ...state });
        prior.set(id, signature);
      }
    }
    maxTickMs = Math.max(maxTickMs, dt); sumTickMs += dt;
    const d = dayOf(sp.world.t);
    if (d !== lastDay) {
      const h = sp.world.survival.history.at(-1) ?? {};
      daily.push({ day: d, store: h.store ?? null, need: h.need ?? null, shortfall: h.shortfall ?? null, disaster: h.disaster ?? null,
        endStore: w.survival.store, drought: h.drought ?? false, weather: w.weather,
        population: livingResidents(w).length, stages: stages(w),
        livestock: { ...w.survival.livestock }, resStock: { ...w.survival.resStock }, wildBerries: { ...w.survival.wildBerries } });
      if (checkDays.has(d)) {
        milestones[d] = snapshot(w);
        milestones[d].family.marriages = marriageEvents.length;
        milestones[d].family.completedHomes = homeCompletions.length;
      }
      lastDay = d;
    }
  }
  const final = snapshot(sp.world);
  final.family.marriages = marriageEvents.length;
  final.family.completedHomes = homeCompletions.length;
  const save = JSON.stringify(dumpSurv(sp)).length;
  const dailyNeed = daily.reduce((a, d) => a + (d.need ?? 0), 0);
  const shortfallDays = daily.filter((d) => (d.shortfall ?? 0) > 0).length;
  const disasterDays = daily.filter((d) => d.disaster).length;
  return {
    seed, days, ticks, eventRulesVersion: w.eventRulesVersion, familyExperiment, populationExperiment, initial, final, milestones,
    birthChecks, marriageEvents, homeCompletions, deaths: w.survival.deaths, marriages: w.survival.households.marriages ?? [],
    housingHistory: w.survival.households.housingHistory ?? [], ...(recordTimeline ? { timeline, dailyTimeline: daily } : {}),
    daily: { days: daily.length, needSum: dailyNeed, shortfallDays, disasterDays, last: daily.slice(-5) },
    runtime: {
      avgTickMs: Number((sumTickMs / ticks).toFixed(3)), maxTickMs,
      saveBytes: save, heapDeltaBytes: process.memoryUsage().heapUsed - heap0,
      goalStagnation: final.coop.replans + final.coop.refusals,
      skipped: final.counters.skipped ?? 0, rejected: final.counters.rejected ?? 0,
    },
  };
}

export function classify(r) {
  if (r.final.ended) return 'extinct';
  if (r.final.failed) return 'crisis';
  if (r.final.population <= 1) return 'boundary';
  return 'alive';
}

export async function runExperiment() {
  const runs = [];
  for (const eventRulesVersion of [LEGACY_EVENT_RULES, CURRENT_EVENT_RULES]) {
    for (const seed of LONG_SEEDS) {
      runs.push(await runLong(seed, 200, { eventRulesVersion, checkpoints: [30, 100, 200], recordTimeline: seed === 13 }));
    }
  }
  return { runs };
}

if (process.argv[1]?.endsWith('long-run.mjs')) {
  const out = await runExperiment();
  writeFileSync(process.argv[2] ?? 'docs/long-run-v4.json', JSON.stringify(out, null, 2));
  for (const r of out.runs) {
    console.log(JSON.stringify({ seed: r.seed, version: r.eventRulesVersion,
      population: [30, 100, 200].map(day => r.milestones[day].population), births: r.final.births,
      deaths: r.final.deathCauses, status: classify(r), errors: r.final.agentErrors }));
  }
}
