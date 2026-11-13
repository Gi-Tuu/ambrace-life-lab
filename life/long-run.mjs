// P1-D：正式默认配置、无额外粮/无补生命、关闭 LLM 的长期自主生存实验。
// 统计口径：人口/阶段/出生/死亡原因、存续、行动分布、经济与生态、运行质量。
import { writeFileSync } from 'node:fs';
import { createSurvPlay, tickSurvPlay, dumpSurv } from './survplay.mjs';
import { livingResidents } from './body.mjs';
import { residentStage, ageDays } from './households.mjs';
import { dayOf, DAY_TICKS } from './clock.mjs';
import { effectiveMods } from './production.mjs';

export const LONG_SEEDS = [7, 13, 29, 41, 53];
export const GAME_OPTIONS = Object.freeze({
  residentialDecisions: true, ecosystem: true, unifiedCooperation: true,
  independentWorld: true, wildFood: true, autonomousGoals: true,
});

function stages(w) {
  const out = { child: 0, adult: 0, elder: 0 };
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
    store: s.store, storeCap: mods.storeCap, inv: { ...s.inv }, water: Number((s.water ?? 0).toFixed(3)), soil: Number((s.soil ?? 0).toFixed(3)),
    buildings: (s.buildings ?? []).map((b) => ({ type: b.type, integrity: b.integrity })),
    sites: (s.sites ?? []).length, resStock: { ...(s.resStock ?? {}) },
    produce: { ...(s.produce ?? {}) }, livestock: { ...(s.livestock ?? {}) },
    eco: { chickens: (s.ecoPop?.chickens ?? []).length, orchards: (s.ecoPop?.orchards ?? []).length },
    aiActions: { ...(s.aiActions ?? {}) }, counters: actionCounters(w),
    coop: { completions: (s.coop?.completions ?? []).length, refusals: s.coop?.refusals ?? 0, replans: s.coop?.replans ?? 0, exits: s.coop?.exits ?? 0 },
    agentErrors: s.agentErrors ?? 0,
  };
}

export async function runLong(seed, days = 30) {
  const ticks = days * DAY_TICKS;
  const sp = createSurvPlay(seed, GAME_OPTIONS);
  const initial = snapshot(sp.world);
  let maxTickMs = 0, sumTickMs = 0, lastDay = dayOf(sp.world.t);
  const daily = [];
  const heap0 = process.memoryUsage().heapUsed;
  for (let i = 0; i < ticks; i += 1) {
    const t0 = Date.now();
    await tickSurvPlay(sp);
    const dt = Date.now() - t0;
    maxTickMs = Math.max(maxTickMs, dt); sumTickMs += dt;
    const d = dayOf(sp.world.t);
    if (d !== lastDay) {
      const h = sp.world.survival.history.at(-1) ?? {};
      daily.push({ day: d, store: h.store ?? null, need: h.need ?? null, shortfall: h.shortfall ?? null, disaster: h.disaster ?? null });
      lastDay = d;
    }
  }
  const final = snapshot(sp.world);
  const save = JSON.stringify(dumpSurv(sp)).length;
  const dailyNeed = daily.reduce((a, d) => a + (d.need ?? 0), 0);
  const shortfallDays = daily.filter((d) => (d.shortfall ?? 0) > 0).length;
  const disasterDays = daily.filter((d) => d.disaster).length;
  return {
    seed, days, ticks, initial, final,
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
  const runs30 = [];
  for (const seed of LONG_SEEDS) runs30.push(await runLong(seed, 30));
  // 代表性：全部 5 个种子跑 100 日；seed 13 继续到 200 日以取得自然灭绝样本。
  const runs100 = [];
  for (const seed of LONG_SEEDS) runs100.push(await runLong(seed, 100));
  const runs200 = [await runLong(13, 200)];
  return { generatedAt: new Date().toISOString(), runs30, runs100, runs200, classify: runs30.map((r) => ({ seed: r.seed, status: classify(r) })) };
}

if (process.argv[1]?.endsWith('long-run.mjs')) {
  const out = await runExperiment();
  writeFileSync('docs/long-run-2026-11-13.json', JSON.stringify(out, null, 2));
  console.log(JSON.stringify({
    classify: out.classify,
    thirty: out.runs30.map((r) => ({ seed: r.seed, pop: r.final.population, births: r.final.births, deaths: r.final.deaths, store: r.final.store, status: classify(r), errors: r.final.agentErrors })),
    hundred: out.runs100.map((r) => ({ seed: r.seed, pop: r.final.population, births: r.final.births, deaths: r.final.deaths, store: r.final.store, status: classify(r), errors: r.final.agentErrors })),
    twoHundred: out.runs200.map((r) => ({ seed: r.seed, pop: r.final.population, births: r.final.births, deaths: r.final.deaths, store: r.final.store, status: classify(r), errors: r.final.agentErrors })),
  }, null, 2));
}
